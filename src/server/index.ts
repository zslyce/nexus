/** Public surface of the OpenCode gateway. `@opencode/client` is imported only inside `src/server/**`. */
export {
  createOpenCodeGateway,
  type GatewaySeams,
  type OpenCodeGatewayOptions,
  type Scheduler,
} from "./opencode-client.ts";
export { defaultServiceCommand } from "./server-manager.ts";
