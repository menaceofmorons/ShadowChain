import { describe, expect, it } from 'vitest';
import { newNodeOutcomeIsCorrect } from '../../../fixtures/wanderer/assertions';
import { wanderer553 } from '../../../fixtures/wanderer/fixtures';
import { buildChainTree } from '../../../model/chainTree';
import type { ChainGraph, ChainNode, ChainTree } from '../../../model/types';
import {
  generateChain,
  generateChurnScript,
  SYNTHETIC_NODE_COUNTS,
  SYNTHETIC_ROOT_SYSTEM_ID,
} from '../../../synthetic';
import type { ChurnOperation } from '../../../synthetic';
import { DEFAULT_ENGINE_OPTIONS } from '../../engineOptions';
import { filterManualPositions } from '../../manualPositions';
import type { LayoutMode, ManualPosition, PlacedNode } from '../../types';
import { createTidyTreeEngine } from './tidyTreeEngine';

const A2_MAX_NODES_MOVED_PER_ADDITION = 40;
const INCREMENTAL_P95_BUDGET_MS = 10;
const OPTIONS = DEFAULT_ENGINE_OPTIONS;
const TREE_MODES = ['top-down', 'left-to-right'] as const;

const engine = createTidyTreeEngine();

const treeOf = (graph: ChainGraph): ChainTree => buildChainTree(graph, SYNTHETIC_ROOT_SYSTEM_ID);
const byKey = (nodes: readonly PlacedNode[]): Map<string, PlacedNode> => new Map(nodes.map((n) => [n.nodeKey, n]));
const acrossOf = (node: PlacedNode, mode: LayoutMode): number => (mode === 'top-down' ? node.x : node.y);
const alongOf = (node: PlacedNode, mode: LayoutMode): number => (mode === 'top-down' ? node.y : node.x);
const acrossSize = (mode: LayoutMode): number => (mode === 'top-down' ? OPTIONS.nodeWidth : OPTIONS.nodeHeight);
const alongSize = (mode: LayoutMode): number => (mode === 'top-down' ? OPTIONS.nodeHeight : OPTIONS.nodeWidth);

const sizeOf = (node: PlacedNode): { w: number; h: number } =>
  node.alias ? { w: OPTIONS.aliasWidth, h: OPTIONS.aliasHeight } : { w: OPTIONS.nodeWidth, h: OPTIONS.nodeHeight };

const countOverlaps = (nodes: readonly PlacedNode[]): number => {
  let overlaps = 0;
  for (let i = 0; i < nodes.length; i += 1) {
    for (let j = i + 1; j < nodes.length; j += 1) {
      const a = nodes[i] as PlacedNode;
      const b = nodes[j] as PlacedNode;
      const sa = sizeOf(a);
      const sb = sizeOf(b);
      if (a.x < b.x + sb.w && b.x < a.x + sa.w && a.y < b.y + sb.h && b.y < a.y + sa.h) {
        overlaps += 1;
      }
    }
  }
  return overlaps;
};

const movedKeys = (before: readonly PlacedNode[], after: readonly PlacedNode[]): string[] => {
  const next = byKey(after);
  return before
    .filter((node) => {
      const other = next.get(node.nodeKey);
      return other !== undefined && (other.x !== node.x || other.y !== node.y);
    })
    .map((node) => node.nodeKey);
};

const siblingOrderViolations = (
  tree: ChainTree,
  placed: readonly PlacedNode[],
  manual: ReadonlySet<string>,
  mode: LayoutMode,
): number => {
  const nodes = byKey(placed);
  let violations = 0;
  for (const parent of tree.nodes) {
    const autos = parent.children.filter((child) => !manual.has(child.keyString));
    for (let i = 1; i < autos.length; i += 1) {
      const left = nodes.get((autos[i - 1] as ChainNode).keyString) as PlacedNode;
      const right = nodes.get((autos[i] as ChainNode).keyString) as PlacedNode;
      if (acrossOf(left, mode) >= acrossOf(right, mode)) {
        violations += 1;
      }
    }
  }
  return violations;
};

