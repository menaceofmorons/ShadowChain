// @vitest-environment node
import ELK from 'elkjs/lib/elk.bundled.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildChainTree } from '../../../model/chainTree';
import type { ChainNode, ChainTree } from '../../../model/types';
import { applyChurn, generateChain, generateChurnScript, SYNTHETIC_ROOT_SYSTEM_ID } from '../../../synthetic';
import type { ChurnOperation } from '../../../synthetic';
import { DEFAULT_ENGINE_OPTIONS } from '../../engineOptions';
import type { LayoutEngine, PlacedNode } from '../../types';
import { createElkEngine } from './elkEngine';

const MAX_NODES_MOVED_PER_ADDITION = 0;
const MAX_SHIFT_PER_ADDITION = 0;
const INCREMENTAL_P95_LIMIT_MS = 10;
const FULL_P95_LIMIT_MS_AT_500 = 500;
const SINGLE_REQUEST_LIMIT_MS_AT_500 = 2000;
const RING_TOLERANCE = 1;

const sizeOf = (node: PlacedNode) =>
  node.alias
    ? { w: DEFAULT_ENGINE_OPTIONS.aliasWidth, h: DEFAULT_ENGINE_OPTIONS.aliasHeight }
    : { w: DEFAULT_ENGINE_OPTIONS.nodeWidth, h: DEFAULT_ENGINE_OPTIONS.nodeHeight };

const centreOf = (node: PlacedNode) => {
  const { w, h } = sizeOf(node);
  return { x: node.x + w / 2, y: node.y + h / 2 };
};

const overlappingPairs = (nodes: readonly PlacedNode[]): string[] => {
  const found: string[] = [];
  for (let i = 0; i < nodes.length; i += 1) {
    const a = nodes[i] as PlacedNode;
    const sa = sizeOf(a);
    for (let j = i + 1; j < nodes.length; j += 1) {
      const b = nodes[j] as PlacedNode;
      const sb = sizeOf(b);
      if (a.x < b.x + sb.w && b.x < a.x + sa.w && a.y < b.y + sb.h && b.y < a.y + sa.h) {
        found.push(`${a.nodeKey}/${b.nodeKey}`);
      }
    }
  }
  return found;
};

const parentsOf = (tree: ChainTree): Map<string, string> => {
  const parents = new Map<string, string>();
  tree.nodes.forEach((node) => {
    node.children.forEach((child) => parents.set(child.keyString, node.keyString));
  });
  return parents;
};

const depthsOf = (tree: ChainTree): Map<string, number> => {
  const depths = new Map<string, number>();
  const walk = (node: ChainNode, depth: number): void => {
    depths.set(node.keyString, depth);
    node.children.forEach((child) => {
      walk(child, depth + 1);
    });
  };
  walk(tree.root, 0);
  return depths;
};

const crossings = (tree: ChainTree, placed: readonly PlacedNode[]): string[] => {
  type Point = { x: number; y: number };
  const centres = new Map(placed.map((n) => [n.nodeKey, centreOf(n)]));
  const edges = tree.nodes.flatMap((node) =>
    node.children.map((child): [string, string, Point, Point] => [
      node.keyString,
      child.keyString,
      centres.get(node.keyString) as Point,
      centres.get(child.keyString) as Point,
    ]),
  );
  const side = (a: Point, b: Point, c: Point): number =>
    Math.sign((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x));
  const found: string[] = [];
  edges.forEach(([from1, to1, a, b], index) => {
    for (const [from2, to2, c, d] of edges.slice(index + 1)) {
      if (new Set([from1, to1, from2, to2]).size < 4) {
        continue;
      }
      if (side(a, b, c) !== side(a, b, d) && side(c, d, a) !== side(c, d, b)) {
        found.push(`${from1}>${to1} x ${from2}>${to2}`);
      }
    }
  });
  return found;
};

