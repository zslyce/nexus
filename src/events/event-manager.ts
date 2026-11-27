import type { EventBus, Logger, NexusEvent, NexusEventDraft, Store } from "../contracts/index.ts";
import { nexusError } from "../utils/errors.ts";

export const DEFAULT_QUEUE_LIMIT = 256;
export const DEFAULT_PAGE_SIZE = 200;

interface ReadQuery {
  taskId?: string;
  afterSeq?: number;
  limit?: number;
}

export interface EventManagerOptions {
  store: Store;
  /** Events a live subscriber may hold. Past this limit it re-reads history from the store instead. */
  queueLimit?: number;
  /** Events read per history page. */
  pageSize?: number;
  /**
   * Runs the deliveries after the current synchronous work, so that any transaction that published an
   * event has committed or rolled back first. Default: microtask. Tests inject a manual scheduler.
   */
  schedule?: (task: () => void) => void;
  logger?: Logger;
}

export interface EventManager extends EventBus {
  /** Live subscriptions attached right now (diagnostics and tests). */
  readonly subscriberCount: number;
}

/**
 * `EventBus` over the store. Persist, then publish: `publish` writes through `Store.appendEvent` and
 * queues the stored event; delivery runs later and skips events whose transaction rolled back.
 * Subscribers replay history from the store, then follow the live queue. The store is the source of
 * truth: a full queue is never a gap, it only sends the subscriber back to the store.
 */
export function createEventManager(options: EventManagerOptions): EventManager {
  return new Manager(options);
}

class Manager implements EventManager {
  private readonly store: Store;
  private readonly queueLimit: number;
  private readonly pageSize: number;
  private readonly schedule: (task: () => void) => void;
  private readonly logger: Logger | undefined;
  private readonly registry = new Set<Subscription>();
  private pending: NexusEvent[] = [];
  private flushScheduled = false;

  constructor(options: EventManagerOptions) {
    this.store = options.store;
    this.queueLimit = positiveInteger(options.queueLimit ?? DEFAULT_QUEUE_LIMIT, "queueLimit");
    this.pageSize = positiveInteger(options.pageSize ?? DEFAULT_PAGE_SIZE, "pageSize");
    this.schedule = options.schedule ?? ((task) => queueMicrotask(task));
    this.logger = options.logger;
  }

  get subscriberCount(): number {
    return this.registry.size;
  }

  /** Returns undefined, and delivers nothing, when `event_id` was already stored. */
  publish(draft: NexusEventDraft): NexusEvent | undefined {
    const stored = this.store.appendEvent(draft);
    if (stored !== undefined) this.enqueue(stored);
    return stored;
  }

  /** All or nothing: one invalid draft rolls back the whole batch and nothing is delivered. */
  publishAll(drafts: NexusEventDraft[]): NexusEvent[] {
    return this.store.transaction(() => {
      const stored: NexusEvent[] = [];
      for (const draft of drafts) {
        const event = this.publish(draft);
        if (event !== undefined) stored.push(event);
      }
      return stored;
    });
  }

  subscribe(query: { afterSeq?: number; taskId?: string }, signal: AbortSignal): AsyncIterable<NexusEvent> {
    const afterSeq = query.afterSeq ?? 0;
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) {
      throw nexusError("VALIDATION", "afterSeq must be an integer >= 0");
    }
    const subscription = new Subscription(
      { store: this.store, pageSize: this.pageSize, queueLimit: this.queueLimit, registry: this.registry },
      query.taskId,
      afterSeq,
      signal,
    );
    // One subscription has one cursor, so it can be iterated once. A second iterator would share the cursor
    // and split the events between two consumers; that misuse is rejected instead.
    let claimed = false;
    return {
      [Symbol.asyncIterator]: () => {
        if (claimed) {
          throw nexusError("VALIDATION", "a subscription can be iterated only once; call subscribe again");
        }
        claimed = true;
        return subscription;
      },
    };
  }

  private enqueue(event: NexusEvent): void {
    this.pending.push(event);
    if (!this.flushScheduled) {
      this.flushScheduled = true;
      this.schedule(() => this.flush());
    }
  }

  private flush(): void {
    this.flushScheduled = false;
    const batch = this.pending;
    this.pending = [];
    try {
      for (const event of batch) {
        if (!this.isCommitted(event)) continue;
        for (const subscription of [...this.registry]) subscription.offer(event);
      }
    } catch (error) {
      // Some deliveries may have been skipped: every live subscriber re-reads the store instead.
      this.logger?.error("event delivery failed; subscribers will re-read the store", { error });
      for (const subscription of [...this.registry]) subscription.resync();
    }
  }

  /** True when the stored row with this `seq` is the event itself (not rolled back). */
  private isCommitted(event: NexusEvent): boolean {
    const [next] = this.store.listEvents({ afterSeq: Math.max(0, event.seq - 1), limit: 1 });
    return next?.event_id === event.event_id;
  }
}

