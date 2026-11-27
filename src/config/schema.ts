import { z } from "zod";

/** Agent names become `nexus-<name>` and `.opencode/agents/nexus-<name>.md`: keep them filename-safe. */
export const AGENT_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** `provider/model` or `provider/model#variant`. The model id may contain dots but no `#` or whitespace. */
export const MODEL_PATTERN = /^([^/#\s]+)\/([^#\s]+)(?:#([^#\s]+))?$/;

export const ALLOWED_PROVIDER = "opencode-go" as const;

export const DEFAULT_VALIDATION_COMMAND_PATTERNS: readonly string[] = [
  "npm test",
  "npm run typecheck",
  "npm run build",
  "node --test",
  "tsc",
  "pytest",
  "go test",
  "cargo test",
];

const PermissionSchema = z.strictObject({
  action: z.string().min(1),
  resource: z.string().min(1),
  effect: z.enum(["allow", "deny", "ask"]),
});

const AgentSchema = z
  .strictObject({
    from: z.string().min(1).optional(),
    description: z.string().min(1).optional(),
    systemPrompt: z.string().min(1).optional(),
    model: z.string().regex(MODEL_PATTERN, "expected provider/model or provider/model#variant"),
    canWrite: z.boolean().prefault(false),
    steps: z.int().positive().prefault(25),
    timeoutMs: z.int().positive().prefault(600000),
    maxConcurrency: z.int().positive().prefault(1),
    // Secure default: nothing is allowed unless the config says so.
    permissions: z.array(PermissionSchema).prefault([{ action: "*", resource: "*", effect: "deny" }]),
  })
  .superRefine((agent, ctx) => {
    if (agent.from !== undefined) return;
    if (agent.description === undefined) {
      ctx.addIssue({ code: "custom", path: ["description"], message: "required when `from` is not set" });
    }
    if (agent.systemPrompt === undefined) {
      ctx.addIssue({ code: "custom", path: ["systemPrompt"], message: "required when `from` is not set" });
    }
  });

const TasksSchema = z
  .strictObject({
    defaultTimeoutMs: z.int().positive().prefault(900000),
    maxAttempts: z.int().positive().prefault(2),
    backoffBaseMs: z.int().nonnegative().prefault(2000),
    backoffMaxMs: z.int().nonnegative().prefault(60000),
    permissionPolicy: z.enum(["reject", "surface"]).prefault("reject"),
    validationCommandPatterns: z
      .array(z.string().min(1))
      .prefault([...DEFAULT_VALIDATION_COMMAND_PATTERNS]),
  })
  .superRefine((tasks, ctx) => {
    if (tasks.backoffMaxMs < tasks.backoffBaseMs) {
      ctx.addIssue({ code: "custom", path: ["backoffMaxMs"], message: "must be >= backoffBaseMs" });
    }
  });

/** Shape of `nexus.config.json` after defaults. Unknown keys are rejected at every level. */
export const ConfigFileSchema = z.strictObject({
  opencode: z
    .strictObject({
      allowedProviders: z.array(z.enum([ALLOWED_PROVIDER])).min(1).prefault([ALLOWED_PROVIDER]),
      autoStart: z.boolean().prefault(true),
    })
    .prefault({}),
  concurrency: z.strictObject({ global: z.int().positive().prefault(3) }).prefault({}),
  tasks: TasksSchema.prefault({}),
  history: z
    .strictObject({
      maxTasks: z.int().positive().prefault(500),
      maxAgeDays: z.int().positive().prefault(30),
      maxEventsPerTask: z.int().positive().prefault(2000),
    })
    .prefault({}),
  agents: z.record(z.string().regex(AGENT_NAME_PATTERN, "use lowercase letters, digits and hyphens (max 64)"), AgentSchema).prefault({}),
});

export type ConfigFileInput = z.input<typeof ConfigFileSchema>;
export type ConfigFileParsed = z.output<typeof ConfigFileSchema>;
export type AgentFileParsed = ConfigFileParsed["agents"][string];
