import { describe, expect, it } from 'vitest';
import { collapseChainTree, removeConnectionFromTree } from '../../../model/chainOps';
import { buildChainTree } from '../../../model/chainTree';
import type { ChainGraph, ChainNode, ChainTree } from '../../../model/types';
import { generateChain, SYNTHETIC_ROOT_SYSTEM_ID } from '../../../synthetic';
import { DEFAULT_ENGINE_OPTIONS } from '../../engineOptions';
import type { LayoutMode, LayoutRequest, ManualPosition, PlacedNode } from '../../types';
import { createTidyTreeEngine } from './tidyTreeEngine';

const OPTIONS = DEFAULT_ENGINE_OPTIONS;
const TREE_MODES = ['top-down', 'left-to-right'] as const;
const GRAPH = generateChain({ nodeCount: 150, seed: 11 });
const OFFSET = { x: 300, y: 200 };

const engine = createTidyTreeEngine();
const treeOf = (graph: ChainGraph): ChainTree => buildChainTree(graph, SYNTHETIC_ROOT_SYSTEM_ID);
const byKey = (nodes: readonly PlacedNode[]): Map<string, PlacedNode> => new Map(nodes.map((n) => [n.nodeKey, n]));
const subtreeKeys = (node: ChainNode): string[] => node.children.flatMap((c) => [c.keyString, ...subtreeKeys(c)]);
const acrossOf = (node: PlacedNode, mode: LayoutMode): number => (mode === 'top-down' ? node.x : node.y);
const alongOf = (node: PlacedNode, mode: LayoutMode): number => (mode === 'top-down' ? node.y : node.x);

const full = (
  tree: ChainTree,
  mode: LayoutMode,
  manualPositions: readonly ManualPosition[] = [],
  rootOffset?: number,
): LayoutRequest => ({
  type: 'full',
  tree,
  mode,
  manualPositions,
  ...(rootOffset === undefined ? {} : { rootOffset }),
});

const layoutOf = async (request: LayoutRequest): Promise<PlacedNode[]> => [...(await engine.layout(request))];

const sizeOf = (node: PlacedNode): { w: number; h: number } => {
  if (node.alias) return { w: OPTIONS.aliasWidth, h: OPTIONS.aliasHeight };
  if (node.hiddenCount !== null) return { w: OPTIONS.collapsedWidth, h: OPTIONS.collapsedHeight };
  return { w: OPTIONS.nodeWidth, h: OPTIONS.nodeHeight };
};

const countOverlaps = (nodes: readonly PlacedNode[]): number => {
  let overlaps = 0;
  nodes.forEach((a, i) => {
    for (const b of nodes.slice(i + 1)) {
      const sa = sizeOf(a);
      const sb = sizeOf(b);
      if (a.x < b.x + sb.w && b.x < a.x + sa.w && a.y < b.y + sb.h && b.y < a.y + sa.h) overlaps += 1;
    }
  });
  return overlaps;
};

const interior = (tree: ChainTree): ChainNode =>
  tree.nodes.find(
    (node) => node.keyString !== tree.root.keyString && node.kind === 'primary' && subtreeKeys(node).length >= 3,
  ) as ChainNode;

const hasKind = (kind: ChainNode['kind']) => (node: ChainNode) => node.kind === kind;
const isParallel = (node: ChainNode) => (node.parentEdge?.parallelConnectionIds.length ?? 0) > 0;