const turnAround = (origin: { x: number; y: number }, node: PlacedNode): number => {
  const c = centreOf(node);
  const turn = Math.atan2(c.y - origin.y, c.x - origin.x);
  return turn < 0 ? turn + 2 * Math.PI : turn;
};

const percentile95 = (values: readonly number[]): number =>
  [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.ceil(values.length * 0.95) - 1)] as number;

interface ChurnRun {
  readonly additions: {
    tree: ChainTree;
    before: readonly PlacedNode[];
    after: readonly PlacedNode[];
    added: string[];
  }[];
  readonly steps: { tree: ChainTree; placed: readonly PlacedNode[]; kind: ChurnOperation['kind']; ms: number }[];
}

async function runChurn(engine: LayoutEngine, nodeCount: number, seed: number, operations: number): Promise<ChurnRun> {
  let graph = generateChain({ nodeCount, seed });
  const churn = generateChurnScript(graph, { seed: seed + 1, operationCount: operations });
  let tree = buildChainTree(graph, SYNTHETIC_ROOT_SYSTEM_ID);
  let placed = await engine.layout({ type: 'full', tree, mode: 'radial', manualPositions: [] });
  let known = new Set(tree.nodes.map((n) => n.keyString));
  const run: ChurnRun = { additions: [], steps: [] };
  for (const operation of churn) {
    graph = applyChurn(graph, [operation]);
    tree = buildChainTree(graph, SYNTHETIC_ROOT_SYSTEM_ID);
    const next = new Set(tree.nodes.map((n) => n.keyString));
    const added = [...next].filter((key) => !known.has(key));
    const removed = [...known].filter((key) => !next.has(key));
    const start = performance.now();
    const after = await engine.layout({
      type: 'incremental',
      tree,
      mode: 'radial',
      manualPositions: [],
      previous: placed,
      addedNodeKeys: added,
      removedNodeKeys: removed,
    });
    run.steps.push({ tree, placed: after, kind: operation.kind, ms: performance.now() - start });
    if (operation.kind === 'add') {
      run.additions.push({ tree, before: placed, after, added });
    }
    placed = after;
    known = next;
  }
  return run;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe.each([50, 150, 250, 500])('radial incremental churn at %i nodes', (count) => {
  const engine = createElkEngine();

  it('places additions without overlap, on their ring, without moving placed nodes and without crossings', async () => {
    const run = await runChurn(engine, count, 7, 30);
    for (const { tree, before, after, added } of run.additions) {
      expect(overlappingPairs(after)).toEqual([]);
      const previous = new Map(before.map((n) => [n.nodeKey, n]));
      const moved = after.filter((n) => {
        const prior = previous.get(n.nodeKey);
        return prior !== undefined && (prior.x !== n.x || prior.y !== n.y);
      });
      expect(moved.length).toBeLessThanOrEqual(MAX_NODES_MOVED_PER_ADDITION);
      for (const node of moved) {
        const prior = previous.get(node.nodeKey) as PlacedNode;
        expect(Math.hypot(node.x - prior.x, node.y - prior.y)).toBeLessThanOrEqual(MAX_SHIFT_PER_ADDITION);
      }
      const depths = depthsOf(tree);
      const rootPlaced = after.find((n) => n.nodeKey === tree.root.keyString) as PlacedNode;
      const origin = centreOf(rootPlaced);
      const radiusOf = (n: PlacedNode): number => Math.hypot(centreOf(n).x - origin.x, centreOf(n).y - origin.y);
      for (const key of added) {
        const node = after.find((n) => n.nodeKey === key) as PlacedNode;
        const peers = after.filter(
          (n) => n.nodeKey !== key && depths.get(n.nodeKey) === depths.get(key) && !added.includes(n.nodeKey),
        );
        if (peers.length > 0) {
          expect(Math.abs(radiusOf(node) - radiusOf(peers[0] as PlacedNode))).toBeLessThan(RING_TOLERANCE);
        }
      }
      expect(crossings(tree, after)).toEqual([]);
    }
  });

  it('keeps sibling order and appends a new sibling after the existing ones', async () => {
    const run = await runChurn(engine, count, 7, 30);
    for (const { tree, before, after, added } of run.additions) {
      const parents = parentsOf(tree);
      const rootPlaced = after.find((n) => n.nodeKey === tree.root.keyString) as PlacedNode;
      const origin = centreOf(rootPlaced);
      const turns = new Map(after.map((n) => [n.nodeKey, turnAround(origin, n)]));
      const previous = new Set(before.map((n) => n.nodeKey));
      for (const key of added) {
        const parent = parents.get(key);
        const older = [...parents.entries()].filter(([child, p]) => p === parent && previous.has(child));
        for (const [sibling] of older) {
          expect(turns.get(key) as number).toBeGreaterThan(turns.get(sibling) as number);
        }
      }
    }
  });

  it('leaves surviving nodes where they were on removal', async () => {
    const run = await runChurn(engine, count, 7, 30);
    let previous: readonly PlacedNode[] | null = null;
    for (const step of run.steps) {
      if (step.kind === 'remove' && previous !== null) {
        const before = new Map(previous.map((n) => [n.nodeKey, n]));
        for (const node of step.placed) {
          const prior = before.get(node.nodeKey);
          if (prior !== undefined) {
            expect([node.x, node.y]).toEqual([prior.x, prior.y]);
          }
        }
      }
      previous = step.placed;
    }
  });
});

describe('radial incremental stability and time', () => {
  it('does not call elk for an incremental request', async () => {
    const engine = createElkEngine();
    const graph = generateChain({ nodeCount: 150, seed: 7 });
    const tree = buildChainTree(graph, SYNTHETIC_ROOT_SYSTEM_ID);
    const before = await engine.layout({ type: 'full', tree, mode: 'radial', manualPositions: [] });
    const churn = generateChurnScript(graph, { seed: 8, operationCount: 1 });
    const next = buildChainTree(applyChurn(graph, churn), SYNTHETIC_ROOT_SYSTEM_ID);
    const spy = vi.spyOn(ELK.prototype, 'layout');
    const known = new Set(tree.nodes.map((n) => n.keyString));
    await engine.layout({
      type: 'incremental',
      tree: next,
      mode: 'radial',
      manualPositions: [],
      previous: before,
      addedNodeKeys: next.nodes.map((n) => n.keyString).filter((k) => !known.has(k)),
      removedNodeKeys: [],
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it('places a node three jumps out on its own ring, inside the radial rules', async () => {
    const engine = createElkEngine();
    const graph = generateChain({ nodeCount: 150, seed: 7 });
    const tree = buildChainTree(graph, SYNTHETIC_ROOT_SYSTEM_ID);
    const depths = depthsOf(tree);
    const before = await engine.layout({ type: 'full', tree, mode: 'radial', manualPositions: [] });
    const deepest = Math.max(...depths.values());
    const outer = tree.nodes.filter((n) => depths.get(n.keyString) === 2 && n.kind === 'primary');
    expect(deepest).toBeGreaterThanOrEqual(3);
    const target = outer[0] as ChainNode;
    const nextId = Math.max(...graph.connections.map((c) => c.id)) + 1;
    const clock = Math.max(...graph.connections.map((c) => c.createdAt)) + 1;
    const extended = applyChurn(graph, [
      {
        kind: 'add',
        connection: { id: nextId, createdAt: clock, endA: target.systemId as number, endB: null },
      },
    ]);
    const next = buildChainTree(extended, SYNTHETIC_ROOT_SYSTEM_ID);
    const known = new Set(tree.nodes.map((n) => n.keyString));
    const added = next.nodes.map((n) => n.keyString).filter((k) => !known.has(k));
    expect(added.length).toBe(1);
    const after = await engine.layout({
      type: 'incremental',
      tree: next,
      mode: 'radial',
      manualPositions: [],
      previous: before,
      addedNodeKeys: added,
      removedNodeKeys: [],
    });
    expect(depthsOf(next).get(added[0] as string)).toBe(3);
    expect(overlappingPairs(after)).toEqual([]);
    expect(crossings(next, after)).toEqual([]);
    const origin = centreOf(after.find((n) => n.nodeKey === next.root.keyString) as PlacedNode);
    const radius = (n: PlacedNode): number => Math.hypot(centreOf(n).x - origin.x, centreOf(n).y - origin.y);
    const ringPeer = after.find((n) => depthsOf(next).get(n.nodeKey) === 3 && n.nodeKey !== added[0]) as
      PlacedNode | undefined;
    if (ringPeer !== undefined) {
      expect(Math.abs(radius(after.find((n) => n.nodeKey === added[0]) as PlacedNode) - radius(ringPeer))).toBeLessThan(
        RING_TOLERANCE,
      );
    }
  });

  it('keeps manual nodes where the request puts them', async () => {
    const engine = createElkEngine();
    const graph = generateChain({ nodeCount: 50, seed: 7 });
    const tree = buildChainTree(graph, SYNTHETIC_ROOT_SYSTEM_ID);
    const target = tree.nodes[5]?.keyString ?? '';
    const manualPositions = [{ nodeKey: target, x: 9000, y: 9000 }];
    const before = await engine.layout({ type: 'full', tree, mode: 'radial', manualPositions });
    const churn = generateChurnScript(graph, { seed: 8, operationCount: 1 });
    const next = buildChainTree(applyChurn(graph, churn), SYNTHETIC_ROOT_SYSTEM_ID);
    const known = new Set(tree.nodes.map((n) => n.keyString));
    const after = await engine.layout({
      type: 'incremental',
      tree: next,
      mode: 'radial',
      manualPositions,
      previous: before,
      addedNodeKeys: next.nodes.map((n) => n.keyString).filter((k) => !known.has(k)),
      removedNodeKeys: tree.nodes.map((n) => n.keyString).filter((k) => !next.nodes.some((m) => m.keyString === k)),
    });
    const placed = after.find((n) => n.nodeKey === target);
    if (placed !== undefined) {
      expect([placed.x, placed.y, placed.source]).toEqual([9000, 9000, 'manual']);
    }
  });

  it('gives the same incremental output for the same input across engine instances', async () => {
    const graph = generateChain({ nodeCount: 150, seed: 7 });
    const run = async () => (await runChurn(createElkEngine(), 150, 7, 12)).steps.map((s) => s.placed);
    expect(graph.systems.length).toBe(150);
    expect(await run()).toEqual(await run());
  });

  it('keeps incremental placement under the limit at 150 nodes', async () => {
    const run = await runChurn(createElkEngine(), 150, 7, 30);
    const additions = run.steps.filter((s) => s.kind === 'add').map((s) => s.ms);
    console.info(`radial incremental 150 nodes p95 ${percentile95(additions).toFixed(2)} ms`);
    expect(percentile95(additions)).toBeLessThan(INCREMENTAL_P95_LIMIT_MS);
  });

  it.each([7, 8])(
    'bounds layout time at 500 nodes on the seed %i churn shape',
    async (seed) => {
      const engine = createElkEngine();
      let graph = generateChain({ nodeCount: 500, seed });
      const churn = generateChurnScript(graph, { seed: seed + 1, operationCount: 30 });
      const durations: number[] = [];
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
      console.info(
        `radial full 500 nodes seed ${String(seed)}: p95 ${percentile95(durations).toFixed(0)} ms, max ${Math.max(...durations).toFixed(0)} ms`,
      );
      expect(percentile95(durations)).toBeLessThan(FULL_P95_LIMIT_MS_AT_500);
      expect(Math.max(...durations)).toBeLessThan(SINGLE_REQUEST_LIMIT_MS_AT_500);
    },
    120_000,
  );
});
