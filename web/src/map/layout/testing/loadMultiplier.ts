export const LOAD_MULTIPLIER = 4;

export const TEST_TIMEOUT_FLOOR_MS = 15_000;

export const scaledLimit = (limitMs: number, factor: number = LOAD_MULTIPLIER): number => limitMs * factor;

export const scaledTimeout = (baseMs: number): number => Math.max(TEST_TIMEOUT_FLOOR_MS, baseMs * LOAD_MULTIPLIER);
