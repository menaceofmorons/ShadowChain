export const LOAD_MULTIPLIER = 4;

export const TEST_TIMEOUT_FLOOR_MS = 15_000;

export const scaledLimit = (limitMs: number): number => limitMs * LOAD_MULTIPLIER;

export const scaledTimeout = (baseMs: number): number => Math.max(TEST_TIMEOUT_FLOOR_MS, baseMs * LOAD_MULTIPLIER);
