import { randomBytes } from "node:crypto";

/** Supplies `size` random bytes. Injected in tests; the default is `crypto.randomBytes`. */
export type RandomSource = (size: number) => Uint8Array;

export interface IdGenerator {
  /** `tsk_` + 20 hex characters. */
  taskId(): string;
  /** `ses_nexus_` + 16 hex characters. OpenCode's `Session.ID` schema only requires the `ses` prefix. */
  sessionId(): string;
  /** `msg_nexus_` + 16 hex characters. OpenCode's `Session.Message.ID` schema requires the `msg_` prefix. */
  messageId(): string;
}

export const ID_PATTERNS = {
  task: /^tsk_[0-9a-f]{20}$/,
  session: /^ses_nexus_[0-9a-f]{16}$/,
  message: /^msg_nexus_[0-9a-f]{16}$/,
} as const;

export function createIdGenerator(random: RandomSource = (size) => randomBytes(size)): IdGenerator {
  const hex = (size: number): string => {
    const bytes = random(size);
    if (bytes.length !== size) {
      throw new RangeError(`random source returned ${bytes.length} bytes, expected ${size}`);
    }
    return Buffer.from(bytes).toString("hex");
  };
  return {
    taskId: () => `tsk_${hex(10)}`,
    sessionId: () => `ses_nexus_${hex(8)}`,
    messageId: () => `msg_nexus_${hex(8)}`,
  };
}