const subtreeKeys = (node: ChainNode): string[] => [node.keyString, ...node.children.flatMap(subtreeKeys)];

const laterSiblingSubtrees = (tree: ChainTree, addedKeys: ReadonlySet<string>): Set<string> => {
  const allowed = new Set<string>();
  for (const parent of tree.nodes) {
    parent.children.forEach((child, index) => {
      if (addedKeys.has(child.keyString)) {
        parent.children.slice(index + 1).forEach((sibling) => {
          subtreeKeys(sibling).forEach((key) => allowed.add(key));
        });
      }
    });
  }
  return allowed;
};

const parentsOf = (tree: ChainTree): Map<string, string> =>
  new Map(
    tree.nodes.flatMap((node) => node.children.map((child): [string, string] => [child.keyString, node.keyString])),
  );

const childKeysByParent = (tree: ChainTree): Map<string, string[]> =>
  new Map(tree.nodes.map((node) => [node.keyString, node.children.map((child) => child.keyString)]));

const restructuredChildren = (before: ChainTree, after: ChainTree): string[] => {
  const previous = childKeysByParent(before);
  const known = new Set(before.nodes.map((node) => node.keyString));
  const previousParent = parentsOf(before);
  const restructured: string[] = [];
  for (const [parent, children] of childKeysByParent(after)) {
    const survivors = children.filter((key) => known.has(key));
    const earlier = (previous.get(parent) ?? []).filter((key) => survivors.includes(key));
    const reordered = survivors.some((key, index) => key !== earlier[index]);
    survivors.forEach((key) => {
      if (reordered || previousParent.get(key) !== parent) {
        restructured.push(key);
      }
    });
  }
  return restructured;
};

interface World {
  graph: ChainGraph;
  tree: ChainTree;
  placed: readonly PlacedNode[];
  manual: readonly ManualPosition[];
}

const startWorld = async (nodeCount: number, mode: LayoutMode, seed: number): Promise<World> => {
  const graph = generateChain({ nodeCount, seed });
  const tree = treeOf(graph);
  const free = await engine.layout({ type: 'full', tree, mode, manualPositions: [] });
  const manual = free
    .filter((node, index) => index % 9 === 4 && node.nodeKey !== tree.root.keyString)
    .map((node) => ({ nodeKey: node.nodeKey, x: node.x, y: node.y }));
  const placed = await engine.layout({ type: 'full', tree, mode, manualPositions: manual });
  return { graph, tree, placed, manual };
};

const applyOperation = (graph: ChainGraph, operation: ChurnOperation): ChainGraph => ({
  systems: graph.systems,
  connections:
    operation.kind === 'add'
      ? [...graph.connections, operation.connection]
      : graph.connections.filter((c) => c.id !== operation.connectionId),
});

interface Step {
  previousTree: ChainTree;
  world: World;
  before: readonly PlacedNode[];
  added: string[];
  removed: string[];
  manualKeys: Set<string>;
  elapsedMs: number;
}

const advance = async (world: World, operation: ChurnOperation, mode: LayoutMode): Promise<Step> => {
  const graph = applyOperation(world.graph, operation);
  const tree = treeOf(graph);
  const known = new Set(world.tree.nodes.map((n) => n.keyString));
  const present = new Set(tree.nodes.map((n) => n.keyString));
  const added = [...present].filter((key) => !known.has(key));
  const removed = [...known].filter((key) => !present.has(key));
  const manual = filterManualPositions(tree, world.manual);
  const start = performance.now();
  const placed = await engine.layout({
    type: 'incremental',
    tree,
    mode,
    manualPositions: manual,
    previous: world.placed,
    addedNodeKeys: added,
    removedNodeKeys: removed,
  });
  const elapsedMs = performance.now() - start;
  return {
    previousTree: world.tree,
    world: { graph, tree, placed, manual },
    before: world.placed,
    added,
    removed,
    manualKeys: new Set(manual.map((p) => p.nodeKey)),
    elapsedMs,
  };
};

