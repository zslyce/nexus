// Read-only diagnostics: creates no sessions, runs no inference and starts no services.
import { OpenCode } from "@opencode/client";
import { Service } from "@opencode/client/service";

const directory = process.argv[2] ?? process.cwd();
const endpoint = await Service.discover();
if (!endpoint) {
  console.error("No OpenCode service is running. Start it with: opencode service start");
  process.exit(1);
}
const client = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) });
const location = { directory };

const info = await client.server.info();
console.log(`OpenCode ${info.version} at ${endpoint.url} (auth: ${endpoint.auth?.type ?? "none"})`);

// The first query for a location may come back empty while plugins are still loading.
let models = [];
for (let attempt = 0; attempt < 10 && models.length === 0; attempt++) {
  const response = await client.model.list({ location });
  models = response.data.filter((m) => m.providerID === "opencode-go" && m.enabled);
  if (models.length === 0) await new Promise((resolve) => setTimeout(resolve, 1000));
}
console.log(`Enabled opencode-go models: ${models.length}`);
for (const model of models) console.log(`  ${model.id}  [${model.variants.map((v) => v.id).join(", ")}]`);

const agents = await client.agent.list({ location });
console.log(`Agents in ${directory}: ${agents.data.filter((a) => !a.hidden).map((a) => a.id).join(", ")}`);
process.exit(models.length > 0 ? 0 : 1);
