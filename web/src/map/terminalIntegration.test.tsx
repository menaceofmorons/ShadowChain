import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applyChurn,
  buildChainTree,
  collapseChainTree,
  collapsedKey,
  createLayoutAdapter,
  createMemoryChannel,
  createRoutedEngine,
  createWorkerHost,
  DEFAULT_ENGINE_OPTIONS,
  disconnectedSystemIds,
  filterManualPositions,
  generateChain,
  generateChurnScript,
  LAYOUT_MODES,
  newNodeOverlapsAny,
  nodeSize,
  ReactFlowCanvas,
  removeConnectionFromTree,
  removeConnections,
  serialiseNodeKey,
  SYNTHETIC_ROOT_SYSTEM_ID,
  wanderer553,
  type CanvasEdge,
  type CanvasNode,
  type ChainGraph,
  type ChainNode,
  type ChainTree,
  type LayoutEngine,
  type LayoutMode,
  type LayoutRequestMessage,
  type LayoutResponseMessage,
  type ManualPosition,
  type PlacedNode,
} from './index';

const SEED = 7;
const SIZE = 150;
const TIMEOUT_MS = 120_000;
const TREE_MODES: readonly LayoutMode[] = ['top-down', 'left-to-right'];

const graph150 = generateChain({ nodeCount: SIZE, seed: SEED });
const tree150 = buildChainTree(graph150, SYNTHETIC_ROOT_SYSTEM_ID);

function freshEngine(): LayoutEngine {
  const { a, b } = createMemoryChannel<LayoutRequestMessage, LayoutResponseMessage>();
  createWorkerHost(createRoutedEngine(), b);
  const adapter = createLayoutAdapter(a);
  return { layout: (request) => adapter.layout(request) };
}

const treeOf = (graph: ChainGraph): ChainTree => buildChainTree(graph, SYNTHETIC_ROOT_SYSTEM_ID);
const byKey = (nodes: readonly PlacedNode[]): Map<string, PlacedNode> => new Map(nodes.map((n) => [n.nodeKey, n]));
const sortedByKey = (nodes: readonly PlacedNode[]): PlacedNode[] =>
  [...nodes].sort((a, b) => (a.nodeKey < b.nodeKey ? -1 : a.nodeKey > b.nodeKey ? 1 : 0));
const keysOf = (tree: ChainTree): string[] => tree.nodes.map((n) => n.keyString).sort();

const sizeOf = (node: PlacedNode): { w: number; h: number } => {
  if (node.alias) {
    return { w: DEFAULT_ENGINE_OPTIONS.aliasWidth, h: DEFAULT_ENGINE_OPTIONS.aliasHeight };
  }
  if (node.hiddenCount !== null) {
    return { w: DEFAULT_ENGINE_OPTIONS.collapsedWidth, h: DEFAULT_ENGINE_OPTIONS.collapsedHeight };
  }
  return { w: DEFAULT_ENGINE_OPTIONS.nodeWidth, h: DEFAULT_ENGINE_OPTIONS.nodeHeight };
};

function countOverlaps(placed: readonly PlacedNode[]): number {
  let overlaps = 0;
  for (let i = 0; i < placed.length; i += 1) {
    for (let j = i + 1; j < placed.length; j += 1) {
      const a = placed[i] as PlacedNode;
      const b = placed[j] as PlacedNode;
      const sa = sizeOf(a);
      const sb = sizeOf(b);
      if (a.x < b.x + sb.w && b.x < a.x + sa.w && a.y < b.y + sb.h && b.y < a.y + sa.h) {
        overlaps += 1;
      }
    }
  }
  return overlaps;
}

const placedKeys = (placed: readonly PlacedNode[]): string[] => placed.map((n) => n.nodeKey).sort();

const firstCollapsible = (tree: ChainTree): ChainNode =>
  tree.nodes.find((node) => node !== tree.root && node.kind === 'primary' && node.children.length >= 2) as ChainNode;

const subtreeKeys = (node: ChainNode): string[] => [node.keyString, ...node.children.flatMap(subtreeKeys)];

const chain = (...pairs: [number, number][]): ChainGraph => {
  const ids = [...new Set(pairs.flat())].sort((a, b) => a - b);
  return {
    systems: ids.map((id) => ({ id })),
    connections: pairs.map(([endA, endB], index) => ({ id: index + 1, createdAt: index + 1, endA, endB })),
  };
};