describe('tidy-tree churn: stable placement with pinned nodes', () => {
  describe.each(TREE_MODES)('%s', (mode) => {
    it.each([...SYNTHETIC_NODE_COUNTS])(
      'keeps sibling order, never overlaps, never moves a manual node and stays within A2 at %i nodes',
      async (nodeCount) => {
        let world = await startWorld(nodeCount, mode, 21);
        expect(world.manual.length).toBeGreaterThan(3);
        const script = generateChurnScript(world.graph, { seed: 31, operationCount: 40 });
        let pureAdditions = 0;
        const exempt = new Set<string>();
        for (const operation of script) {
          const step = await advance(world, operation, mode);
          const { placed, tree, manual } = step.world;
          expect(placed).toHaveLength(tree.nodes.length);
          expect(countOverlaps(placed)).toBe(0);
          const changed = restructuredChildren(step.previousTree, tree);
          const parentChanged = changed.length > 0;
          if (step.removed.length === 0) {
            changed.forEach((key) => exempt.add(key));
          }
          expect(siblingOrderViolations(tree, placed, new Set([...step.manualKeys, ...exempt]), mode)).toBe(0);
          const result = byKey(placed);
          for (const pin of manual) {
            expect(result.get(pin.nodeKey)).toMatchObject({ x: pin.x, y: pin.y, source: 'manual' });
          }
          const moved = movedKeys(step.before, placed);
          expect(moved.every((key) => !step.manualKeys.has(key))).toBe(true);
          if (operation.kind === 'add' && step.removed.length === 0 && !parentChanged) {
            pureAdditions += 1;
            const allowed = laterSiblingSubtrees(tree, new Set(step.added));
            expect(moved.every((key) => allowed.has(key))).toBe(true);
            expect(moved.length).toBeLessThanOrEqual(A2_MAX_NODES_MOVED_PER_ADDITION);
          }
          world = step.world;
        }
        expect(pureAdditions).toBeGreaterThan(5);
      },
    );
  });
});

describe('tidy-tree incremental placement time', () => {
  it('places an addition or removal in under 10 ms at p95 at 150 nodes', async () => {
    const mode = 'top-down';
    let world = await startWorld(150, mode, 3);
    const script = generateChurnScript(world.graph, { seed: 5, operationCount: 100 });
    const durations: number[] = [];
    for (const operation of script) {
      const step = await advance(world, operation, mode);
      durations.push(step.elapsedMs);
      world = step.world;
    }
    const sorted = [...durations].sort((a, b) => a - b);
    const p95 = sorted[Math.ceil(sorted.length * 0.95) - 1] as number;
    expect(p95).toBeLessThan(INCREMENTAL_P95_BUDGET_MS);
  });
});

const chain = (...pairs: [number, number][]): ChainGraph => {
  const systems = [...new Set(pairs.flat())].sort((a, b) => a - b).map((id) => ({ id }));
  return { systems, connections: pairs.map(([endA, endB], i) => ({ id: i + 1, createdAt: i + 1, endA, endB })) };
};

const layoutFull = (graph: ChainGraph, mode: LayoutMode, manual: ManualPosition[] = []) =>
  engine.layout({ type: 'full', tree: treeOf(graph), mode, manualPositions: manual });

const layoutNext = async (
  from: ChainGraph,
  to: ChainGraph,
  previous: readonly PlacedNode[],
  mode: LayoutMode,
  manual: ManualPosition[] = [],
  reorder: (nodes: readonly ChainNode[]) => readonly ChainNode[] = (nodes) => nodes,
): Promise<readonly PlacedNode[]> => {
  const known = new Set(treeOf(from).nodes.map((n) => n.keyString));
  const tree = treeOf(to);
  const present = new Set(tree.nodes.map((n) => n.keyString));
  return engine.layout({
    type: 'incremental',
    tree: { root: tree.root, nodes: reorder(tree.nodes) },
    mode,
    manualPositions: filterManualPositions(tree, manual),
    previous,
    addedNodeKeys: [...present].filter((key) => !known.has(key)),
    removedNodeKeys: [...known].filter((key) => !present.has(key)),
  });
};

