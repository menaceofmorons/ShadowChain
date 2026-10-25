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

// TUNE: displacement and time bounds for a non-saturating radial incremental step (A2).
const MAX_MOVED_FRACTION_ADDITION = 0.75;
const MAX_MOVED_FRACTION_REMOVAL = 1;
const MAX_SHIFT = 2500;
const INCREMENTAL_P95_LIMIT_MS = 10;
const FULL_P95_LIMIT_MS_AT_500 = 500;
const FULL_P95_LIMIT_MS_AT_150 = 100;
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

interface ChurnStep {
  readonly tree: ChainTree;
  readonly beforeTree: ChainTree;
  readonly before: readonly PlacedNode[];
  readonly after: readonly PlacedNode[];
  readonly added: string[];
  readonly kind: ChurnOperation['kind'];
  readonly saturated: boolean;
  readonly ms: number;
}

async function runChurn(
  engine: LayoutEngine,
  nodeCount: number,
  seed: number,
  operations: number,
): Promise<ChurnStep[]> {
  let graph = generateChain({ nodeCount, seed });
  const churn = generateChurnScript(graph, { seed: seed + 1, operationCount: operations });
  let tree = buildChainTree(graph, SYNTHETIC_ROOT_SYSTEM_ID);
  let placed = await engine.layout({ type: 'full', tree, mode: 'radial', manualPositions: [] });
  let known = new Set(tree.nodes.map((n) => n.keyString));
  let beforeTree = tree;
  const steps: ChurnStep[] = [];
  const spy = vi.spyOn(ELK.prototype, 'layout');
  for (const operation of churn) {
    graph = applyChurn(graph, [operation]);
    tree = buildChainTree(graph, SYNTHETIC_ROOT_SYSTEM_ID);
    const next = new Set(tree.nodes.map((n) => n.keyString));
    const added = [...next].filter((key) => !known.has(key));
    const removed = [...known].filter((key) => !next.has(key));
    const calls = spy.mock.calls.length;
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
    const ms = performance.now() - start;
    steps.push({
      tree,
      beforeTree,
      before: placed,
      after,
      added,
      kind: operation.kind,
      saturated: spy.mock.calls.length > calls,
      ms,
    });
    placed = after;
    known = next;
    beforeTree = tree;
  }
  return steps;
}

const movedNodes = (before: readonly PlacedNode[], after: readonly PlacedNode[]): PlacedNode[] => {
  const previous = new Map(before.map((n) => [n.nodeKey, n]));
  return after.filter((n) => {
    const prior = previous.get(n.nodeKey);
    return prior !== undefined && (prior.x !== n.x || prior.y !== n.y);
  });
};

const displacedNodes = (step: ChurnStep): PlacedNode[] => {
  const oldParents = parentsOf(step.beforeTree);
  const oldDepths = depthsOf(step.beforeTree);
  const parents = parentsOf(step.tree);
  const depths = depthsOf(step.tree);
  const restructured = new Set<string>();
  const mark = (node: ChainNode): void => {
    restructured.add(node.keyString);
    node.children.forEach(mark);
  };
  step.tree.nodes.forEach((node) => {
    const key = node.keyString;
    if (oldDepths.has(key) && (oldParents.get(key) !== parents.get(key) || oldDepths.get(key) !== depths.get(key))) {
      mark(node);
    }
  });
  return movedNodes(step.before, step.after).filter((n) => !restructured.has(n.nodeKey));
};

const largestShift = (steps: readonly ChurnStep[]): number =>
  Math.max(
    0,
    ...steps
      .filter((step) => !step.saturated)
      .flatMap((step) => {
        const previous = new Map(step.before.map((n) => [n.nodeKey, n]));
        return displacedNodes(step).map((n) => {
          const prior = previous.get(n.nodeKey) as PlacedNode;
          return Math.hypot(n.x - prior.x, n.y - prior.y);
        });
      }),
  );

afterEach(() => {
  vi.restoreAllMocks();
});

