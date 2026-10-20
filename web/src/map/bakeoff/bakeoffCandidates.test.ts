import { describe, expect, it } from 'vitest';
import { runStability } from './bakeoffRunner';
import { BAKEOFF_CANDIDATES } from './candidates';
import { BAKEOFF_SIZES } from './types';

describe('bake-off candidates stability', () => {
  it('measures every candidate, supported mode and size; all are deterministic and tidy-tree never moves placed nodes', async () => {
    const { stability, wanderer } = await runStability(BAKEOFF_CANDIDATES, BAKEOFF_SIZES);
    const modeCount = BAKEOFF_CANDIDATES.reduce((sum, candidate) => sum + candidate.modes.length, 0);
    expect(stability).toHaveLength(modeCount * BAKEOFF_SIZES.length);
    expect(wanderer).toHaveLength(modeCount);
    expect(stability.every((row) => row.deterministic)).toBe(true);
    expect(stability.filter((row) => row.candidate === 'tidy-tree').every((row) => row.moved.max === 0)).toBe(true);
    expect(wanderer.filter((row) => row.candidate === 'tidy-tree').every((row) => row.pass)).toBe(true);
  }, 300_000);
});