describe.each(TREE_MODES)('tidy-tree additions in %s', (mode) => {
  it('adds a K162 three jumps out without moving any placed node or reshuffling siblings', async () => {
    const before = chain([1, 2], [1, 3], [2, 4], [2, 5], [4, 6], [3, 7]);
    const after = chain([1, 2], [1, 3], [2, 4], [2, 5], [4, 6], [3, 7], [4, 8]);
    const placed = await layoutFull(before, mode);
    const next = await layoutNext(before, after, placed, mode);
    expect(movedKeys(placed, next)).toEqual([]);
    expect(countOverlaps(next)).toBe(0);
    const nodes = byKey(next);
    const parent = nodes.get('s:4') as PlacedNode;
    const added = nodes.get('s:8') as PlacedNode;
    const sibling = nodes.get('s:6') as PlacedNode;
    expect(alongOf(added, mode)).toBe(alongOf(parent, mode) + alongSize(mode) + OPTIONS.levelSpacing);
    expect(acrossOf(added, mode)).toBe(acrossOf(sibling, mode) + acrossSize(mode) + OPTIONS.siblingSpacing);
    expect(siblingOrderViolations(treeOf(after), next, new Set(), mode)).toBe(0);
  });

  it('places the Wanderer #553 new system after its last sibling on the child row, not on a neighbour', async () => {
    const full = wanderer553.graph;
    const before = { systems: full.systems, connections: full.connections.slice(0, 3) };
    const placed = await layoutFull(before, mode);
    const next = await layoutNext(before, full, placed, mode);
    const positions = next.map((n) => ({ nodeKey: n.nodeKey, x: n.x, y: n.y }));
    const start = placed.map((n) => ({ nodeKey: n.nodeKey, x: n.x, y: n.y }));
    expect(newNodeOutcomeIsCorrect(start, positions, wanderer553.newNodeKey, { width: 160, height: 48 })).toBe(true);
    const nodes = byKey(next);
    const last = nodes.get('s:4') as PlacedNode;
    const added = nodes.get(wanderer553.newNodeKey) as PlacedNode;
    expect(alongOf(added, mode)).toBe(alongOf(last, mode));
    expect(acrossOf(added, mode)).toBe(acrossOf(last, mode) + acrossSize(mode) + OPTIONS.siblingSpacing);
  });

  it('passes a manual node blocking the child row without pushing it', async () => {
    const before = chain([1, 2], [1, 3], [2, 4]);
    const after = chain([1, 2], [1, 3], [2, 4], [3, 5]);
    const placed = await layoutFull(before, mode);
    const nodes = byKey(placed);
    const under3 = nodes.get('s:3') as PlacedNode;
    const four = nodes.get('s:4') as PlacedNode;
    const pin: ManualPosition =
      mode === 'top-down' ? { nodeKey: 's:4', x: under3.x, y: four.y } : { nodeKey: 's:4', x: four.x, y: under3.y };
    const pinned = await layoutFull(before, mode, [pin]);
    const next = await layoutNext(before, after, pinned, mode, [pin]);
    const result = byKey(next);
    expect(result.get('s:4')).toMatchObject({ x: pin.x, y: pin.y, source: 'manual' });
    const added = result.get('s:5') as PlacedNode;
    expect(acrossOf(added, mode)).toBe(
      acrossOf(result.get('s:4') as PlacedNode, mode) + acrossSize(mode) + OPTIONS.siblingSpacing,
    );
    expect(countOverlaps(next)).toBe(0);
  });

  it('pushes later auto siblings right, in order, when a new node is inserted before them', async () => {
    const before = chain([1, 2], [1, 3], [1, 4]);
    const placed = await layoutFull(before, mode);
    const withLate: ChainGraph = {
      systems: [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }],
      connections: [
        { id: 1, createdAt: 1, endA: 1, endB: 2 },
        { id: 2, createdAt: 2, endA: 1, endB: 3 },
        { id: 3, createdAt: 4, endA: 1, endB: 4 },
        { id: 4, createdAt: 3, endA: 1, endB: 5 },
      ],
    };
    const next = await layoutNext(before, withLate, placed, mode);
    const tree = treeOf(withLate);
    expect(tree.root.children.map((c) => c.keyString)).toEqual(['s:2', 's:3', 's:5', 's:4']);
    expect(siblingOrderViolations(tree, next, new Set(), mode)).toBe(0);
    expect(countOverlaps(next)).toBe(0);
    expect(movedKeys(placed, next)).toEqual(['s:4']);
  });
});