describe('one entry point carries the whole extended contract', () => {
  it('exposes model, layout, canvas and recovery surfaces for WS-1.4', () => {
    for (const value of [
      collapseChainTree,
      collapsedKey,
      removeConnections,
      removeConnectionFromTree,
      disconnectedSystemIds,
      filterManualPositions,
      nodeSize,
      createRoutedEngine,
      ReactFlowCanvas,
    ]) {
      expect(typeof value).toBe('function');
    }
    expect(DEFAULT_ENGINE_OPTIONS.collapsedWidth).toBeGreaterThan(0);
    expect(DEFAULT_ENGINE_OPTIONS.collapsedHeight).toBeGreaterThan(0);
  });
});

describe.each(LAYOUT_MODES)('%s: cross-mode contract', (mode) => {
  it(
    'gives identical output on repeat and across engine instances (A9)',
    async () => {
      const request = { type: 'full', tree: tree150, mode, manualPositions: [] } as const;
      const engine = freshEngine();
      const first = await engine.layout(request);
      const repeat = await engine.layout(request);
      const other = await freshEngine().layout(request);
      expect(sortedByKey(repeat)).toEqual(sortedByKey(first));
      expect(sortedByKey(other)).toEqual(sortedByKey(first));
      expect(first).toHaveLength(tree150.nodes.length);
      expect(countOverlaps(first)).toBe(0);
      expect(first.every((n) => n.source === 'auto' && !n.collapsed && n.hiddenCount === null)).toBe(true);
    },
    TIMEOUT_MS,
  );

  it(
    'replays a churn script to identical placements on two instances',
    async () => {
      const graph = generateChain({ nodeCount: 50, seed: SEED });
      const script = generateChurnScript(graph, { seed: SEED + 1, operationCount: 12 });
      const run = async (engine: LayoutEngine): Promise<PlacedNode[][]> => {
        let tree = treeOf(graph);
        let placed = await engine.layout({ type: 'full', tree, mode, manualPositions: [] });
        const steps: PlacedNode[][] = [];
        let current = graph;
        for (const operation of script) {
          current = applyChurn(current, [operation]);
          const next = treeOf(current);
          const known = new Set(tree.nodes.map((n) => n.keyString));
          const nextKeys = new Set(next.nodes.map((n) => n.keyString));
          placed = await engine.layout({
            type: 'incremental',
            tree: next,
            mode,
            manualPositions: [],
            previous: placed,
            addedNodeKeys: [...nextKeys].filter((key) => !known.has(key)),
            removedNodeKeys: [...known].filter((key) => !nextKeys.has(key)),
          });
          expect(placedKeys(placed)).toEqual(keysOf(next));
          expect(countOverlaps(placed)).toBe(0);
          tree = next;
          steps.push(sortedByKey(placed));
        }
        return steps;
      };
      expect(await run(freshEngine())).toEqual(await run(freshEngine()));
    },
    TIMEOUT_MS,
  );

  it(
    'Wanderer #553: a new system is placed overlapping no neighbour (BL-26 ordering unaffected)',
    async () => {
      const full = wanderer553.graph;
      const before: ChainGraph = { systems: full.systems, connections: full.connections.slice(0, 3) };
      const engine = freshEngine();
      const placed = await engine.layout({ type: 'full', tree: treeOf(before), mode, manualPositions: [] });
      const after = treeOf(full);
      const next = await engine.layout({
        type: 'incremental',
        tree: after,
        mode,
        manualPositions: [],
        previous: placed,
        addedNodeKeys: [wanderer553.newNodeKey],
        removedNodeKeys: [],
      });
      const outcome = next.map((n) => ({ nodeKey: n.nodeKey, x: n.x, y: n.y }));
      expect(next).toHaveLength(after.nodes.length);
      expect(countOverlaps(next)).toBe(0);
      expect(
        newNodeOverlapsAny(outcome, wanderer553.newNodeKey, {
          width: DEFAULT_ENGINE_OPTIONS.nodeWidth,
          height: DEFAULT_ENGINE_OPTIONS.nodeHeight,
        }),
      ).toBe(false);
      if (TREE_MODES.includes(mode)) {
        const nextByKey = byKey(next);
        for (const node of placed) {
          expect(nextByKey.get(node.nodeKey)).toMatchObject({ x: node.x, y: node.y });
        }
      }
    },
    TIMEOUT_MS,
  );

  it(
    'BL-26: the same data gives the same layout whatever the order of the node list',
    async () => {
      const reversed: ChainTree = { root: tree150.root, nodes: [...tree150.nodes].reverse() };
      const engine = freshEngine();
      const base = await engine.layout({ type: 'full', tree: tree150, mode, manualPositions: [] });
      const flipped = await engine.layout({ type: 'full', tree: reversed, mode, manualPositions: [] });
      expect(sortedByKey(flipped)).toEqual(sortedByKey(base));
    },
    TIMEOUT_MS,
  );

  it(
    'BL-12 and BL-30: removal cuts systems off cleanly and stale manual positions are filtered, not fatal',
    async () => {
      const graph = chain([1, 2], [2, 3], [3, 4], [1, 5]);
      const engine = freshEngine();
      const tree = treeOf(graph);
      const pins: ManualPosition[] = [
        { nodeKey: 's:3', x: 900, y: 900 },
        { nodeKey: 's:4', x: 1300, y: 900 },
      ];
      const placed = await engine.layout({ type: 'full', tree, mode, manualPositions: pins });
      expect(byKey(placed).get('s:3')).toMatchObject({ x: 900, y: 900, source: 'manual' });

      const cut = removeConnectionFromTree(graph, SYNTHETIC_ROOT_SYSTEM_ID, [2]);
      expect(disconnectedSystemIds(removeConnections(graph, [2]), cut)).toEqual([3, 4]);
      expect(keysOf(cut)).toEqual(['s:1', 's:2', 's:5']);

      const request = {
        type: 'incremental',
        tree: cut,
        mode,
        previous: placed,
        addedNodeKeys: [],
        removedNodeKeys: ['s:3', 's:4'],
      } as const;
      await expect(engine.layout({ ...request, manualPositions: pins })).rejects.toMatchObject({
        code: 'malformed-request',
      });
      const stale = filterManualPositions(cut, pins);
      expect(stale).toEqual([]);
      const next = await engine.layout({ ...request, manualPositions: stale });
      expect(placedKeys(next)).toEqual(['s:1', 's:2', 's:5']);
      expect(countOverlaps(next)).toBe(0);
    },
    TIMEOUT_MS,
  );

  it(
    'collapse, expand and Tidy round trip: +N leaf at engine size, nothing overlaps, Tidy equals a fresh layout',
    async () => {
      const engine = freshEngine();
      const target = firstCollapsible(tree150);
      const hidden = subtreeKeys(target).length - 1;
      const collapsedKeys = [target.keyString];
      const collapsed = collapseChainTree(tree150, new Set(collapsedKeys));
      const leafKey = serialiseNodeKey(collapsedKey(target.key as never));

      const full = await engine.layout({ type: 'full', tree: tree150, mode, manualPositions: [] });
      const folded = await engine.layout({ type: 'full', tree: collapsed, mode, manualPositions: [], collapsedKeys });
      const foldedByKey = byKey(folded);
      expect(foldedByKey.get(leafKey)).toMatchObject({ hiddenCount: hidden, collapsed: false });
      expect(foldedByKey.get(target.keyString)?.collapsed).toBe(true);
      expect(folded).toHaveLength(collapsed.nodes.length);
      expect(countOverlaps(folded)).toBe(0);

      const expanded = await engine.layout({
        type: 'incremental',
        tree: tree150,
        mode,
        manualPositions: [],
        previous: folded,
        addedNodeKeys: subtreeKeys(target).slice(1),
        removedNodeKeys: [leafKey],
      });
      expect(placedKeys(expanded)).toEqual(keysOf(tree150));
      expect(countOverlaps(expanded)).toBe(0);
      expect(expanded.every((n) => n.hiddenCount === null && !n.collapsed)).toBe(true);

      const refolded = await engine.layout({
        type: 'incremental',
        tree: collapsed,
        mode,
        manualPositions: [],
        collapsedKeys,
        previous: expanded,
        addedNodeKeys: [leafKey],
        removedNodeKeys: subtreeKeys(target).slice(1),
      });
      expect(placedKeys(refolded)).toEqual(keysOf(collapsed));
      expect(countOverlaps(refolded)).toBe(0);

      const tidied = await engine.layout({ type: 'full', tree: tree150, mode, manualPositions: [] });
      expect(sortedByKey(tidied)).toEqual(sortedByKey(full));
    },
    TIMEOUT_MS,
  );

  it(
    'a manual node carries its auto descendants and leaves every other node where it was',
    async () => {
      const engine = freshEngine();
      const parent = firstCollapsible(tree150);
      const free = await engine.layout({ type: 'full', tree: tree150, mode, manualPositions: [] });
      const freeByKey = byKey(free);
      const origin = freeByKey.get(parent.keyString) as PlacedNode;
      const delta = { x: 40, y: 25 };
      const pin = { nodeKey: parent.keyString, x: origin.x + delta.x, y: origin.y + delta.y };
      const placed = await engine.layout({ type: 'full', tree: tree150, mode, manualPositions: [pin] });
      const placedByKey = byKey(placed);
      expect(placedByKey.get(parent.keyString)).toMatchObject({ x: pin.x, y: pin.y, source: 'manual' });
      const carried = new Set(subtreeKeys(parent));
      for (const node of tree150.nodes) {
        const before = freeByKey.get(node.keyString) as PlacedNode;
        const after = placedByKey.get(node.keyString) as PlacedNode;
        if (carried.has(node.keyString)) {
          expect(after.x).toBeCloseTo(before.x + delta.x, 1);
          expect(after.y).toBeCloseTo(before.y + delta.y, 1);
        } else {
          expect(after).toMatchObject({ x: before.x, y: before.y });
        }
      }
    },
    TIMEOUT_MS,
  );

  it(
    'root repositioning: tree modes move the root, radial gives identical output (A7)',
    async () => {
      const engine = freshEngine();
      const base = await engine.layout({ type: 'full', tree: tree150, mode, manualPositions: [] });
      const moved = await engine.layout({ type: 'full', tree: tree150, mode, manualPositions: [], rootOffset: 400 });
      if (mode === 'radial') {
        expect(sortedByKey(moved)).toEqual(sortedByKey(base));
        return;
      }
      const rootKey = tree150.root.keyString;
      const before = byKey(base).get(rootKey) as PlacedNode;
      const after = byKey(moved).get(rootKey) as PlacedNode;
      expect(mode === 'top-down' ? after.x : after.y).not.toBe(mode === 'top-down' ? before.x : before.y);
      expect(countOverlaps(moved)).toBe(0);
    },
    TIMEOUT_MS,
  );
});