describe('relative subtrees: a manual node carries its auto descendants', () => {
  for (const mode of TREE_MODES) {
    it(`${mode}: descendants follow the moved node by the same offset and nothing else changes`, async () => {
      const tree = treeOf(GRAPH);
      const base = byKey(await layoutOf(full(tree, mode)));
      const target = interior(tree);
      const start = base.get(target.keyString) as PlacedNode;
      const manual = [{ nodeKey: target.keyString, x: start.x + OFFSET.x, y: start.y + OFFSET.y }];
      const moved = byKey(await layoutOf(full(tree, mode, manual)));
      const carried = new Set(subtreeKeys(target));
      expect(carried.size).toBeGreaterThan(1);
      expect(moved.get(target.keyString)).toMatchObject({ x: manual[0]?.x, y: manual[0]?.y, source: 'manual' });
      for (const [key, node] of base) {
        const after = moved.get(key) as PlacedNode;
        if (key === target.keyString) continue;
        const expected = carried.has(key) ? { x: node.x + OFFSET.x, y: node.y + OFFSET.y } : { x: node.x, y: node.y };
        expect(after, key).toMatchObject({ ...expected, source: 'auto' });
      }
    });

    it(`${mode}: a pinned descendant stays put and carries its own descendants`, async () => {
      const tree = treeOf(GRAPH);
      const base = byKey(await layoutOf(full(tree, mode)));
      const parent = interior(tree);
      const child = parent.children.find((c) => c.children.length > 0) as ChainNode;
      const parentStart = base.get(parent.keyString) as PlacedNode;
      const childStart = base.get(child.keyString) as PlacedNode;
      const manual = [
        { nodeKey: parent.keyString, x: parentStart.x + OFFSET.x, y: parentStart.y },
        { nodeKey: child.keyString, x: childStart.x, y: childStart.y + OFFSET.y },
      ];
      const moved = byKey(await layoutOf(full(tree, mode, manual)));
      for (const key of subtreeKeys(child)) {
        const before = base.get(key) as PlacedNode;
        expect(moved.get(key), key).toMatchObject({ x: before.x, y: before.y + OFFSET.y });
      }
      const sibling = parent.children.find((c) => c !== child);
      if (sibling !== undefined) {
        const before = base.get(sibling.keyString) as PlacedNode;
        expect(moved.get(sibling.keyString)).toMatchObject({ x: before.x + OFFSET.x, y: before.y });
      }
    });

    it(`${mode}: an incremental request that moves a node carries its descendants and leaves others`, async () => {
      const tree = treeOf(GRAPH);
      const previous = await layoutOf(full(tree, mode));
      const base = byKey(previous);
      const target = interior(tree);
      const start = base.get(target.keyString) as PlacedNode;
      const manual = [{ nodeKey: target.keyString, x: start.x + OFFSET.x, y: start.y + OFFSET.y }];
      const moved = byKey(
        await layoutOf({
          type: 'incremental',
          tree,
          mode,
          manualPositions: manual,
          previous,
          addedNodeKeys: [],
          removedNodeKeys: [],
        }),
      );
      const carried = new Set(subtreeKeys(target));
      for (const [key, node] of base) {
        if (key === target.keyString) continue;
        const expected = carried.has(key) ? { x: node.x + OFFSET.x, y: node.y + OFFSET.y } : { x: node.x, y: node.y };
        expect(moved.get(key), key).toMatchObject(expected);
      }
    });
  }
});

describe('collapse: a collapsed branch lays out as one +N node', () => {
  for (const mode of TREE_MODES) {
    it(`${mode}: the +N leaf carries the hidden count and the target carries the collapsed state`, async () => {
      const tree = treeOf(GRAPH);
      const target = interior(tree);
      const hidden = subtreeKeys(target).length;
      const collapsed = collapseChainTree(tree, new Set([target.keyString]));
      const placed = await layoutOf({ ...full(collapsed, mode), collapsedKeys: [target.keyString] });
      expect(placed).toHaveLength(tree.nodes.length - hidden + 1);
      const leaf = placed.find((node) => node.hiddenCount !== null) as PlacedNode;
      expect(leaf.hiddenCount).toBe(hidden);
      expect(byKey(placed).get(target.keyString)).toMatchObject({ collapsed: true, hiddenCount: null });
      expect(placed.filter((node) => node.collapsed)).toHaveLength(1);
      expect(countOverlaps(placed)).toBe(0);
      const parent = byKey(placed).get(target.keyString) as PlacedNode;
      expect(alongOf(leaf, mode)).toBeGreaterThan(alongOf(parent, mode));
    });

    it(`${mode}: collapse then expand through incremental requests stays overlap-free and restores the node set`, async () => {
      const tree = treeOf(GRAPH);
      const target = interior(tree);
      const original = await layoutOf(full(tree, mode));
      const collapsedTree = collapseChainTree(tree, new Set([target.keyString]));
      const leafKey = collapsedTree.nodes.find((node) => node.kind === 'collapsed')?.keyString as string;
      const afterCollapse = await layoutOf({
        type: 'incremental',
        tree: collapsedTree,
        mode,
        manualPositions: [],
        collapsedKeys: [target.keyString],
        previous: original,
        addedNodeKeys: [leafKey],
        removedNodeKeys: subtreeKeys(target),
      });
      expect(afterCollapse).toHaveLength(collapsedTree.nodes.length);
      expect(countOverlaps(afterCollapse)).toBe(0);
      const afterExpand = await layoutOf({
        type: 'incremental',
        tree,
        mode,
        manualPositions: [],
        previous: afterCollapse,
        addedNodeKeys: subtreeKeys(target),
        removedNodeKeys: [leafKey],
      });
      expect(afterExpand.map((node) => node.nodeKey).sort()).toEqual(tree.nodes.map((node) => node.keyString).sort());
      expect(countOverlaps(afterExpand)).toBe(0);
    });
  }
});

