import ELK from 'elkjs/lib/elk.bundled.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildChainTree } from '../../../model/chainTree';
import { applyChurn, generateChain, generateChurnScript, SYNTHETIC_ROOT_SYSTEM_ID } from '../../../synthetic';
import { createElkEngine } from './elkEngine';

const LOAD_FACTOR = Math.max(1, Number(process.env.LAYOUT_TEST_LOAD_FACTOR ?? 1) || 1);
const scaledLimit = (limitMs: number): number => limitMs * LOAD_FACTOR;

const INCREMENTAL_P95_LIMIT_MS = scaledLimit(10);
const FULL_P95_LIMIT_MS_AT_500 = scaledLimit(500);
const FULL_P95_LIMIT_MS_AT_150 = scaledLimit(100);
const SINGLE_REQUEST_LIMIT_MS_AT_500 = scaledLimit(2000);
const TIMING_TEST_TIMEOUT_MS = scaledLimit(30_000);

const percentile95 = (values: readonly number[]): number =>
  [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.ceil(values.length * 0.95) - 1)] as number;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('radial layout time', () => {
  it(
    'keeps incremental placement under the limit at 150 nodes',
    async () => {
      const engine = createElkEngine();
      let graph = generateChain({ nodeCount: 150, seed: 7 });
      const churn = generateChurnScript(graph, { seed: 8, operationCount: 30 });
      let tree = buildChainTree(graph, SYNTHETIC_ROOT_SYSTEM_ID);
      let placed = await engine.layout({ type: 'full', tree, mode: 'radial', manualPositions: [] });
      let known = new Set(tree.nodes.map((n) => n.keyString));
      const spy = vi.spyOn(ELK.prototype, 'layout');
      const plain: number[] = [];
      const saturated: number[] = [];
      for (const operation of churn) {
        graph = applyChurn(graph, [operation]);
        tree = buildChainTree(graph, SYNTHETIC_ROOT_SYSTEM_ID);
        const next = new Set(tree.nodes.map((n) => n.keyString));
        const calls = spy.mock.calls.length;
        const start = performance.now();
        placed = await engine.layout({
          type: 'incremental',
          tree,
          mode: 'radial',
          manualPositions: [],
          previous: placed,
          addedNodeKeys: [...next].filter((key) => !known.has(key)),
          removedNodeKeys: [...known].filter((key) => !next.has(key)),
        });
        const ms = performance.now() - start;
        if (operation.kind === 'add') {
          (spy.mock.calls.length > calls ? saturated : plain).push(ms);
        }
        known = next;
      }
      expect(percentile95(plain)).toBeLessThan(INCREMENTAL_P95_LIMIT_MS);
      expect(Math.max(0, ...saturated)).toBeLessThan(FULL_P95_LIMIT_MS_AT_150);
    },
    TIMING_TEST_TIMEOUT_MS,
  );

  it.each([7, 8])(
    'bounds layout time at 500 nodes on the seed %i churn shape',
    async (seed) => {
      const engine = createElkEngine();
      let graph = generateChain({ nodeCount: 500, seed });
      const churn = generateChurnScript(graph, { seed: seed + 1, operationCount: 30 });
      const durations: number[] = [];
      await engine.layout({
        type: 'full',
        tree: buildChainTree(graph, SYNTHETIC_ROOT_SYSTEM_ID),
        mode: 'radial',
        manualPositions: [],
      });
      for (const [index, operation] of churn.entries()) {
        graph = applyChurn(graph, [operation]);
        if (index < 14) {
          continue;
        }
        const tree = buildChainTree(graph, SYNTHETIC_ROOT_SYSTEM_ID);
        const start = performance.now();
        await engine.layout({ type: 'full', tree, mode: 'radial', manualPositions: [] });
        durations.push(performance.now() - start);
      }
      expect(percentile95(durations)).toBeLessThan(FULL_P95_LIMIT_MS_AT_500);
      expect(Math.max(...durations)).toBeLessThan(SINGLE_REQUEST_LIMIT_MS_AT_500);
    },
    TIMING_TEST_TIMEOUT_MS,
  );
});
