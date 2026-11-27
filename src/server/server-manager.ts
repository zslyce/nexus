/**
 * Starts an OpenCode service when none is registered (`connect()` with `autoStart` only).
 * Never passes a version requirement, because `ensure()` would replace a service of another version.
 */
import { readFile } from "node:fs/promises";
import { ensure, fallback, type Endpoint, type EnsureOptions } from "@opencode/client/service";
import type { Logger } from "../contracts/common.ts";
import { unavailable } from "./errors.ts";

/**
 * Command that starts the service (R7). Two findings on Windows, verified on this machine:
 * - `opencode` is an npm `.cmd` shim that `spawn()` cannot run without a shell, so it goes through `cmd.exe`.
 * - Without `--port`, the service binds a fixed default port (28894 here): when a service already holds it,
 *   the new one exits with code 1. `--port 0` lets the OS choose; the registration file records the real URL.
 */
export function defaultServiceCommand(platform: NodeJS.Platform, comspec: string | undefined): string[] {
  const serve = ["opencode", "serve", "--service", "--port", "0"];
  if (platform === "win32") return [comspec ?? "cmd.exe", "/d", "/c", ...serve];
  return serve;
}

/** Pid recorded in the registration file, or `undefined`. The file content is never logged. */
export async function readRegisteredPid(file: string): Promise<number | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
    if (typeof parsed === "object" && parsed !== null && "pid" in parsed && typeof parsed.pid === "number") {
      return parsed.pid;
    }
  } catch {
    // Missing or unreadable registration: nothing is registered.
  }
  return undefined;
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to another user.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export interface ServerManagerOptions {
  readonly registrationFile: string | undefined;
  readonly command: readonly string[];
  readonly env: Readonly<Record<string, string>> | undefined;
  readonly logger: Logger;
  readonly ensure?: (options: EnsureOptions) => Promise<Endpoint>;
  readonly readRegisteredPid?: (file: string) => Promise<number | undefined>;
  readonly isProcessAlive?: (pid: number) => boolean;
}

export class ServerManager {
  readonly #registrationFile: string | undefined;
  readonly #command: readonly string[];
  readonly #env: Readonly<Record<string, string>> | undefined;
  readonly #logger: Logger;
  readonly #ensure: (options: EnsureOptions) => Promise<Endpoint>;
  readonly #readRegisteredPid: (file: string) => Promise<number | undefined>;
  readonly #isProcessAlive: (pid: number) => boolean;
  #starting: Promise<Endpoint> | undefined;

  constructor(options: ServerManagerOptions) {
    this.#registrationFile = options.registrationFile;
    this.#command = options.command;
    this.#env = options.env;
    this.#logger = options.logger;
    this.#ensure = options.ensure ?? ensure;
    this.#readRegisteredPid = options.readRegisteredPid ?? readRegisteredPid;
    this.#isProcessAlive = options.isProcessAlive ?? isProcessAlive;
  }

  /**
   * Starts a service. Concurrent calls share one start. Refuses when the registration names a live process:
   * `ensure()` terminates a registered service that fails three consecutive probes, and Nexus must never
   * stop the user's service.
   *
   * RESIDUAL RISK (not mitigated, see the WP-02 report): `ensure()` polls for up to 120 s. If a user service
   * registers in the default file during that poll and then fails three consecutive probes, `ensure()`
   * terminates it. Nexus cannot interrupt that loop without reimplementing the startup. The window only
   * exists when nothing was registered when `start()` began.
   */
  start(): Promise<Endpoint> {
    this.#starting ??= this.#startOnce().finally(() => {
      this.#starting = undefined;
    });
    return this.#starting;
  }

  async #startOnce(): Promise<Endpoint> {
    const file = this.#registrationFile ?? fallback();
    const pid = await this.#readRegisteredPid(file);
    if (pid !== undefined && this.#isProcessAlive(pid)) {
      throw unavailable(`A service is registered (pid ${pid}) but did not answer discovery; not starting a second one`);
    }
    return this.#ensure({
      file,
      command: [...this.#command],
      env: this.#env,
      onStart: (reason, previousVersion) => {
        this.#logger.info("Starting the OpenCode service", { reason, previousVersion });
      },
    });
  }
}
