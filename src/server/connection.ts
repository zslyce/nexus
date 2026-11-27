/**
 * Endpoint of the registered OpenCode service and the client built from it.
 * Discovery never starts a service (that is `ServerManager`). After a transport failure the cached
 * endpoint is dropped, so the next call rediscovers it: the port changes when the service restarts.
 */
import { OpenCode, type OpenCodeClient } from "@opencode/client";
import { discover, headers, type Endpoint } from "@opencode/client/service";
import type { Logger } from "../contracts/common.ts";
import { unavailable } from "./errors.ts";

/** Reads the registration file and probes it. Resolves `undefined` when nothing healthy is registered. */
export type Discover = (file: string | undefined) => Promise<Endpoint | undefined>;

export interface ConnectionOptions {
  /** Registration file; `undefined` means OpenCode's default (XDG state directory). */
  readonly registrationFile: string | undefined;
  readonly logger: Logger;
  readonly discover?: Discover;
}

const defaultDiscover: Discover = (file) => discover(file === undefined ? {} : { file });

export class Connection {
  readonly #registrationFile: string | undefined;
  readonly #logger: Logger;
  readonly #discover: Discover;
  #current: { readonly endpoint: Endpoint; readonly client: OpenCodeClient } | undefined;
  #discovering: Promise<OpenCodeClient> | undefined;

  constructor(options: ConnectionOptions) {
    this.#registrationFile = options.registrationFile;
    this.#logger = options.logger;
    this.#discover = options.discover ?? defaultDiscover;
  }

  /** URL of the cached endpoint, if any. */
  get url(): string | undefined {
    return this.#current?.endpoint.url;
  }

  /** Looks for a registered, healthy service without caching it and without starting one. */
  find(): Promise<Endpoint | undefined> {
    return this.#discover(this.#registrationFile);
  }

  /** Makes `endpoint` the current one and returns its client. */
  adopt(endpoint: Endpoint): OpenCodeClient {
    // The auth header carries the service password: it is never logged or stored outside this object.
    const client = OpenCode.make({ baseUrl: endpoint.url, headers: headers(endpoint) });
    this.#current = { endpoint, client };
    return client;
  }

  /**
   * The client for the current endpoint; discovers one when none is cached. Concurrent callers share one
   * discovery, so a burst of calls after a loss probes the registration once.
   */
  client(): Promise<OpenCodeClient> {
    if (this.#current !== undefined) return Promise.resolve(this.#current.client);
    this.#discovering ??= this.#discoverClient().finally(() => {
      this.#discovering = undefined;
    });
    return this.#discovering;
  }

  async #discoverClient(): Promise<OpenCodeClient> {
    const endpoint = await this.find();
    if (endpoint === undefined) {
      throw unavailable("No OpenCode service is registered; connect() with autoStart or start `opencode serve --service`");
    }
    return this.adopt(endpoint);
  }

  /** Drops the cached endpoint so that the next call rediscovers it. */
  invalidate(): void {
    if (this.#current === undefined) return;
    this.#logger.warn("OpenCode endpoint lost; it will be rediscovered on the next call", { url: this.#current.endpoint.url });
    this.#current = undefined;
  }
}
