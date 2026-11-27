import { nexusError } from "./errors.ts";

export interface BackoffPolicy {
  baseMs: number;
  maxMs: number;
}

/** Receives the capped delay and the attempt number; returns the delay to use. Clamped to `[0, maxMs]`. */
export type Jitter = (delayMs: number, attempt: number) => number;

export const noJitter: Jitter = (delayMs) => delayMs;

/** "Full jitter": a uniform value in `[0, delay)`. `random` must return a value in `[0, 1)`. */
export function fullJitter(random: () => number): Jitter {
  return (delayMs) => random() * delayMs;
}

/**
 * Delay before retry number `attempt` (1 is the first retry): `baseMs * 2^(attempt-1)`, capped at
 * `maxMs`. The jitter is applied after the cap, and the result is clamped again so it never exceeds
 * `maxMs`. Pure: no timers and no clock.
 */
export function backoffDelay(attempt: number, policy: BackoffPolicy, jitter: Jitter = noJitter): number {
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw nexusError("VALIDATION", "backoff attempt must be an integer >= 1");
  }
  if (!Number.isFinite(policy.baseMs) || policy.baseMs < 0 || !Number.isFinite(policy.maxMs) || policy.maxMs < 0) {
    throw nexusError("VALIDATION", "backoff baseMs and maxMs must be finite and >= 0");
  }
  // The exponent is capped so that very large attempt numbers cannot produce Infinity * 0.
  const exponent = Math.min(attempt - 1, 1000);
  const capped = Math.min(policy.maxMs, policy.baseMs * 2 ** exponent);
  const jittered = jitter(capped, attempt);
  const value = Number.isFinite(jittered) ? jittered : capped;
  return Math.min(policy.maxMs, Math.max(0, Math.round(value)));
}
