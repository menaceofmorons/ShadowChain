import { describe, expect, it } from 'vitest';
import { runStability } from './bakeoffRunner';
import { BAKEOFF_CANDIDATES } from './candidates';

const UNIT_SIZES = [50, 150];

describe('bake-off candidates stability', () => {
  it('measures every candidate, supported mode and unit size; all are deterministic and tidy-tree never moves placed nodes', async () => {
    const { stability, wanderer } = await runStability(BAKEOFF_CANDIDATES, UNIT_SIZES);
    const modeCount = BAKEOFF_CANDIDATES.reduce((sum, candidate) => sum + candidate.modes.length, 0);
    expect(stability).toHaveLength(modeCount * UNIT_SIZES.length);
    expect(wanderer).toHaveLength(modeCount);
    expect(stability.every((row) => row.deterministic)).toBe(true);
    expect(stability.filter((row) => row.candidate === 'tidy-tree').every((row) => row.moved.max === 0)).toBe(true);
    expect(wanderer.filter((row) => row.candidate === 'tidy-tree').every((row) => row.pass)).toBe(true);
  }, 300_000);
});
