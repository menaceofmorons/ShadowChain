import { describe, expect, it } from 'vitest';
import { assertWithinTimeBudget, runHarness } from '../../../harness';
import { buildChainTree } from '../../../model/chainTree';
import type { ChainNode, ChainTree } from '../../../model/types';
import {
  applyChurn,
  generateChain,
  generateChurnScript,
  SYNTHETIC_NODE_COUNTS,
  SYNTHETIC_ROOT_SYSTEM_ID,
} from '../../../synthetic';
import { DEFAULT_ENGINE_OPTIONS } from '../../engineOptions';
import { createLayoutAdapter } from '../../layoutAdapter';
import { createMemoryChannel } from '../../transport';
import type { LayoutMode, LayoutRequestMessage, LayoutResponseMessage, PlacedNode } from '../../types';
import { LAYOUT_MODES } from '../../types';
import { bindEngineToWorker } from '../../workerBootstrap';
import { createElkEngine } from './elkEngine';

const treeOf = (nodeCount: number, seed = 7): ChainTree =>
  buildChainTree(generateChain({ nodeCount, seed }), SYNTHETIC_ROOT_SYSTEM_ID);

const sizeOf = (node: PlacedNode) =>
  node.alias
    ? { w: DEFAULT_ENGINE_OPTIONS.aliasWidth, h: DEFAULT_ENGINE_OPTIONS.aliasHeight }
    : { w: DEFAULT_ENGINE_OPTIONS.nodeWidth, h: DEFAULT_ENGINE_OPTIONS.nodeHeight };

