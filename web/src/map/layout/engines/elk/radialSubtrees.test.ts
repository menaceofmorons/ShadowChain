// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { collapseChainTree, removeConnectionFromTree } from '../../../model/chainOps';
import { buildChainTree } from '../../../model/chainTree';
import type { ChainGraph, ChainNode, ChainTree } from '../../../model/types';
import { generateChain, SYNTHETIC_ROOT_SYSTEM_ID } from '../../../synthetic';
import { DEFAULT_ENGINE_OPTIONS } from '../../engineOptions';
import type { LayoutRequest, ManualPosition, PlacedNode } from '../../types';
import { createElkEngine } from './elkEngine';

const OPTIONS = DEFAULT_ENGINE_OPTIONS;
const SIZES = [50, 150] as const;
const OFFSET = { x: 300, y: 200 };
const RING_TOLERANCE = 1;

const engine = createElkEngine();
const treeOf = (graph: ChainGraph): ChainTree => buildChainTree(graph, SYNTHETIC_ROOT_SYSTEM_ID);
const byKey = (nodes: readonly PlacedNode[]): Map<string, PlacedNode> => new Map(nodes.map((n) => [n.nodeKey, n]));
const subtreeKeys = (node: ChainNode): string[] => node.children.flatMap((c) => [c.keyString, ...subtreeKeys(c)]);
const hasKind = (kind: ChainNode['kind']) => (node: ChainNode) => node.kind === kind;
const isParallel = (node: ChainNode) => (node.parentEdge?.parallelConnectionIds.length ?? 0) > 0;