describe('Tidy: a request without manual positions is a full layout', () => {
  for (const mode of TREE_MODES) {
    it(`${mode}: gives the same output as a fresh layout whatever was manual before`, async () => {
      const tree = treeOf(GRAPH);
      const fresh = await layoutOf(full(tree, mode));
      const target = interior(tree);
      const start = byKey(fresh).get(target.keyString) as PlacedNode;
      await layoutOf(full(tree, mode, [{ nodeKey: target.keyString, x: start.x + 90, y: start.y + 90 }]));
      const tidied = await createTidyTreeEngine().layout(full(tree, mode, []));
      expect(tidied).toEqual(fresh);
      expect(tidied.every((node) => node.source === 'auto')).toBe(true);
    });
  }
});

describe('root offset', () => {
  const shiftOf = (mode: LayoutMode, amount: number) =>
    mode === 'top-down' ? { x: amount, y: 0 } : { x: 0, y: amount };

  for (const mode of TREE_MODES) {
    it(`${mode}: a full layout moves every node across by the offset and nothing along`, async () => {
      const tree = treeOf(GRAPH);
      const base = await layoutOf(full(tree, mode));
      const moved = byKey(await layoutOf(full(tree, mode, [], -75)));
      const shift = shiftOf(mode, -75);
      for (const node of base) {
        expect(moved.get(node.nodeKey), node.nodeKey).toMatchObject({ x: node.x + shift.x, y: node.y + shift.y });
      }
    });

    it(`${mode}: a manual node stays and its descendants stay with it when the root moves`, async () => {
      const tree = treeOf(GRAPH);
      const base = byKey(await layoutOf(full(tree, mode)));
      const target = interior(tree);
      const start = base.get(target.keyString) as PlacedNode;
      const manual = [{ nodeKey: target.keyString, x: start.x + 20, y: start.y + 20 }];
      const before = byKey(await layoutOf(full(tree, mode, manual)));
      const after = byKey(await layoutOf(full(tree, mode, manual, 60)));
      const carried = new Set([target.keyString, ...subtreeKeys(target)]);
      const shift = shiftOf(mode, 60);
      for (const [key, node] of before) {
        const expected = carried.has(key) ? { x: node.x, y: node.y } : { x: node.x + shift.x, y: node.y + shift.y };
        expect(after.get(key), key).toMatchObject(expected);
      }
    });

    it(`${mode}: an incremental request with a new offset moves the layout and back again`, async () => {
      const tree = treeOf(GRAPH);
      const base = await layoutOf(full(tree, mode));
      const request = (previous: readonly PlacedNode[], rootOffset: number): LayoutRequest => ({
        type: 'incremental',
        tree,
        mode,
        manualPositions: [],
        rootOffset,
        previous,
        addedNodeKeys: [],
        removedNodeKeys: [],
      });
      const moved = await layoutOf(request(base, 120));
      expect(moved).toEqual(await layoutOf(full(tree, mode, [], 120)));
      expect(await layoutOf(request(moved, 0))).toEqual(base);
      expect(acrossOf(byKey(moved).get(tree.root.keyString) as PlacedNode, mode)).toBe(
        acrossOf(byKey(base).get(tree.root.keyString) as PlacedNode, mode) + 120,
      );
    });
  }
});

