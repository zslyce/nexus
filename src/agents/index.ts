/** Public surface of the agent registry. Depends on the config (contracts) and on `yaml`; never on OpenCode. */
export {
  createAgentRegistry,
  type AgentFileSystem,
  type AgentRegistryOptions,
  type AgentSyncResult,
} from "./registry.ts";
export { loadAgentSource, type AgentSource } from "./loader.ts";
export { AGENT_DIRECTORY, GENERATED_MARKER } from "./definitions.ts";