describe.each(TREE_MODES)('tidy-tree removals in %s', (mode) => {
  const step = acrossSize(mode) + OPTIONS.siblingSpacing;

  it('repacks later auto siblings to close the gap and leaves earlier ones in place', async () => {
    const before = chain([1, 2], [1, 3], [1, 4], [1, 5]);
    const after = chain([1, 2], [1, 4], [1, 5]);
    const placed = await layoutFull(before, mode);
    const next = await layoutNext(before, after, placed, mode);
    const was = byKey(placed);
    const now = byKey(next);
    expect(now.has('s:3')).toBe(false);
    for (const key of ['s:1', 's:2']) {
      expect(now.get(key)).toMatchObject({ x: (was.get(key) as PlacedNode).x, y: (was.get(key) as PlacedNode).y });
    }
    for (const key of ['s:4', 's:5']) {
      expect(acrossOf(now.get(key) as PlacedNode, mode)).toBe(acrossOf(was.get(key) as PlacedNode, mode) - step);
      expect(alongOf(now.get(key) as PlacedNode, mode)).toBe(alongOf(was.get(key) as PlacedNode, mode));
    }
  });

  it('drops a removed subtree and repacks the rest with their auto descendants', async () => {
    const before = chain([1, 2], [1, 3], [1, 4], [2, 6], [2, 7], [3, 8]);
    const after = chain([1, 3], [1, 4], [3, 8]);
    const placed = await layoutFull(before, mode);
    const next = await layoutNext(before, after, placed, mode);
    const was = byKey(placed);
    const now = byKey(next);
    for (const gone of ['s:2', 's:6', 's:7']) {
      expect(now.has(gone)).toBe(false);
    }
    expect(now.get('s:1')).toMatchObject({ x: (was.get('s:1') as PlacedNode).x, y: (was.get('s:1') as PlacedNode).y });
    for (const key of ['s:3', 's:4', 's:8']) {
      expect(acrossOf(now.get(key) as PlacedNode, mode)).toBe(acrossOf(was.get(key) as PlacedNode, mode) - step);
    }
    expect(countOverlaps(next)).toBe(0);
  });

  it('never moves a manual node and does not repack an auto node through it', async () => {
    const before = chain([1, 2], [1, 3], [1, 4], [1, 5]);
    const after = chain([1, 2], [1, 4], [1, 5]);
    const placed = await layoutFull(before, mode);
    const was = byKey(placed);
    const four = was.get('s:4') as PlacedNode;
    const pins: ManualPosition[] = [{ nodeKey: 's:4', x: four.x, y: four.y }];
    const pinned = await layoutFull(before, mode, pins);
    const next = await layoutNext(before, after, pinned, mode, pins);
    const now = byKey(next);
    expect(now.get('s:4')).toMatchObject({ x: four.x, y: four.y, source: 'manual' });
    expect(now.get('s:5')).toMatchObject({ x: (was.get('s:5') as PlacedNode).x, y: (was.get('s:5') as PlacedNode).y });
    expect(countOverlaps(next)).toBe(0);
  });

  it('repacks a later auto node while an unrelated manual node further right stays', async () => {
    const before = chain([1, 2], [1, 3], [1, 4], [1, 5]);
    const after = chain([1, 2], [1, 4], [1, 5]);
    const placed = await layoutFull(before, mode);
    const was = byKey(placed);
    const five = was.get('s:5') as PlacedNode;
    const pins: ManualPosition[] = [{ nodeKey: 's:5', x: five.x, y: five.y }];
    const pinned = await layoutFull(before, mode, pins);
    const next = await layoutNext(before, after, pinned, mode, pins);
    const now = byKey(next);
    expect(acrossOf(now.get('s:4') as PlacedNode, mode)).toBe(acrossOf(was.get('s:4') as PlacedNode, mode) - step);
    expect(now.get('s:5')).toMatchObject({ x: five.x, y: five.y, source: 'manual' });
  });
});