describe('alias leaves, parallel connections and ? nodes keep stable placement', () => {
  const categories: [string, (node: ChainNode) => boolean][] = [
    ['alias leaf', hasKind('alias')],
    ['unknown-end (?) node', hasKind('unknownEnd')],
    ['parallel-connection node', isParallel],
  ];

  const withExtraLeaf = (graph: ChainGraph, parentSystem: number): ChainGraph => {
    const id = Math.max(...graph.systems.map((s) => s.id)) + 1;
    const connectionId = Math.max(...graph.connections.map((c) => c.id)) + 1;
    const createdAt = Math.max(...graph.connections.map((c) => c.createdAt)) + 1;
    return {
      systems: [...graph.systems, { id }],
      connections: [...graph.connections, { id: connectionId, createdAt, endA: parentSystem, endB: id }],
    };
  };

  const keysOf = (tree: ChainTree): Set<string> => new Set(tree.nodes.map((node) => node.keyString));

  const incrementalBetween = async (
    mode: LayoutMode,
    before: ChainTree,
    after: ChainTree,
    previous: readonly PlacedNode[],
  ): Promise<PlacedNode[]> => {
    const known = keysOf(before);
    const next = keysOf(after);
    return layoutOf({
      type: 'incremental',
      tree: after,
      mode,
      manualPositions: [],
      previous,
      addedNodeKeys: [...next].filter((key) => !known.has(key)),
      removedNodeKeys: [...known].filter((key) => !next.has(key)),
    });
  };

  const rowHolds = (tree: ChainTree, placed: readonly PlacedNode[], mode: LayoutMode): boolean => {
    const nodes = byKey(placed);
    return tree.nodes.every((parent) =>
      parent.children.every((child, index) => {
        const node = nodes.get(child.keyString) as PlacedNode;
        const above = nodes.get(parent.keyString) as PlacedNode;
        const gap = alongOf(node, mode) - alongOf(above, mode);
        const orderOk =
          index === 0 ||
          acrossOf(nodes.get(parent.children[index - 1]?.keyString as string) as PlacedNode, mode) <
            acrossOf(node, mode);
        return gap > 0 && orderOk;
      }),
    );
  };

  for (const mode of TREE_MODES) {
    for (const [label, matches] of categories) {
      const tree = treeOf(GRAPH);
      const sample = tree.nodes.filter(matches);

      it(`${mode}: ${label}: the sample exists`, () => {
        expect(sample.length).toBeGreaterThan(0);
      });

      it(`${mode}: ${label}: an unrelated addition moves nothing`, async () => {
        const previous = await layoutOf(full(tree, mode));
        const leaf = tree.nodes.filter((n) => n.kind === 'primary' && n.children.length === 0).at(-1) as ChainNode;
        const after = treeOf(withExtraLeaf(GRAPH, leaf.systemId as number));
        const placed = await incrementalBetween(mode, tree, after, previous);
        const next = byKey(placed);
        for (const node of sample) {
          expect(next.get(node.keyString), node.keyString).toMatchObject(byKey(previous).get(node.keyString) ?? {});
        }
        expect(countOverlaps(placed)).toBe(0);
        expect(rowHolds(after, placed, mode)).toBe(true);
      });

      it(`${mode}: ${label}: removing a leaf only slides nodes across and keeps rows, order and clearance`, async () => {
        const previous = await layoutOf(full(tree, mode));
        const leaf = tree.nodes.filter((n) => n.kind === 'primary' && n.children.length === 0).at(-1) as ChainNode;
        const after = removeConnectionFromTree(GRAPH, SYNTHETIC_ROOT_SYSTEM_ID, [
          leaf.parentEdge?.connectionId as number,
        ]);
        const placed = await incrementalBetween(mode, tree, after, previous);
        const before = byKey(previous);
        const next = byKey(placed);
        for (const node of sample) {
          const now = next.get(node.keyString);
          if (now !== undefined) {
            expect(alongOf(now, mode), node.keyString).toBe(alongOf(before.get(node.keyString) as PlacedNode, mode));
          }
        }
        expect(countOverlaps(placed)).toBe(0);
        expect(rowHolds(after, placed, mode)).toBe(true);
      });

      it(`${mode}: ${label}: collapsing an unrelated branch keeps rows, order and clearance`, async () => {
        const previous = await layoutOf(full(tree, mode));
        const target = interior(tree);
        const collapsedTree = collapseChainTree(tree, new Set([target.keyString]));
        const placed = await incrementalBetween(mode, tree, collapsedTree, previous);
        const before = byKey(previous);
        const next = byKey(placed);
        for (const node of sample) {
          const now = next.get(node.keyString);
          if (now !== undefined) {
            expect(alongOf(now, mode), node.keyString).toBe(alongOf(before.get(node.keyString) as PlacedNode, mode));
          }
        }
        expect(countOverlaps(placed)).toBe(0);
        expect(rowHolds(collapsedTree, placed, mode)).toBe(true);
      });

      it(`${mode}: ${label}: Tidy returns the fresh layout`, async () => {
        const fresh = await layoutOf(full(tree, mode));
        const manual = sample.map((node) => {
          const placed = byKey(fresh).get(node.keyString) as PlacedNode;
          return { nodeKey: node.keyString, x: placed.x + 13, y: placed.y + 13 };
        });
        const pinned = byKey(await layoutOf(full(tree, mode, manual)));
        for (const node of sample) {
          expect(pinned.get(node.keyString)?.source).toBe('manual');
        }
        expect(await layoutOf(full(tree, mode, []))).toEqual(fresh);
      });
    }
  }
});

