/**
 * Child process for `server-subscribe.test.ts`. Opens the global stream of the shared service, reads the
 * first event, closes the stream, and then returns WITHOUT calling process.exit: the parent checks that the
 * process ends by itself, which is only possible when no socket or timer is left open.
 * Prints event types only, never event data.
 */
import { createOpenCodeGateway } from "../../src/server/index.ts";
import type { Logger } from "../../src/contracts/common.ts";

const silent: Logger = { debug() {}, info() {}, warn() {}, error() {} };
const mode = process.argv[2] === "break" ? "break" : "abort";

const gateway = createOpenCodeGateway({ logger: silent, autoStart: false });
const controller = new AbortController();
const iterator = gateway.subscribe(controller.signal)[Symbol.asyncIterator]();

const first = await iterator.next();
console.log(`first:${first.value?.type ?? "none"}`);

if (mode === "abort") {
  // R2: the abort must resolve the pending read and close the socket.
  const pending = iterator.next();
  controller.abort();
  const end = await pending;
  console.log(`closed:${end.done === true ? "abort" : "event"}`);
} else {
  // Leaving a `for await` loop calls return() with no read pending.
  await iterator.return?.();
  console.log("closed:return");
}
