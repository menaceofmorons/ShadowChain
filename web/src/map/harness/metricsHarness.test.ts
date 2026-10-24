import { describe, expect, it } from 'vitest';
import stubEngineSource from '../layout/testing/stubEngine.ts?raw';
import type { LayoutEngine, PlacedNode } from '../layout/types';
import { createStubEngine } from '../layout/testing/stubEngine';
import { generateChain, generateChurnScript, SYNTHETIC_NODE_COUNTS, SYNTHETIC_ROOT_SYSTEM_ID } from '../synthetic';
import { formatReport } from './formatReport';
import { measureCodeSize } from './codeSize';
import { countMovedNodes } from './movement';
import { runHarness } from './metricsHarness';
import { summarise } from './stats';

const node = (nodeKey: string, x: number, y: number): PlacedNode => ({
  nodeKey,
  x,
  y,
  source: 'auto',
  alias: false,
  collapsed: false,
  hiddenCount: null,
});

const sequenceClock = (values: readonly number[]): (() => number) => {
  let index = 0;
  return () => values[index++] ?? 0;
};

describe('countMovedNodes', () => {
  it('counts only previously placed nodes whose position changed', () => {
    const previous = [node('a', 0, 0), node('b', 1, 1), node('c', 2, 2), node('gone', 9, 9)];
    const next = [node('a', 0, 0), node('b', 1, 5), node('c', 3, 2), node('new', 7, 7)];
    expect(countMovedNodes(previous, next)).toBe(2);
  });
});

describe('summarise', () => {
  it('computes count, median, p95 and max for known durations', () => {
    const stats = summarise([5, 1, 3, 2, 4, 10, 6, 7, 8, 9, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
    expect(stats).toEqual({ count: 20, median: 10.5, p95: 19, max: 20 });
  });

  it('handles odd counts and empty input', () => {
    expect(summarise([3, 1, 2])).toEqual({ count: 3, median: 2, p95: 3, max: 3 });
    expect(summarise([])).toEqual({ count: 0, median: 0, p95: 0, max: 0 });
  });
});

describe('measureCodeSize', () => {
  it('counts bytes and non-blank lines of a known text', () => {
    const text = 'one\n\n  \ntwo\r\nthree';
    expect(measureCodeSize([{ path: 'x.ts', text }])).toEqual({ bytes: 18, nonBlankLines: 3 });
  });

  it('sums across files and counts multibyte characters in bytes', () => {
    const size = measureCodeSize([
      { path: 'a', text: 'é' },
      { path: 'b', text: 'x\ny' },
    ]);
    expect(size).toEqual({ bytes: 5, nonBlankLines: 3 });
  });

  it('counts a real file', () => {
    const text = stubEngineSource;
    const size = measureCodeSize([{ path: 'stubEngine.ts', text }]);
    expect(size.bytes).toBe(new TextEncoder().encode(text).length);
    expect(size.nonBlankLines).toBeGreaterThan(30);
  });
});

describe('runHarness', () => {
  const graph = {
    systems: [{ id: 1 }, { id: 2 }, { id: 3 }],
    connections: [{ id: 1, createdAt: 1, endA: 1, endB: 2 }],
  };
  const addConnection = { id: 2, createdAt: 2, endA: 2, endB: 3 };

  it('measures exact moved nodes per addition and timings with a fake clock', async () => {
    const shifting: LayoutEngine = {
      layout(request) {
        const shift = request.type === 'incremental' ? 100 : 0;
        return request.tree.nodes.map((n, index) => node(n.keyString, index === 0 ? 0 : index + shift, 0));
      },
    };
    const report = await runHarness({
      label: 'shifting',
      engine: shifting,
      graph,
      rootSystemId: 1,
      churn: [
        { kind: 'add', connection: addConnection },
        { kind: 'remove', connectionId: 2 },
      ],
      engineSources: [{ path: 'e.ts', text: 'a\nb\n' }],
      now: sequenceClock([0, 10, 10, 14, 14, 20]),
    });
    expect(report.nodesMovedPerAddition.perAddition).toEqual([1]);
    expect(report.fullLayoutMs).toEqual({ count: 1, median: 10, p95: 10, max: 10 });
    expect(report.incrementalLayoutMs).toEqual({ count: 2, median: 5, p95: 6, max: 6 });
    expect(report.codeSize).toEqual({ bytes: 4, nonBlankLines: 2 });
  });

  it('repeats the full layout and reports additions and removals separately', async () => {
    const report = await runHarness({
      label: 'repeat',
      engine: createStubEngine(),
      graph,
      rootSystemId: 1,
      churn: [
        { kind: 'add', connection: addConnection },
        { kind: 'remove', connectionId: 2 },
      ],
      engineSources: [],
      fullRepeats: 3,
      now: sequenceClock([0, 4, 10, 16, 20, 28, 30, 31, 40, 48]),
    });
    expect(report.fullLayoutMs).toEqual({ count: 3, median: 6, p95: 8, max: 8 });
    expect(report.additionLayoutMs).toEqual({ count: 1, median: 1, p95: 1, max: 1 });
    expect(report.removalLayoutMs).toEqual({ count: 1, median: 8, p95: 8, max: 8 });
    expect(report.incrementalLayoutMs.count).toBe(2);
    expect(formatReport(report)).toContain('addition layout time');
    expect(formatReport(report)).toContain('removal layout time');
  });

  it.each([0, -1, 1.5])('rejects a full repeat count of %s', async (fullRepeats) => {
    await expect(
      runHarness({
        label: 'bad',
        engine: createStubEngine(),
        graph,
        rootSystemId: 1,
        churn: [],
        engineSources: [],
        fullRepeats,
      }),
    ).rejects.toThrow(/fullRepeats/);
  });

  it('reports zero movement for the stub engine on a hand-built addition', async () => {
    const report = await runHarness({
      label: 'stub',
      engine: createStubEngine(),
      graph,
      rootSystemId: 1,
      churn: [{ kind: 'add', connection: addConnection }],
      engineSources: [],
    });
    expect(report.nodesMovedPerAddition.perAddition).toEqual([0]);
  });

  it('report text contains every metric', async () => {
    const report = await runHarness({
      label: 'stub',
      engine: createStubEngine(),
      graph,
      rootSystemId: 1,
      churn: [{ kind: 'add', connection: addConnection }],
      engineSources: [{ path: 'e.ts', text: 'x' }],
    });
    const text = formatReport(report);
    for (const label of [
      'nodes moved per addition',
      'full layout time',
      'incremental layout time',
      'median',
      'p95',
      'max',
      'count',
      'bytes',
      'non-blank lines',
    ]) {
      expect(text).toContain(label);
    }
  });

  it.each(SYNTHETIC_NODE_COUNTS)('runs end to end on a %i node generated graph', async (nodeCount) => {
    const generated = generateChain({ nodeCount, seed: 3 });
    const churn = generateChurnScript(generated, { seed: 5, operationCount: 20 });
    const report = await runHarness({
      label: 'stub',
      engine: createStubEngine(),
      graph: generated,
      rootSystemId: SYNTHETIC_ROOT_SYSTEM_ID,
      churn,
      engineSources: [{ path: 'e.ts', text: 'x' }],
    });
    expect(report.nodeCount).toBe(nodeCount);
    expect(report.incrementalLayoutMs.count).toBe(20);
    expect(report.fullLayoutMs.count).toBe(1);
    expect(report.nodesMovedPerAddition.count).toBeGreaterThan(0);
    expect(formatReport(report)).toContain(String(nodeCount));
  });
});