describe('incremental requests that combine a root or manual move with a removal', () => {
  const lastLeaf = (tree: ChainTree): ChainNode =>
    tree.nodes.filter((n) => n.kind === 'primary' && n.children.length === 0).at(-1) as ChainNode;

  const removalRequest = (
    mode: LayoutMode,
    previous: readonly PlacedNode[],
    before: ChainTree,
    extra: { manualPositions?: readonly ManualPosition[]; rootOffset?: number },
  ): LayoutRequest => {
    const after = removeConnectionFromTree(GRAPH, SYNTHETIC_ROOT_SYSTEM_ID, [
      lastLeaf(before).parentEdge?.connectionId as number,
    ]);
    const known = new Set(after.nodes.map((n) => n.keyString));
    return {
      type: 'incremental',
      tree: after,
      mode,
      manualPositions: [],
      previous,
      addedNodeKeys: [],
      removedNodeKeys: before.nodes.map((n) => n.keyString).filter((key) => !known.has(key)),
      ...extra,
    };
  };

  for (const mode of TREE_MODES) {
    it(`${mode}: a removal repack with a root move equals the removal alone shifted by the offset`, async () => {
      const tree = treeOf(GRAPH);
      const previous = await layoutOf(full(tree, mode));
      const plain = byKey(await layoutOf(removalRequest(mode, previous, tree, {})));
      const moved = await layoutOf(removalRequest(mode, previous, tree, { rootOffset: 60 }));
      const dx = mode === 'top-down' ? 60 : 0;
      const dy = mode === 'top-down' ? 0 : 60;
      expect(moved).toHaveLength(plain.size);
      for (const node of moved) {
        const alone = plain.get(node.nodeKey) as PlacedNode;
        expect(node, node.nodeKey).toMatchObject({ x: alone.x + dx, y: alone.y + dy });
      }
    });

    it(`${mode}: a removal repack with a manual move repacks as without it and carries the moved subtree`, async () => {
      const tree = treeOf(GRAPH);
      const previous = await layoutOf(full(tree, mode));
      const target = interior(tree);
      const start = byKey(previous).get(target.keyString) as PlacedNode;
      const manualPositions = [{ nodeKey: target.keyString, x: start.x + OFFSET.x, y: start.y + OFFSET.y }];
      const plain = byKey(await layoutOf(removalRequest(mode, previous, tree, {})));
      const moved = byKey(await layoutOf(removalRequest(mode, previous, tree, { manualPositions })));
      const carried = new Set(subtreeKeys(target));
      for (const [key, node] of moved) {
        if (key === target.keyString) continue;
        const alone = plain.get(key) as PlacedNode;
        const expected = carried.has(key)
          ? { x: alone.x + OFFSET.x, y: alone.y + OFFSET.y }
          : { x: alone.x, y: alone.y };
        expect(node, key).toMatchObject(expected);
      }
    });

    it(`${mode}: resetting a manual root returns the layout to the auto positions`, async () => {
      const tree = treeOf(GRAPH);
      const base = await layoutOf(full(tree, mode));
      const root = byKey(base).get(tree.root.keyString) as PlacedNode;
      const pinned = await layoutOf(
        full(tree, mode, [{ nodeKey: tree.root.keyString, x: root.x + 50, y: root.y + 70 }]),
      );
      const incremental = (rootOffset?: number): LayoutRequest => ({
        type: 'incremental',
        tree,
        mode,
        manualPositions: [],
        previous: pinned,
        addedNodeKeys: [],
        removedNodeKeys: [],
        ...(rootOffset === undefined ? {} : { rootOffset }),
      });
      expect(await layoutOf(incremental())).toEqual(base);
      expect(await layoutOf(incremental(40))).toEqual(await layoutOf(full(tree, mode, [], 40)));
    });
  }
});