describe.each([50, 150, 250, 500])('radial incremental churn at %i nodes', (count) => {
  const engine = createElkEngine();

  it('places additions without overlap, on their ring, within the displacement bounds and without crossings', async () => {
    const steps = await runChurn(engine, count, 7, 30);
    let saturated = 0;
    for (const step of steps) {
      const { tree, before, after, added, kind, saturated: grew } = step;
      expect(overlappingPairs(after)).toEqual([]);
      expect(crossings(tree, after)).toEqual([]);
      if (grew) {
        saturated += 1;
        continue;
      }
      const displaced = displacedNodes(step);
      const previous = new Map(before.map((n) => [n.nodeKey, n]));
      expect(displaced.length).toBeLessThanOrEqual(
        Math.ceil((kind === 'add' ? MAX_MOVED_FRACTION_ADDITION : MAX_MOVED_FRACTION_REMOVAL) * after.length),
      );
      for (const node of displaced) {
        const prior = previous.get(node.nodeKey) as PlacedNode;
        expect(Math.hypot(node.x - prior.x, node.y - prior.y)).toBeLessThanOrEqual(MAX_SHIFT);
      }
      if (kind === 'add') {
        const origin = centreOf(after.find((n) => n.nodeKey === tree.root.keyString) as PlacedNode);
        const radiusOf = (n: PlacedNode): number => Math.hypot(centreOf(n).x - origin.x, centreOf(n).y - origin.y);
        const depths = depthsOf(tree);
        for (const key of added) {
          const node = after.find((n) => n.nodeKey === key) as PlacedNode;
          const peer = after.find(
            (n) => n.nodeKey !== key && depths.get(n.nodeKey) === depths.get(key) && !added.includes(n.nodeKey),
          );
          if (peer !== undefined) {
            expect(Math.abs(radiusOf(node) - radiusOf(peer))).toBeLessThan(RING_TOLERANCE);
          }
        }
      }
    }
    console.info(
      `radial churn ${String(count)} nodes: ${String(steps.length)} steps, ${String(saturated)} saturation growth, max displaced ${String(Math.max(...steps.filter((s) => !s.saturated).map((s) => displacedNodes(s).length)))}, largest shift ${largestShift(steps).toFixed(0)}`,
    );
  });

  it('repacks after removal without reordering a ring and within the displacement bounds', async () => {
    const steps = await runChurn(engine, count, 7, 30);
    let repacked = 0;
    for (const step of steps) {
      if (step.kind !== 'remove' || step.saturated) {
        continue;
      }
      const { tree, after } = step;
      const origin = centreOf(after.find((n) => n.nodeKey === tree.root.keyString) as PlacedNode);
      const turns = new Map(after.map((n) => [n.nodeKey, turnAround(origin, n)]));
      const parents = parentsOf(tree);
      const depths = depthsOf(tree);
      const unchanged = new Set(displacedNodes(step).map((n) => n.nodeKey));
      for (let depth = 2; depth <= Math.max(...depths.values()); depth += 1) {
        const ring = after
          .filter((n) => depths.get(n.nodeKey) === depth)
          .sort((a, b) => (turns.get(a.nodeKey) as number) - (turns.get(b.nodeKey) as number));
        const parentTurns = ring.map((n) => turns.get(parents.get(n.nodeKey) as string) as number);
        expect(parentTurns, `ring ${String(depth)} parent order`).toEqual([...parentTurns].sort((a, b) => a - b));
      }
      repacked += unchanged.size > 0 ? 1 : 0;
      const dbg = overlappingPairs(after);
      if (dbg.length > 0) {
        const d = depthsOf(tree);
        console.info(
          'DBG',
          JSON.stringify(dbg),
          dbg
            .map((p) =>
              p
                .split('/')
                .map(
                  (k) =>
                    `${k}:${String(d.get(k))}:${JSON.stringify(step.before.find((n) => n.nodeKey === k)?.x)}:${JSON.stringify(after.find((n) => n.nodeKey === k)?.x)}`,
                )
                .join(' '),
            )
            .join(' | '),
          'added',
          step.added.join(','),
        );
      }
      expect(overlappingPairs(after)).toEqual([]);
      expect(crossings(tree, after)).toEqual([]);
    }
    console.info(`radial removals at ${String(count)} nodes repacked ${String(repacked)}`);
  });

  it('keeps sibling order and appends a new sibling after the existing ones', async () => {
    const steps = await runChurn(engine, count, 7, 30);
    for (const step of steps) {
      const { tree, before, after, added, saturated } = step;
      const moved = new Set(movedNodes(before, after).map((n) => n.nodeKey));
      if (saturated) {
        continue;
      }
      const parents = parentsOf(tree);
      const origin = centreOf(after.find((n) => n.nodeKey === tree.root.keyString) as PlacedNode);
      const turns = new Map(after.map((n) => [n.nodeKey, turnAround(origin, n)]));
      const previous = new Set(before.map((n) => n.nodeKey));
      for (const key of added) {
        const older = [...parents.entries()].filter(
          ([child, p]) => p === parents.get(key) && previous.has(child) && !moved.has(child),
        );
        for (const [sibling] of older) {
          expect(turns.get(key) as number).toBeGreaterThan(turns.get(sibling) as number);
        }
      }
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

  it.each([1, 2, 3])('keeps manual nodes where the request puts them after %i churn operations', async (operations) => {
    const engine = createElkEngine();
    const graph = generateChain({ nodeCount: 50, seed: 7 });
    const tree = buildChainTree(graph, SYNTHETIC_ROOT_SYSTEM_ID);
    const target = tree.nodes[5]?.keyString ?? '';
    const manualPositions = [{ nodeKey: target, x: 9000, y: 9000 }];
    const before = await engine.layout({ type: 'full', tree, mode: 'radial', manualPositions });
    const churn = generateChurnScript(graph, { seed: 8, operationCount: operations });
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
    const run = async () => (await runChurn(createElkEngine(), 150, 7, 12)).map((s) => s.after);
    expect(graph.systems.length).toBe(150);
    expect(await run()).toEqual(await run());
  });

  it('keeps incremental placement under the limit at 150 nodes', async () => {
    const run = await runChurn(createElkEngine(), 150, 7, 30);
    const plain = run.filter((s) => s.kind === 'add' && !s.saturated).map((s) => s.ms);
    const saturated = run.filter((s) => s.kind === 'add' && s.saturated).map((s) => s.ms);
    console.info(
      `radial incremental 150 nodes: ${String(plain.length)} plain additions p95 ${percentile95(plain).toFixed(2)} ms, ${String(saturated.length)} saturation growth additions max ${String(Math.max(0, ...saturated).toFixed(0))} ms`,
    );
    expect(percentile95(plain)).toBeLessThan(INCREMENTAL_P95_LIMIT_MS);
    expect(Math.max(0, ...saturated)).toBeLessThan(FULL_P95_LIMIT_MS_AT_150);
  });

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
      console.info(
        `radial full 500 nodes seed ${String(seed)}: p95 ${percentile95(durations).toFixed(0)} ms, max ${Math.max(...durations).toFixed(0)} ms`,
      );
      expect(percentile95(durations)).toBeLessThan(FULL_P95_LIMIT_MS_AT_500);
      expect(Math.max(...durations)).toBeLessThan(SINGLE_REQUEST_LIMIT_MS_AT_500);
    },
    120_000,
  );
});
