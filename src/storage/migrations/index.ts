import { INITIAL_SCHEMA } from "./001-initial.ts";
import type { Migration } from "./runner.ts";

export {
  assertMigrationList,
  latestVersion,
  migrate,
  readUserVersion,
  type Migration,
  type MigrationResult,
} from "./runner.ts";

/** Ordered list. Append new migrations; never edit a shipped one. */
export const MIGRATIONS: readonly Migration[] = [INITIAL_SCHEMA];
