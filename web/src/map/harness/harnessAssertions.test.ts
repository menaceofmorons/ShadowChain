import { describe, expect, it } from 'vitest';
import { createStubEngine } from '../layout/testing/stubEngine';
import type { LayoutEngine } from '../layout/types';
import { generateChain, generateChurnScript, SYNTHETIC_ROOT_SYSTEM_ID } from '../synthetic';
import {
  assertMovedPerAdditionAtMost,
  assertNoMovementOnAddition,
  assertWithinTimeBudget,
  HarnessAssertionError,
} from './assertions';
import { runHarness } from './metricsHarness';
import type { HarnessReport } from './metricsHarness';
import { createDelayedEngine } from './testing/delayedEngine';
import { createShiftingEngine } from './testing/shiftingEngine';

const graph = generateChain({ nodeCount: 50, seed: 3 });
const churn = generateChurnScript(graph, { seed: 4, operationCount: 12 });

const makeClock = () => {
  let time = 0;
  return { now: () => time, advance: (ms: number) => void (time += ms) };
};

const harnessWith = (engine: LayoutEngine, now?: () => number): Promise<HarnessReport> =>
  runHarness({
    label: 'x',
    engine,
    graph,
    rootSystemId: SYNTHETIC_ROOT_SYSTEM_ID,
    churn,
    engineSources: [],
    ...(now === undefined ? {} : { now }),
  });

describe('movement assertions', () => {
  it('accept the stable engine', async () => {
    const report = await harnessWith(createStubEngine());
    expect(report.nodesMovedPerAddition.count).toBeGreaterThan(0);
    expect(() => {
      assertNoMovementOnAddition(report);
    }).not.toThrow();
    expect(() => {
      assertMovedPerAdditionAtMost(report, 0);
    }).not.toThrow();
  });

  it('flag the shifting engine', async () => {
    const report = await harnessWith(createShiftingEngine(createStubEngine()));
    expect(report.nodesMovedPerAddition.max).toBeGreaterThan(0);
    expect(() => {
      assertNoMovementOnAddition(report);
    }).toThrow(HarnessAssertionError);
    expect(() => {
      assertMovedPerAdditionAtMost(report, 0);
    }).toThrow(/bound is 0/);
  });

  it('bound check accepts exactly the peak and rejects one below', async () => {
    const report = await harnessWith(createShiftingEngine(createStubEngine()));
    const peak = report.nodesMovedPerAddition.max;
    expect(() => {
      assertMovedPerAdditionAtMost(report, peak);
    }).not.toThrow();
    expect(() => {
      assertMovedPerAdditionAtMost(report, peak - 1);
    }).toThrow(HarnessAssertionError);
  });
});

describe('timing assertion', () => {
  it('accepts the stable engine and flags the delayed engine on the injected clock', async () => {
    const stableClock = makeClock();
    const stable = await harnessWith(createStubEngine(), stableClock.now);
    expect(() => {
      assertWithinTimeBudget(stable.incrementalLayoutMs, 5);
    }).not.toThrow();

    const delayedClock = makeClock();
    const delayed = await harnessWith(
      createDelayedEngine(createStubEngine(), 50, (ms) => {
        delayedClock.advance(ms);
      }),
      delayedClock.now,
    );
    expect(delayed.incrementalLayoutMs.median).toBe(50);
    expect(() => {
      assertWithinTimeBudget(delayed.incrementalLayoutMs, 5);
    }).toThrow(/exceeds budget/);
    expect(() => {
      assertWithinTimeBudget(delayed.incrementalLayoutMs, 50, 'max');
    }).not.toThrow();
  });

  it('rejects an empty sample set', () => {
    expect(() => {
      assertWithinTimeBudget({ count: 0, median: 0, p95: 0, max: 0 }, 10);
    }).toThrow(/no timing samples/);
  });
});