describe.each(TREE_MODES)('tidy-tree reparenting in %s', (mode) => {
  const before = chain([1, 2], [2, 3], [1, 4], [4, 3], [3, 5]);
  const after = chain([1, 2], [1, 4], [4, 3], [3, 5]);

  it('re-places a node under its new parent and moves only its auto subtree', async () => {
    const oldTree = treeOf(before);
    expect(oldTree.nodes.find((n) => n.keyString === 's:2')?.children.map((c) => c.keyString)).toEqual(['s:3']);
    const placed = await layoutFull(before, mode);
    const next = await layoutNext(before, after, placed, mode);
    const was = byKey(placed);
    const now = byKey(next);
    expect(
      treeOf(after)
        .nodes.find((n) => n.keyString === 's:4')
        ?.children.map((c) => c.keyString),
    ).toEqual(['s:3']);
    const parent = now.get('s:4') as PlacedNode;
    const moved = now.get('s:3') as PlacedNode;
    expect(alongOf(moved, mode)).toBe(alongOf(parent, mode) + alongSize(mode) + OPTIONS.levelSpacing);
    expect(acrossOf(moved, mode)).toBe(acrossOf(parent, mode));
    const child = now.get('s:5') as PlacedNode;
    const childWas = was.get('s:5') as PlacedNode;
    expect(acrossOf(child, mode) - acrossOf(moved, mode)).toBe(
      acrossOf(childWas, mode) - acrossOf(was.get('s:3') as PlacedNode, mode),
    );
    expect(movedKeys(placed, next).sort()).toEqual(['s:3', 's:5']);
    expect(countOverlaps(next)).toBe(0);
  });

  it('leaves a manual node where it is when its parent changes', async () => {
    const placed = await layoutFull(before, mode);
    const three = byKey(placed).get('s:3') as PlacedNode;
    const pins: ManualPosition[] = [{ nodeKey: 's:3', x: three.x, y: three.y }];
    const pinned = await layoutFull(before, mode, pins);
    const next = await layoutNext(before, after, pinned, mode, pins);
    expect(byKey(next).get('s:3')).toMatchObject({ x: three.x, y: three.y, source: 'manual' });
    expect(movedKeys(pinned, next)).toEqual([]);
  });
});

describe('tidy-tree parent order', () => {
  it.each(TREE_MODES)('gives the same placement when tree nodes arrive children first in %s', async (mode) => {
    const before = chain([1, 2], [1, 3]);
    const after = chain([1, 2], [1, 3], [3, 4], [4, 5], [4, 6]);
    const placed = await layoutFull(before, mode);
    const ordered = await layoutNext(before, after, placed, mode);
    const reversed = await layoutNext(before, after, placed, mode, [], (nodes) => [...nodes].reverse());
    expect(byKey(reversed)).toEqual(byKey(ordered));
    const nodes = byKey(ordered);
    expect(alongOf(nodes.get('s:5') as PlacedNode, mode)).toBeGreaterThan(
      alongOf(nodes.get('s:4') as PlacedNode, mode),
    );
    expect(countOverlaps(ordered)).toBe(0);
  });
});