describe('layout with collapse renders on the canvas in every mode', () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = null;
    container = null;
  });

  const edgesOf = (tree: ChainTree): CanvasEdge[] =>
    tree.nodes.flatMap((node) =>
      node.children.map((child) => ({
        connectionId: child.parentEdge === null ? child.keyString : String(child.parentEdge.connectionId),
        sourceKey: node.keyString,
        targetKey: child.keyString,
      })),
    );

  it.each(LAYOUT_MODES)(
    '%s: every node, +N leaf and edge draws; the root is flagged',
    async (mode) => {
      const target = firstCollapsible(tree150);
      const collapsedKeys = [target.keyString];
      const tree = collapseChainTree(tree150, new Set(collapsedKeys));
      const placed = await freshEngine().layout({ type: 'full', tree, mode, manualPositions: [], collapsedKeys });
      const nodes: CanvasNode[] = placed.map((p) => ({
        key: p.nodeKey,
        x: p.x,
        y: p.y,
        isAlias: p.alias,
        hiddenCount: p.hiddenCount,
        isRoot: p.nodeKey === tree.root.keyString,
      }));
      container = document.createElement('div');
      container.style.width = '800px';
      container.style.height = '600px';
      document.body.appendChild(container);
      root = createRoot(container);
      await act(async () => {
        root?.render(
          <ReactFlowCanvas
            nodes={nodes}
            edges={edgesOf(tree)}
            mode={mode}
            onNodeSelect={vi.fn()}
            onNodesMoved={vi.fn()}
          />,
        );
      });
      expect(container.querySelectorAll('.react-flow__node')).toHaveLength(tree.nodes.length);
      expect(container.querySelectorAll('.react-flow__edge')).toHaveLength(tree.nodes.length - 1);
      const hiddenTotal = subtreeKeys(target).length - 1;
      expect(container.textContent).toContain(`+${String(hiddenTotal)}`);
    },
    TIMEOUT_MS,
  );
});