interface SubscriptionDeps {
  store: Store;
  pageSize: number;
  queueLimit: number;
  registry: Set<Subscription>;
}

const DONE: IteratorReturnResult<undefined> = { done: true, value: undefined };

/**
 * One consumer. Registration and the first history read happen on the first `next()`, so nothing
 * committed before that point can be missed. `frontier` is the last seq read from the store; a live
 * event at or below it is a duplicate and is skipped.
 *
 * Concurrent `next()` calls are allowed and are served strictly in call order: each one waits for the
 * previous to settle, so there is never more than one waiter and no wake-up can be overwritten.
 */
class Subscription implements AsyncIterator<NexusEvent> {
  private readonly deps: SubscriptionDeps;
  private readonly taskId: string | undefined;
  private readonly signal: AbortSignal;
  private readonly buffer: NexusEvent[] = [];
  private readonly live: NexusEvent[] = [];
  private started = false;
  private closed = false;
  private needsReplay = true;
  private overflowed = false;
  /** Last seq read from the store. */
  private frontier: number;
  /** Last seq handed to the consumer. */
  private delivered: number;
  private wake: (() => void) | undefined;
  private readonly onAbort = (): void => this.close();
  /** Number of `next()` calls not yet settled. */
  private inFlight = 0;
  /** Settles after the most recent `next()`; the next call waits on it while `inFlight > 0`. */
  private tail: Promise<void> = Promise.resolve();

  constructor(deps: SubscriptionDeps, taskId: string | undefined, afterSeq: number, signal: AbortSignal) {
    this.deps = deps;
    this.taskId = taskId;
    this.signal = signal;
    this.frontier = afterSeq;
    this.delivered = afterSeq;
  }

  /** Called by the manager for each committed event, in seq order. */
  offer(event: NexusEvent): void {
    if (this.closed || this.overflowed) return;
    if (this.taskId !== undefined && event.task_id !== this.taskId) return;
    if (this.live.length >= this.deps.queueLimit) {
      this.resync();
      return;
    }
    this.live.push(event);
    this.notify();
  }

  /** Drops the live queue; the next read replays from the store, so nothing is lost. */
  resync(): void {
    if (this.closed) return;
    this.overflowed = true;
    this.live.length = 0;
    this.notify();
  }

  next(): Promise<IteratorResult<NexusEvent>> {
    // Run synchronously when idle, so that registration happens inside the call, as before.
    const run = this.inFlight === 0 ? this.pull() : this.tail.then(() => this.pull());
    this.inFlight += 1;
    this.tail = run.then(
      () => {
        this.inFlight -= 1;
      },
      () => {
        this.inFlight -= 1;
      },
    );
    return run;
  }

  async return(): Promise<IteratorResult<NexusEvent>> {
    this.close();
    return DONE;
  }

  /** One `next()`: runs only when no other call is waiting ahead of it. */
  private async pull(): Promise<IteratorResult<NexusEvent>> {
    if (!this.started) {
      if (this.signal.aborted) {
        this.closed = true;
        return DONE;
      }
      this.start();
    }
    for (;;) {
      if (this.closed) return DONE;
      if (this.signal.aborted) {
        this.close();
        return DONE;
      }
      const event = this.step();
      if (event !== undefined) return { done: false, value: event };
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.deps.registry.delete(this);
    this.signal.removeEventListener("abort", this.onAbort);
    this.buffer.length = 0;
    this.live.length = 0;
    this.notify();
  }

  private start(): void {
    this.started = true;
    this.deps.registry.add(this);
    this.signal.addEventListener("abort", this.onAbort, { once: true });
  }

  /** Returns the next event that is ready, or undefined when the consumer must wait. Synchronous. */
  private step(): NexusEvent | undefined {
    for (;;) {
      if (this.overflowed) this.reset();
      const buffered = this.buffer.shift();
      if (buffered !== undefined) {
        this.delivered = buffered.seq;
        return buffered;
      }
      if (this.needsReplay) {
        this.readPage();
        continue;
      }
      const live = this.live.shift();
      if (live === undefined) return undefined;
      if (live.seq > this.frontier) {
        this.frontier = live.seq;
        this.delivered = live.seq;
        return live;
      }
    }
  }

  private readPage(): void {
    const query: ReadQuery = { afterSeq: this.frontier, limit: this.deps.pageSize };
    if (this.taskId !== undefined) query.taskId = this.taskId;
    const page = this.deps.store.listEvents(query);
    for (const event of page) this.buffer.push(event);
    const last = page.at(-1);
    if (last !== undefined) this.frontier = last.seq;
    if (page.length < this.deps.pageSize) this.needsReplay = false;
  }

  private reset(): void {
    this.overflowed = false;
    this.live.length = 0;
    this.buffer.length = 0;
    this.frontier = this.delivered;
    this.needsReplay = true;
  }

  private notify(): void {
    const wake = this.wake;
    this.wake = undefined;
    wake?.();
  }
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw nexusError("VALIDATION", `${name} must be an integer >= 1`);
  }
  return value;
}