const full = (
  tree: ChainTree,
  manualPositions: readonly ManualPosition[] = [],
  rootOffset?: number,
): LayoutRequest => ({
  type: 'full',
  tree,
  mode: 'radial',
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

const centreOf = (node: PlacedNode): { x: number; y: number } => {
  const { w, h } = sizeOf(node);
  return { x: node.x + w / 2, y: node.y + h / 2 };
};

const radiusFrom = (root: PlacedNode, node: PlacedNode): number => {
  const a = centreOf(root);
  const b = centreOf(node);
  return Math.hypot(b.x - a.x, b.y - a.y);
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

const ringsHold = (tree: ChainTree, placed: readonly PlacedNode[]): boolean => {
  const nodes = byKey(placed);
  const root = nodes.get(tree.root.keyString) as PlacedNode;
  const depths = depthsOf(tree);
  const ringOf = new Map<number, number>();
  return tree.nodes.every((node) => {
    const depth = depths.get(node.keyString) as number;
    const radius = radiusFrom(root, nodes.get(node.keyString) as PlacedNode);
    const known = ringOf.get(depth);
    if (known === undefined) {
      ringOf.set(depth, radius);
      return true;
    }
    return Math.abs(known - radius) < RING_TOLERANCE;
  });
};

const near = (node: PlacedNode | undefined, expected: { x: number; y: number }): void => {
  expect(node?.x).toBeCloseTo(expected.x, 1);
  expect(node?.y).toBeCloseTo(expected.y, 1);
};

const interior = (tree: ChainTree): ChainNode =>
  tree.nodes.find(
    (node) => node.keyString !== tree.root.keyString && node.kind === 'primary' && subtreeKeys(node).length >= 3,
  ) as ChainNode;

const incremental = (
  tree: ChainTree,
  previous: readonly PlacedNode[],
  extra: Partial<Extract<LayoutRequest, { type: 'incremental' }>> = {},
): LayoutRequest => ({
  type: 'incremental',
  tree,
  mode: 'radial',
  manualPositions: [],
  previous,
  addedNodeKeys: [],
  removedNodeKeys: [],
  ...extra,
});

for (const size of SIZES) {
  const graph = generateChain({ nodeCount: size, seed: 11 });

  describe(`radial ${String(size)} nodes: a manual node carries its auto descendants`, () => {
    it('descendants follow the moved node by the same offset and nothing else changes', async () => {
      const tree = treeOf(graph);
      const base = byKey(await layoutOf(full(tree)));
      const target = interior(tree);
      const start = base.get(target.keyString) as PlacedNode;
      const manual = [{ nodeKey: target.keyString, x: start.x + OFFSET.x, y: start.y + OFFSET.y }];
      const moved = byKey(await layoutOf(full(tree, manual)));
      const carried = new Set(subtreeKeys(target));
      expect(carried.size).toBeGreaterThan(1);
      expect(moved.get(target.keyString)).toMatchObject({ x: manual[0]?.x, y: manual[0]?.y, source: 'manual' });
      for (const [key, node] of base) {
        if (key === target.keyString) continue;
        const expected = carried.has(key) ? { x: node.x + OFFSET.x, y: node.y + OFFSET.y } : { x: node.x, y: node.y };
        expect(moved.get(key)?.source, key).toBe('auto');
        near(moved.get(key), expected);
      }
    });

    it('a pinned descendant stays put and carries its own descendants', async () => {
      const tree = treeOf(graph);
      const base = byKey(await layoutOf(full(tree)));
      const parent = interior(tree);
      const child = parent.children.find((c) => c.children.length > 0) as ChainNode;
      const parentStart = base.get(parent.keyString) as PlacedNode;
      const childStart = base.get(child.keyString) as PlacedNode;
      const manual = [
        { nodeKey: parent.keyString, x: parentStart.x + OFFSET.x, y: parentStart.y },
        { nodeKey: child.keyString, x: childStart.x, y: childStart.y + OFFSET.y },
      ];
      const moved = byKey(await layoutOf(full(tree, manual)));
      for (const key of subtreeKeys(child)) {
        const before = base.get(key) as PlacedNode;
        near(moved.get(key), { x: before.x, y: before.y + OFFSET.y });
      }
      const sibling = parent.children.find((c) => c !== child);
      if (sibling !== undefined) {
        const before = base.get(sibling.keyString) as PlacedNode;
        near(moved.get(sibling.keyString), { x: before.x + OFFSET.x, y: before.y });
      }
    });

    it('an incremental request that moves a node carries its descendants and leaves others', async () => {
      const tree = treeOf(graph);
      const previous = await layoutOf(full(tree));
      const base = byKey(previous);
      const target = interior(tree);
      const start = base.get(target.keyString) as PlacedNode;
      const manual = [{ nodeKey: target.keyString, x: start.x + OFFSET.x, y: start.y + OFFSET.y }];
      const moved = await layoutOf(incremental(tree, previous, { manualPositions: manual }));
      const movedByKey = byKey(moved);
      const carried = new Set(subtreeKeys(target));
      for (const [key, node] of base) {
        if (key === target.keyString) continue;
        const expected = carried.has(key) ? { x: node.x + OFFSET.x, y: node.y + OFFSET.y } : { x: node.x, y: node.y };
        near(movedByKey.get(key), expected);
      }
      const again = await layoutOf(incremental(tree, moved, { manualPositions: manual }));
      expect(again).toEqual(moved);
    });

    it('a later addition elsewhere keeps the carried subtree where it is', async () => {
      const tree = treeOf(graph);
      const previous = await layoutOf(full(tree));
      const target = interior(tree);
      const start = byKey(previous).get(target.keyString) as PlacedNode;
      const manual = [{ nodeKey: target.keyString, x: start.x + OFFSET.x, y: start.y + OFFSET.y }];
      const moved = await layoutOf(incremental(tree, previous, { manualPositions: manual }));
      const leaf = tree.nodes.filter((n) => n.kind === 'primary' && n.children.length === 0).at(-1) as ChainNode;
      const id = Math.max(...graph.systems.map((s) => s.id)) + 1;
      const grown = treeOf({
        systems: [...graph.systems, { id }],
        connections: [
          ...graph.connections,
          {
            id: Math.max(...graph.connections.map((c) => c.id)) + 1,
            createdAt: Math.max(...graph.connections.map((c) => c.createdAt)) + 1,
            endA: leaf.systemId as number,
            endB: id,
          },
        ],
      });
      const known = new Set(tree.nodes.map((n) => n.keyString));
      const addedNodeKeys = grown.nodes.map((n) => n.keyString).filter((key) => !known.has(key));
      const placed = byKey(await layoutOf(incremental(grown, moved, { manualPositions: manual, addedNodeKeys })));
      const before = byKey(moved);
      for (const key of [target.keyString, ...subtreeKeys(target)]) {
        near(placed.get(key), before.get(key) as PlacedNode);
      }
    });
  });

  describe(`radial ${String(size)} nodes: additions under a manual node are carried with it`, () => {
    const growUnder = (parentSystem: number): ChainGraph => {
      const id = Math.max(...graph.systems.map((s) => s.id)) + 1;
      return {
        systems: [...graph.systems, { id }],
        connections: [
          ...graph.connections,
          {
            id: Math.max(...graph.connections.map((c) => c.id)) + 1,
            createdAt: Math.max(...graph.connections.map((c) => c.createdAt)) + 1,
            endA: parentSystem,
            endB: id,
          },
        ],
      };
    };

    for (const where of ['the manual node itself', 'a carried descendant']) {
      it(`a node added under ${where} lands at its full-layout slot plus the manual offset, clear of others`, async () => {
        const tree = treeOf(graph);
        const previous = await layoutOf(full(tree));
        const target = interior(tree);
        const start = byKey(previous).get(target.keyString) as PlacedNode;
        const manual = [{ nodeKey: target.keyString, x: start.x + OFFSET.x, y: start.y + OFFSET.y }];
        const moved = await layoutOf(incremental(tree, previous, { manualPositions: manual }));
        const parent = where === 'the manual node itself' ? target : (target.children[0] as ChainNode);
        const grown = treeOf(growUnder(parent.systemId as number));
        const known = new Set(tree.nodes.map((n) => n.keyString));
        const addedNodeKeys = grown.nodes.map((n) => n.keyString).filter((key) => !known.has(key));
        expect(addedNodeKeys).toHaveLength(1);
        const placed = await layoutOf(incremental(grown, moved, { manualPositions: manual, addedNodeKeys }));
        const expected = byKey(await layoutOf(full(grown, manual)));
        near(byKey(placed).get(addedNodeKeys[0] as string), expected.get(addedNodeKeys[0] as string) as PlacedNode);
        expect(placed).toHaveLength(grown.nodes.length);
        expect(
          countOverlaps(
            placed.filter((n) => [target.keyString, ...subtreeKeys(target), ...addedNodeKeys].includes(n.nodeKey)),
          ),
        ).toBe(0);
      });
    }
  });

  describe(`radial ${String(size)} nodes: collapse lays a branch out as one +N node`, () => {
    it('the +N leaf carries the hidden count, the target carries the collapsed state, rings hold', async () => {
      const tree = treeOf(graph);
      const target = interior(tree);
      const hidden = subtreeKeys(target).length;
      const collapsed = collapseChainTree(tree, new Set([target.keyString]));
      const placed = await layoutOf({ ...full(collapsed), collapsedKeys: [target.keyString] });
      expect(placed).toHaveLength(tree.nodes.length - hidden + 1);
      const leaf = placed.find((node) => node.hiddenCount !== null) as PlacedNode;
      expect(leaf.hiddenCount).toBe(hidden);
      expect(byKey(placed).get(target.keyString)).toMatchObject({ collapsed: true, hiddenCount: null });
      expect(placed.filter((node) => node.collapsed)).toHaveLength(1);
      expect(countOverlaps(placed)).toBe(0);
      expect(ringsHold(collapsed, placed)).toBe(true);
      const root = byKey(placed).get(collapsed.root.keyString) as PlacedNode;
      const parent = byKey(placed).get(target.keyString) as PlacedNode;
      expect(radiusFrom(root, leaf)).toBeGreaterThan(radiusFrom(root, parent));
    });

    it('is deterministic', async () => {
      const tree = treeOf(graph);
      const target = interior(tree);
      const collapsed = collapseChainTree(tree, new Set([target.keyString]));
      const request = { ...full(collapsed), collapsedKeys: [target.keyString] };
      expect(await layoutOf(request)).toEqual(await layoutOf(request));
      expect(await createElkEngine().layout(request)).toEqual(await layoutOf(request));
    });

    it('collapse then expand through incremental requests stays overlap-free and restores the node set', async () => {
      const tree = treeOf(graph);
      const target = interior(tree);
      const original = await layoutOf(full(tree));
      const collapsedTree = collapseChainTree(tree, new Set([target.keyString]));
      const leafKey = collapsedTree.nodes.find((node) => node.kind === 'collapsed')?.keyString as string;
      const afterCollapse = await layoutOf(
        incremental(collapsedTree, original, {
          collapsedKeys: [target.keyString],
          addedNodeKeys: [leafKey],
          removedNodeKeys: subtreeKeys(target),
        }),
      );
      expect(afterCollapse).toHaveLength(collapsedTree.nodes.length);
      expect(countOverlaps(afterCollapse)).toBe(0);
      expect(ringsHold(collapsedTree, afterCollapse)).toBe(true);
      const leaf = afterCollapse.find((node) => node.hiddenCount !== null) as PlacedNode;
      expect(leaf.hiddenCount).toBe(subtreeKeys(target).length);
      const afterExpand = await layoutOf(
        incremental(tree, afterCollapse, { addedNodeKeys: subtreeKeys(target), removedNodeKeys: [leafKey] }),
      );
      expect(afterExpand.map((node) => node.nodeKey).sort()).toEqual(tree.nodes.map((node) => node.keyString).sort());
      expect(countOverlaps(afterExpand)).toBe(0);
    });

    it('several collapsed branches stay overlap-free', async () => {
      const tree = treeOf(graph);
      const targets = tree.nodes
        .filter(
          (node) => node.keyString !== tree.root.keyString && node.kind === 'primary' && node.children.length >= 2,
        )
        .slice(0, 3);
      const keys = targets.map((node) => node.keyString);
      const collapsed = collapseChainTree(tree, new Set(keys));
      const placed = await layoutOf({ ...full(collapsed), collapsedKeys: keys });
      expect(placed.filter((node) => node.hiddenCount !== null).length).toBeGreaterThanOrEqual(1);
      expect(countOverlaps(placed)).toBe(0);
    });
  });

  describe(`radial ${String(size)} nodes: Tidy re-runs a full layout`, () => {
    it('gives the same output as a fresh layout whatever was manual before', async () => {
      const tree = treeOf(graph);
      const fresh = await layoutOf(full(tree));
      const target = interior(tree);
      const start = byKey(fresh).get(target.keyString) as PlacedNode;
      await layoutOf(full(tree, [{ nodeKey: target.keyString, x: start.x + 90, y: start.y + 90 }]));
      const tidied = await createElkEngine().layout(full(tree, []));
      expect(tidied).toEqual(fresh);
      expect(tidied.every((node) => node.source === 'auto')).toBe(true);
    });
  });

  describe(`radial ${String(size)} nodes: the root is never repositioned`, () => {
    it('a full request ignores a root offset', async () => {
      const tree = treeOf(graph);
      const base = await layoutOf(full(tree));
      expect(await layoutOf(full(tree, [], 120))).toEqual(base);
      expect(await layoutOf(full(tree, [], -75))).toEqual(base);
    });

    it('an incremental request ignores a root offset', async () => {
      const tree = treeOf(graph);
      const base = await layoutOf(full(tree));
      const same = byKey(await layoutOf(incremental(tree, base)));
      const offset = byKey(await layoutOf(incremental(tree, base, { rootOffset: 120 })));
      expect(offset).toEqual(same);
      expect(offset).toEqual(byKey(base));
    });
  });

  describe(`radial ${String(size)} nodes: alias leaves, parallel connections and ? nodes keep stable placement`, () => {
    const categories: [string, (node: ChainNode) => boolean][] = [
      ['alias leaf', hasKind('alias')],
      ['unknown-end (?) node', hasKind('unknownEnd')],
      ['parallel-connection node', isParallel],
    ];
    const tree = treeOf(graph);

    const withExtraLeaf = (parentSystem: number): ChainGraph => {
      const id = Math.max(...graph.systems.map((s) => s.id)) + 1;
      return {
        systems: [...graph.systems, { id }],
        connections: [
          ...graph.connections,
          {
            id: Math.max(...graph.connections.map((c) => c.id)) + 1,
            createdAt: Math.max(...graph.connections.map((c) => c.createdAt)) + 1,
            endA: parentSystem,
            endB: id,
          },
        ],
      };
    };

    const between = async (after: ChainTree, previous: readonly PlacedNode[]): Promise<PlacedNode[]> => {
      const known = new Set(tree.nodes.map((n) => n.keyString));
      const next = new Set(after.nodes.map((n) => n.keyString));
      return layoutOf(
        incremental(after, previous, {
          addedNodeKeys: [...next].filter((key) => !known.has(key)),
          removedNodeKeys: [...known].filter((key) => !next.has(key)),
        }),
      );
    };

    const sameRings = (before: readonly PlacedNode[], after: readonly PlacedNode[], sample: readonly ChainNode[]) => {
      const rootKey = tree.root.keyString;
      const radii = (placed: readonly PlacedNode[], key: string): number | null => {
        const nodes = byKey(placed);
        const node = nodes.get(key);
        return node === undefined ? null : radiusFrom(nodes.get(rootKey) as PlacedNode, node);
      };
      for (const node of sample) {
        const was = radii(before, node.keyString) as number;
        const now = radii(after, node.keyString);
        if (now !== null) {
          expect(Math.abs(now - was), node.keyString).toBeLessThan(RING_TOLERANCE);
        }
      }
    };

    for (const [label, matches] of categories) {
      const sample = tree.nodes.filter(matches);

      it(`${label}: the sample exists`, () => {
        expect(sample.length).toBeGreaterThan(0);
      });

      it(`${label}: an unrelated addition keeps the sample on its ring and clear of others`, async () => {
        const previous = await layoutOf(full(tree));
        const leaf = tree.nodes.filter((n) => n.kind === 'primary' && n.children.length === 0).at(-1) as ChainNode;
        const after = treeOf(withExtraLeaf(leaf.systemId as number));
        const placed = await between(after, previous);
        sameRings(previous, placed, sample);
        expect(countOverlaps(placed)).toBe(0);
        expect(ringsHold(after, placed)).toBe(true);
      });

      it(`${label}: removing a leaf keeps the sample on its ring and clear of others`, async () => {
        const previous = await layoutOf(full(tree));
        const leaf = tree.nodes.filter((n) => n.kind === 'primary' && n.children.length === 0).at(-1) as ChainNode;
        const after = removeConnectionFromTree(graph, SYNTHETIC_ROOT_SYSTEM_ID, [
          leaf.parentEdge?.connectionId as number,
        ]);
        const placed = await between(after, previous);
        sameRings(previous, placed, sample);
        expect(countOverlaps(placed)).toBe(0);
        expect(ringsHold(after, placed)).toBe(true);
      });

      it(`${label}: collapsing an unrelated branch keeps the sample on its ring and clear of others`, async () => {
        const previous = await layoutOf(full(tree));
        const target = interior(tree);
        const collapsedTree = collapseChainTree(tree, new Set([target.keyString]));
        const placed = await between(collapsedTree, previous);
        sameRings(
          previous,
          placed,
          sample.filter((node) => !subtreeKeys(target).includes(node.keyString)),
        );
        expect(countOverlaps(placed)).toBe(0);
        expect(ringsHold(collapsedTree, placed)).toBe(true);
      });

      it(`${label}: Tidy returns the fresh layout`, async () => {
        const fresh = await layoutOf(full(tree));
        const manual = sample.map((node) => {
          const placed = byKey(fresh).get(node.keyString) as PlacedNode;
          return { nodeKey: node.keyString, x: placed.x + 13, y: placed.y + 13 };
        });
        const pinned = byKey(await layoutOf(full(tree, manual)));
        for (const node of sample) {
          expect(pinned.get(node.keyString)?.source).toBe('manual');
        }
        expect(await layoutOf(full(tree, []))).toEqual(fresh);
      });
    }
  });
}
