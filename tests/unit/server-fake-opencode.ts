/**
 * Fake OpenCode HTTP service for the gateway unit tests. Not a test file: imported by `server-*.test.ts`.
 * Requests are recorded so that tests can check them against the OpenAPI fixture (openapi-2.4.2.json).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Logger } from "../../src/contracts/common.ts";

export interface FakeRequest {
  readonly method: string;
  readonly path: string;
  readonly query: URLSearchParams;
  readonly body: unknown;
}

export interface FakeResponse {
  readonly method: string;
  readonly path: string;
  readonly status: number;
}

export interface RouteContext {
  readonly request: FakeRequest;
  /** Writes a JSON body with `status`. */
  json(status: number, body: unknown): void;
  /** Writes an empty response with `status` (for 204). */
  empty(status: number): void;
  /** Writes a plain-text body with `status` (not JSON: what a foreign server or a proxy may answer). */
  text(status: number, body: string): void;
  /** Opens an SSE response (headers flushed). The route must end it or the client keeps the socket open. */
  sse(): ServerResponse;
  readonly res: ServerResponse;
}

export type Route = (context: RouteContext) => void;

export interface FakeOpenCode {
  readonly url: string;
  readonly requests: FakeRequest[];
  readonly responses: FakeResponse[];
  /** Requests that matched no route (answered with 599: always a test bug). */
  readonly unrouted: FakeRequest[];
  /** Replaces the handler for `"METHOD /path"`. */
  route(key: string, handler: Route): void;
  /** Number of SSE responses still open (the client has not closed them). */
  openStreams(): number;
  /** Resolves once every SSE response has been closed by the peer or the route. */
  whenStreamsClosed(): Promise<void>;
  close(): Promise<void>;
}

export const FAKE_VERSION = "2.4.2";

export async function startFakeOpenCode(): Promise<FakeOpenCode> {
  const requests: FakeRequest[] = [];
  const responses: FakeResponse[] = [];
  const unrouted: FakeRequest[] = [];
  const routes = new Map<string, Route>();
  const streams = new Set<ServerResponse>();
  let streamWaiters: Array<() => void> = [];
  let closed = false;

  const notifyStreams = (): void => {
    if (streams.size > 0) return;
    for (const waiter of streamWaiters) waiter();
    streamWaiters = [];
  };

  const server: Server = createServer((req, res) => {
    void handle(req, res);
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://fake.local");
    const request: FakeRequest = {
      method: req.method ?? "GET",
      path: url.pathname,
      query: url.searchParams,
      body: await readJson(req),
    };
    requests.push(request);
    const key = `${request.method} ${request.path}`;
    const route = routes.get(key) ?? defaultRoute(request);
    if (route === undefined) {
      unrouted.push(request);
      res.writeHead(599, { "content-type": "text/plain" });
      res.end("unrouted");
      responses.push({ method: request.method, path: request.path, status: 599 });
      return;
    }
    const context: RouteContext = {
      request,
      res,
      json(status, body) {
        responses.push({ method: request.method, path: request.path, status });
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      },
      text(status, body) {
        responses.push({ method: request.method, path: request.path, status });
        res.writeHead(status, { "content-type": "text/plain" });
        res.end(body);
      },
      empty(status) {
        responses.push({ method: request.method, path: request.path, status });
        res.writeHead(status);
        res.end();
      },
      sse() {
        responses.push({ method: request.method, path: request.path, status: 200 });
        streams.add(res);
        res.on("close", () => {
          streams.delete(res);
          notifyStreams();
        });
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        res.flushHeaders();
        return res;
      },
    };
    route(context);
  }

  function defaultRoute(request: FakeRequest): Route | undefined {
    if (request.method === "GET" && request.path === "/api/info") {
      return (context) => context.json(200, { version: FAKE_VERSION, pid: process.pid, urls: [url], paths: { tmp: "/tmp" } });
    }
    return undefined;
  }

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}`;

  return {
    url,
    requests,
    responses,
    unrouted,
    route(key, handler) {
      routes.set(key, handler);
    },
    openStreams: () => streams.size,
    whenStreamsClosed() {
      if (streams.size === 0) return Promise.resolve();
      // Failure guard only: a socket that stays open fails the test instead of hanging the run.
      return new Promise<void>((resolve, reject) => {
        const guard = setTimeout(() => reject(new Error("an SSE socket stayed open after the client closed it")), 5_000);
        streamWaiters.push(() => {
          clearTimeout(guard);
          resolve();
        });
      });
    },
    close() {
      if (closed) return Promise.resolve();
      closed = true;
      for (const res of streams) res.destroy();
      server.closeAllConnections();
      return new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  };
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  if (text === "") return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/** Writes a registration file (same shape as OpenCode's `service.json`) into `dir` and returns its path. */
export function writeRegistration(dir: string, service: { url: string; pid: number; version?: string }): string {
  const file = join(dir, "state", "opencode", "service.json");
  mkdirSync(join(dir, "state", "opencode"), { recursive: true });
  writeFileSync(file, JSON.stringify({ id: "fake-service", version: service.version ?? FAKE_VERSION, url: service.url, pid: service.pid }));
  return file;
}

export function fixture<T>(name: string): T {
  const url = new URL(`../../tests/fixtures/opencode/${name}`, import.meta.url);
  return JSON.parse(readFileSync(url, "utf8")) as T;
}

/** Logger that keeps its records, so tests can assert on warnings without console output. */
export function recordingLogger(): Logger & { readonly records: Array<{ level: string; message: string; data?: Record<string, unknown> }> } {
  const records: Array<{ level: string; message: string; data?: Record<string, unknown> }> = [];
  const add = (level: string) => (message: string, data?: Record<string, unknown>) => {
    records.push(data === undefined ? { level, message } : { level, message, data });
  };
  return {
    records,
    debug: add("debug"),
    info: add("info"),
    warn: add("warn"),
    error: add("error"),
  };
}

export interface FakeTimer {
  readonly callback: () => void;
  status: "pending" | "cleared" | "fired";
}

export interface TestScheduler {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  readonly timers: FakeTimer[];
  pending(): FakeTimer[];
  cleared(): number;
  /** Fires the most recently armed timer that is still pending. */
  fireLast(): void;
}

/** Test double for the watchdog and deadline timers: nothing waits; the test decides when a timer fires. */
export function fakeScheduler(): TestScheduler {
  const timers: FakeTimer[] = [];
  return {
    timers,
    setTimeout(callback) {
      const timer: FakeTimer = { callback, status: "pending" };
      timers.push(timer);
      return timer;
    },
    clearTimeout(handle) {
      const timer = handle as FakeTimer;
      if (timer.status === "pending") timer.status = "cleared";
    },
    pending: () => timers.filter((timer) => timer.status === "pending"),
    cleared: () => timers.filter((timer) => timer.status === "cleared").length,
    fireLast() {
      const last = timers.filter((timer) => timer.status === "pending").at(-1);
      if (last === undefined) throw new Error("no pending timer to fire");
      last.status = "fired";
      last.callback();
    },
  };
}
