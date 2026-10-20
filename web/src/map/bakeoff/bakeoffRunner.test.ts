import { describe, expect, it } from 'vitest';
import { createShiftingEngine } from '../harness/testing';
import { createStubEngine } from '../layout/testing/stubEngine';
import { formatBakeoffReport, meetsFullTarget, meetsIncrementalTarget } from './formatBakeoffReport';
import { measureStability, measureWanderer553, runStability } from './bakeoffRunner';
import type { BakeoffCandidate, BakeoffData } from './types';

const stable: BakeoffCandidate = {
  name: 'stable-stub',
  createEngine: () => createStubEngine(),
  modes: ['top-down', 'left-to-right'],
};
const shifting: BakeoffCandidate = {
  name: 'shifting-stub',
  createEngine: () => createShiftingEngine(createStubEngine()),
  modes: ['top-down'],
};
const options = { seed: 7, churnSteps: 12, determinismRepeats: 3 };

describe('measureStability', () => {
  it('reports zero movement and determinism for an engine that never moves placed nodes', async () => {
    const row = await measureStability(stable, 'top-down', 50, options);
    expect(row).toMatchObject({
      candidate: 'stable-stub',
      mode: 'top-down',
      size: 50,
      churnSteps: 12,
      deterministic: true,
    });
    expect(row.moved.max).toBe(0);
    expect(row.moved.median).toBe(0);
    expect(row.moved.count).toBeGreaterThan(0);
  });

  it('reports movement for an engine that shifts placed nodes', async () => {
    const row = await measureStability(shifting, 'top-down', 50, options);
    expect(row.moved.max).toBeGreaterThan(0);
    expect(row.moved.p95).toBeLessThanOrEqual(row.moved.max);
    expect(row.moved.median).toBeLessThanOrEqual(row.moved.p95);
  });

  it('reports non-determinism when repeated layouts differ', async () => {
    let calls = 0;
    const drifting: BakeoffCandidate = {
      name: 'drifting',
      modes: ['top-down'],
      createEngine: () => {
        const inner = createStubEngine({ offset: calls });
        calls += 1;
        return inner;
      },
    };
    const row = await measureStability(drifting, 'top-down', 50, options);
    expect(row.deterministic).toBe(false);
  });
});

describe('measureWanderer553', () => {
  it('passes only when the new node overlaps nothing and no placed node moves', async () => {
    for (const candidate of [stable, shifting]) {
      const row = await measureWanderer553(candidate, 'top-down');
      expect(row.pass).toBe(!row.newNodeOverlaps && row.placedNodesMoved === 0);
    }
  });

  it('records moved placed nodes for a shifting engine', async () => {
    const row = await measureWanderer553(shifting, 'top-down');
    expect(row.placedNodesMoved).toBeGreaterThan(0);
    expect(row.pass).toBe(false);
  });
});

describe('runStability', () => {
  it('covers every candidate, supported mode and size', async () => {
    const result = await runStability([stable, shifting], [50, 150], options);
    expect(result.stability).toHaveLength((2 + 1) * 2);
    expect(result.wanderer).toHaveLength(2 + 1);
    expect(result.stability.map((row) => `${row.candidate}/${row.mode}/${String(row.size)}`)).toContain(
      'shifting-stub/top-down/150',
    );
  });
});

const stats = (median: number, p95: number, max: number) => ({ count: 10, median, p95, max });

const data: BakeoffData = {
  machine: 'test machine',
  runCounts: { warmupFullRuns: 2, fullRuns: 10, incrementalRuns: 40, stabilityChurnSteps: 30, stabilitySeed: 7 },
  stability: [
    { candidate: 'alpha', mode: 'top-down', size: 150, churnSteps: 30, moved: stats(0, 0, 0), deterministic: true },
    {
      candidate: 'beta',
      mode: 'top-down',
      size: 150,
      churnSteps: 30,
      moved: stats(12, 80.5, 149),
      deterministic: false,
    },
  ],
  wanderer: [
    { candidate: 'alpha', mode: 'top-down', newNodeOverlaps: false, placedNodesMoved: 0, pass: true },
    { candidate: 'beta', mode: 'top-down', newNodeOverlaps: false, placedNodesMoved: 4, pass: false },
  ],
  speed: [
    { candidate: 'alpha', mode: 'top-down', size: 150, full: stats(5, 99.99, 120), incremental: stats(1, 9.99, 12) },
    { candidate: 'beta', mode: 'top-down', size: 150, full: stats(60, 100, 150), incremental: stats(8, 10, 20) },
  ],
  codeSize: [
    { candidate: 'alpha', bytes: 1000, nonBlankLines: 40, workerBundleBytes: 2048 },
    { candidate: 'beta', bytes: 3000, nonBlankLines: 90, workerBundleBytes: 900000 },
  ],
};

describe('formatBakeoffReport', () => {
  const report = formatBakeoffReport(data);

  it('prints the machine, run counts and both candidates side by side', () => {
    expect(report).toContain('machine: test machine');
    expect(report).toContain('measured 10 full and 40 incremental');
    expect(report).toMatch(/mode\s+nodes\s+alpha\s+beta/);
  });

  it('prints moved-per-addition statistics and determinism', () => {
    expect(report).toMatch(/top-down\s+150\s+0\.00\/0\.00\/0\s+12\.00\/80\.50\/149/);
    expect(report).toMatch(/top-down\s+150\s+yes\s+NO/);
  });

  it('prints the Wanderer outcome and code size', () => {
    expect(report).toContain('pass (overlap no, moved 0)');
    expect(report).toContain('fail (overlap no, moved 4)');
    expect(report).toMatch(/beta\s+3000\s+90\s+900000/);
  });

  it('marks targets against p95 with strict inequality', () => {
    const [alpha, beta] = data.speed;
    expect(meetsFullTarget(alpha!)).toBe(true);
    expect(meetsIncrementalTarget(alpha!)).toBe(true);
    expect(meetsFullTarget(beta!)).toBe(false);
    expect(meetsIncrementalTarget(beta!)).toBe(false);
    expect(report).toMatch(/alpha\s+top-down\s+met\s+met/);
    expect(report).toMatch(/beta\s+top-down\s+NOT met\s+NOT met/);
  });
});