const overlaps = (nodes: readonly PlacedNode[]): string[] => {
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

const centre = (node: PlacedNode) => {
  const { w, h } = sizeOf(node);
  return { x: node.x + w / 2, y: node.y + h / 2 };
};

const full = (tree: ChainTree, mode: LayoutMode, manualPositions: { nodeKey: string; x: number; y: number }[] = []) =>
  ({ type: 'full', tree, mode, manualPositions }) as const;

describe.each(LAYOUT_MODES)('elk engine in %s mode', (mode) => {
  const engine = createElkEngine();

  it.each(SYNTHETIC_NODE_COUNTS)('places %i nodes without overlap, each exactly once', async (count) => {
    const tree = treeOf(count);
    const placed = await engine.layout(full(tree, mode));
    expect(placed.map((n) => n.nodeKey).sort()).toEqual(tree.nodes.map((n) => n.keyString).sort());
    expect(overlaps(placed)).toEqual([]);
    expect(placed.every((n) => n.source === 'auto')).toBe(true);
  });

  it('gives identical output for identical input, across engine instances', async () => {
    const tree = treeOf(150);
    const first = await engine.layout(full(tree, mode));
    const second = await engine.layout(full(tree, mode));
    const third = await createElkEngine().layout(full(tree, mode));
    expect(second).toEqual(first);
    expect(third).toEqual(first);
  });

  it('flags alias leaves and sizes them smaller', async () => {
    const tree = treeOf(150);
    const aliasKeys = new Set(tree.nodes.filter((n) => n.kind === 'alias').map((n) => n.keyString));
    expect(aliasKeys.size).toBeGreaterThan(0);
    const placed = await engine.layout(full(tree, mode));
    expect(new Set(placed.filter((n) => n.alias).map((n) => n.nodeKey))).toEqual(aliasKeys);
  });

  it('echoes manual positions with source manual and leaves others automatic', async () => {
    const tree = treeOf(50);
    const target = tree.nodes[3]?.keyString ?? '';
    const placed = await engine.layout(full(tree, mode, [{ nodeKey: target, x: 12345, y: -678 }]));
    const manual = placed.filter((n) => n.source === 'manual');
    expect(manual).toEqual([expect.objectContaining({ nodeKey: target, x: 12345, y: -678 })]);
    const auto = await engine.layout(full(tree, mode));
    const others = (nodes: readonly PlacedNode[]) => nodes.filter((n) => n.nodeKey !== target);
    expect(others(placed)).toEqual(others(auto));
  });

  it('ignores manual positions for keys not in the tree', async () => {
    const tree = treeOf(50);
    const placed = await engine.layout(full(tree, mode, [{ nodeKey: 'missing', x: 1, y: 1 }]));
    expect(placed.some((n) => n.nodeKey === 'missing')).toBe(false);
  });

  it('answers an incremental request exactly as the full layout of the same tree', async () => {
    const graph = generateChain({ nodeCount: 50, seed: 7 });
    const before = await engine.layout(full(buildChainTree(graph, SYNTHETIC_ROOT_SYSTEM_ID), mode));
    const churn = generateChurnScript(graph, { seed: 4, operationCount: 1 });
    const tree = buildChainTree(applyChurn(graph, churn), SYNTHETIC_ROOT_SYSTEM_ID);
    const incremental = await engine.layout({
      type: 'incremental',
      tree,
      mode,
      manualPositions: [],
      previous: before,
      addedNodeKeys: [],
      removedNodeKeys: [],
    });
    expect(incremental).toEqual(await engine.layout(full(tree, mode)));
  });

  it('runs the churn harness and reports movement and timings', async () => {
    const graph = generateChain({ nodeCount: 50, seed: 3 });
    const report = await runHarness({
      label: 'elk',
      engine,
      graph,
      rootSystemId: SYNTHETIC_ROOT_SYSTEM_ID,
      churn: generateChurnScript(graph, { seed: 4, operationCount: 10 }),
      engineSources: [],
      mode,
    });
    expect(report.nodesMovedPerAddition.count).toBeGreaterThan(0);
    expect(report.nodesMovedPerAddition.perAddition.every((moved) => moved >= 0)).toBe(true);
    expect(() => {
      assertWithinTimeBudget(report.fullLayoutMs, 5000, 'max');
      assertWithinTimeBudget(report.incrementalLayoutMs, 5000, 'max');
    }).not.toThrow();
  });
});

describe('elk engine mode shapes', () => {
  const engine = createElkEngine();

  it('top-down grows mainly downward and left-to-right mainly rightward', async () => {
    const tree = treeOf(50);
    const span = (nodes: readonly PlacedNode[], axis: 'x' | 'y') => {
      const values = nodes.map((n) => n[axis]);
      return Math.max(...values) - Math.min(...values);
    };
    const down = await engine.layout(full(tree, 'top-down'));
    const right = await engine.layout(full(tree, 'left-to-right'));
    const rootKey = tree.root.keyString;
    const rootDown = down.find((n) => n.nodeKey === rootKey) as PlacedNode;
    const rootRight = right.find((n) => n.nodeKey === rootKey) as PlacedNode;
    expect(down.every((n) => n.y >= rootDown.y)).toBe(true);
    expect(right.every((n) => n.x >= rootRight.x)).toBe(true);
    expect(span(down, 'y')).toBeGreaterThan(0);
    expect(span(right, 'x')).toBeGreaterThan(0);
  });

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

  it.each(SYNTHETIC_NODE_COUNTS)(
    'radial puts every level on one ring at a fixed radius step at %i nodes',
    async (count) => {
      const tree = treeOf(count);
      const depths = depthsOf(tree);
      const placed = await engine.layout(full(tree, 'radial'));
      const rootCentre = centre(placed.find((n) => n.nodeKey === tree.root.keyString) as PlacedNode);
      const ringByDepth = new Map<number, number[]>();
      for (const node of placed) {
        const { x, y } = centre(node);
        const depth = depths.get(node.nodeKey) as number;
        ringByDepth.set(depth, [...(ringByDepth.get(depth) ?? []), Math.hypot(x - rootCentre.x, y - rootCentre.y)]);
      }
      const rings = [...ringByDepth.entries()].sort(([a], [b]) => a - b).map(([, radii]) => radii);
      expect(rings.length).toBeGreaterThan(2);
      const step = (rings[1] as number[])[0] as number;
      expect(step).toBeGreaterThan(0);
      rings.forEach((radii, index) => {
        expect(Math.max(...radii) - Math.min(...radii), `ring ${String(index)} spread`).toBeLessThan(1);
        expect(Math.abs((radii[0] as number) - index * step), `ring ${String(index)} step`).toBeLessThan(1);
        if (index > 1) {
          expect(radii[0] as number).toBeGreaterThan((rings[index - 1] as number[])[0] as number);
        }
      });
    },
  );

  const radialTurns = async (tree: ChainTree) => {
    const placed = await engine.layout(full(tree, 'radial'));
    const centres = new Map(placed.map((n) => [n.nodeKey, centre(n)]));
    const rootCentre = centres.get(tree.root.keyString) as { x: number; y: number };
    const turnOf = (key: string): number => {
      const c = centres.get(key) as { x: number; y: number };
      const turn = Math.atan2(c.y - rootCentre.y, c.x - rootCentre.x);
      return turn < 0 ? turn + 2 * Math.PI : turn;
    };
    return { placed, turnOf };
  };

  const levelsOf = (tree: ChainTree): ChainNode[][] => {
    const levels: ChainNode[][] = [];
    const walk = (node: ChainNode, depth: number): void => {
      (levels[depth] ??= []).push(node);
      node.children.forEach((child) => {
        walk(child, depth + 1);
      });
    };
    walk(tree.root, 0);
    return levels;
  };

  it.each(SYNTHETIC_NODE_COUNTS)(
    'radial keeps parent order on every ring so connectors never cross at %i nodes',
    async (count) => {
      const tree = treeOf(count);
      const { turnOf } = await radialTurns(tree);
      const levels = levelsOf(tree);
      const parentOf = new Map<string, string>();
      tree.nodes.forEach((node) => {
        node.children.forEach((child) => parentOf.set(child.keyString, node.keyString));
      });
      levels.slice(2).forEach((level, offset) => {
        const parentRank = new Map(
          (levels[offset + 1] as ChainNode[])
            .map((node) => ({ key: node.keyString, turn: turnOf(node.keyString) }))
            .sort((a, b) => a.turn - b.turn)
            .map(({ key }, rank) => [key, rank]),
        );
        const ranks = level
          .map((node) => ({
            turn: turnOf(node.keyString),
            rank: parentRank.get(parentOf.get(node.keyString) as string) as number,
          }))
          .sort((a, b) => a.turn - b.turn)
          .map(({ rank }) => rank);
        expect(ranks, `ring ${String(offset + 2)}`).toEqual([...ranks].sort((a, b) => a - b));
      });
    },
  );

  it.each(SYNTHETIC_NODE_COUNTS)('radial spreads the first ring evenly around the root at %i nodes', async (count) => {
    const tree = treeOf(count);
    const { turnOf } = await radialTurns(tree);
    const turns = tree.root.children.map((child) => turnOf(child.keyString)).sort((a, b) => a - b);
    turns.forEach((turn, index) => {
      const previous = index === 0 ? (turns.at(-1) as number) - 2 * Math.PI : (turns[index - 1] as number);
      expect(turn - previous).toBeCloseTo((2 * Math.PI) / turns.length, 2);
    });
  });

  it('radial stays compact at 150 nodes', async () => {
    const placed = await engine.layout(full(treeOf(150), 'radial'));
    const extent = (axis: 'x' | 'y') =>
      Math.max(...placed.map((n) => n[axis])) - Math.min(...placed.map((n) => n[axis]));
    expect(Math.max(extent('x'), extent('y'))).toBeLessThan(6000);
  });
});

describe('elk engine through the worker host', () => {
  it('round-trips requests in every mode over the memory channel', async () => {
    const channel = createMemoryChannel<LayoutRequestMessage, LayoutResponseMessage>();
    bindEngineToWorker(createElkEngine(), channel.b);
    const adapter = createLayoutAdapter(channel.a);
    const tree = treeOf(50);
    for (const mode of LAYOUT_MODES) {
      const viaWorker = await adapter.layout(full(tree, mode));
      expect(viaWorker).toEqual(await createElkEngine().layout(full(tree, mode)));
    }
  });
});

describe('elk engine sources', () => {
  const sources = import.meta.glob('./*.ts', { query: '?raw', import: 'default', eager: true }) as Record<
    string,
    string
  >;

  it('keeps the worker entry graph inside map/layout and map/model plus elkjs', () => {
    const specifiers = Object.entries(sources)
      .filter(([file]) => !file.endsWith('.test.ts'))
      .flatMap(([, source]) => [...source.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1] ?? ''));
    expect(specifiers.length).toBeGreaterThan(0);
    for (const specifier of specifiers) {
      const allowed =
        specifier.startsWith('elkjs/') ||
        specifier === './elkEngine' ||
        /^\.\.\/\.\.\/(?!.*canvas)/.test(specifier) ||
        /^\.\.\/\.\.\/\.\.\/model\//.test(specifier);
      expect(allowed, specifier).toBe(true);
    }
  });
});
