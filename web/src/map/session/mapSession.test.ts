import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildChainTree } from '../model/chainTree';
import type { ChainGraph, ChainNode } from '../model/types';
import { createRoutedEngine } from '../layout/engines/engineRegistry';
import { LAYOUT_MODES } from '../layout/types';
import type { IncrementalLayoutRequest, LayoutEngine, LayoutMode, LayoutRequest, PlacedNode } from '../layout/types';
import { createPositionStore } from '../store';
import type { PositionsBatch, PositionStore } from '../store';
import { generateChain, SYNTHETIC_ROOT_SYSTEM_ID } from '../synthetic';
import { applyChurn, generateChurnScript } from '../synthetic/churnScript';
import { newNodeOverlapsAny, placedNodesUnmoved, wanderer553, wanderer98 } from '../fixtures/wanderer';
import { createMapSession } from './mapSession';
import type { MapSession } from './mapSession';

const TREE_MODES: readonly LayoutMode[] = ['top-down', 'left-to-right'];
const ROOT = SYNTHETIC_ROOT_SYSTEM_ID;
const ROOT_KEY = `s:${String(ROOT)}`;

interface Rig {
  readonly session: MapSession;
  readonly store: PositionStore;
  readonly requests: LayoutRequest[];
  readonly batches: PositionsBatch[];
  readonly graph: ChainGraph;
}

const rigs: Rig[] = [];

function recording(inner: LayoutEngine, requests: LayoutRequest[]): LayoutEngine {
  return {
    layout: (request) => {
      requests.push(request);
      return inner.layout(request);
    },
  };
}

function makeRig(graph: ChainGraph, mode: LayoutMode): Rig {
  const requests: LayoutRequest[] = [];
  const batches: PositionsBatch[] = [];
  const store = createPositionStore({ tabId: 'tab-1', rootSystemId: ROOT, onBatch: (batch) => batches.push(batch) });
  const session = createMapSession({
    graph,
    rootSystemId: ROOT,
    mode,
    store,
    layout: recording(createRoutedEngine(), requests),
  });
  const rig = { session, store, requests, batches, graph };
  rigs.push(rig);
  return rig;
}

afterEach(() => {
  for (const rig of rigs.splice(0)) {
    rig.session.dispose();
    rig.store.dispose();
  }
});

const chain = (nodeCount = 30): ChainGraph => generateChain({ nodeCount, seed: 7 });

function find(nodes: readonly ChainNode[], predicate: (node: ChainNode) => boolean): ChainNode {
  const found = nodes.find(predicate);
  if (found === undefined) {
    throw new Error('no node matches');
  }
  return found;
}

const positionsOf = (nodes: readonly PlacedNode[]): Map<string, [number, number]> =>
  new Map(nodes.map((node) => [node.nodeKey, [node.x, node.y]]));

function branchPoint(graph: ChainGraph): { parent: ChainNode; child: ChainNode } {
  const tree = buildChainTree(graph, ROOT);
  const parent = find(
    tree.nodes,
    (node) => node.keyString !== ROOT_KEY && node.kind === 'primary' && node.children.some((c) => c.kind === 'primary'),
  );
  return { parent, child: find(parent.children, (c) => c.kind === 'primary') };
}

function descendantKeys(node: ChainNode): string[] {
  return node.children.flatMap((child) => [child.keyString, ...descendantKeys(child)]);
}

describe('request rules (BL-36)', () => {
  describe.each(LAYOUT_MODES)('%s', (mode) => {
    async function drive(): Promise<{ rig: Rig; parent: ChainNode; child: ChainNode }> {
      const graph = chain();
      const rig = makeRig(graph, mode);
      const { parent, child } = branchPoint(graph);
      await rig.session.open();
      await rig.session.dragNode(child.keyString, { x: 400, y: 400 });
      await rig.session.setCollapsed(parent.keyString, true);
      await rig.session.addConnection({ id: 9001, createdAt: 9001, endA: ROOT, endB: 30 });
      await rig.session.removeConnections([9001]);
      return { rig, parent, child };
    }

    it('passes rootOffset on every request, full and incremental', async () => {
      const { rig } = await drive();
      expect(rig.requests.some((r) => r.type === 'incremental')).toBe(true);
      expect(rig.requests.some((r) => r.type === 'full')).toBe(true);
      for (const request of rig.requests) {
        expect(request.rootOffset).toBe(0);
      }
    });

    it('reduces the tree by the collapsed keys and sets the collapsed list', async () => {
      const { rig, parent, child } = await drive();
      const last = rig.requests.at(-1) as LayoutRequest;
      const keys = last.tree.nodes.map((node) => node.keyString);
      expect(keys).not.toContain(child.keyString);
      for (const hidden of descendantKeys(parent)) {
        expect(keys).not.toContain(hidden);
      }
      expect(keys).toContain(`+:${parent.keyString}`);
      expect(last.collapsedKeys).toEqual([parent.keyString]);
    });

    it('filters manual positions of hidden nodes out of the request but keeps them stored', async () => {
      const { rig, child } = await drive();
      const last = rig.requests.at(-1) as LayoutRequest;
      expect(last.manualPositions.map((p) => p.nodeKey)).not.toContain(child.keyString);
      for (const position of rig.requests.flatMap((r) => r.manualPositions)) {
        expect(position.nodeKey).toBeTypeOf('string');
      }
      expect(rig.store.row(child.keyString)?.source).toBe('manual');
      const treeKeys = new Set(last.tree.nodes.map((node) => node.keyString));
      expect(last.manualPositions.every((p) => treeKeys.has(p.nodeKey))).toBe(true);
    });

    it('sets alias, collapsed and hiddenCount on every placed node literal', async () => {
      const { rig, parent } = await drive();
      const incremental = rig.requests.filter((r): r is IncrementalLayoutRequest => r.type === 'incremental');
      expect(incremental.length).toBeGreaterThan(0);
      for (const request of incremental) {
        for (const node of request.previous) {
          expect(node.alias).toBeTypeOf('boolean');
          expect(node.collapsed).toBeTypeOf('boolean');
          expect(node.hiddenCount === null || typeof node.hiddenCount === 'number').toBe(true);
        }
      }
      const nodes = rig.session.placedNodes();
      expect(nodes.find((n) => n.nodeKey === parent.keyString)?.collapsed).toBe(true);
      const marker = nodes.find((n) => n.nodeKey === `+:${parent.keyString}`);
      expect(marker?.hiddenCount).toBeGreaterThan(0);
      expect(nodes.filter((n) => n.nodeKey !== `+:${parent.keyString}`).every((n) => n.hiddenCount === null)).toBe(
        true,
      );
    });

    it('uses incremental requests for add and remove with the added and removed keys', async () => {
      const graph = chain();
      const rig = makeRig(graph, mode);
      await rig.session.open();
      await rig.session.addConnection({ id: 9001, createdAt: 9001, endA: ROOT, endB: 31 }, [{ id: 31 }]);
      const added = rig.requests.at(-1) as IncrementalLayoutRequest;
      expect(added.type).toBe('incremental');
      expect(added.addedNodeKeys).toEqual(['s:31']);
      expect(added.removedNodeKeys).toEqual([]);
      await rig.session.removeConnections([9001]);
      const removed = rig.requests.at(-1) as IncrementalLayoutRequest;
      expect(removed.removedNodeKeys).toEqual(['s:31']);
      expect(removed.addedNodeKeys).toEqual([]);
    });

    it('uses full requests for open, mode change and Tidy', async () => {
      const rig = makeRig(chain(), mode);
      const other = LAYOUT_MODES.find((candidate) => candidate !== mode) as LayoutMode;
      await rig.session.open();
      await rig.session.setMode(other);
      await rig.session.tidy();
      expect(rig.requests.map((r) => r.type)).toEqual(['full', 'full', 'full']);
      expect(rig.requests.map((r) => r.mode)).toEqual([mode, other, other]);
    });
  });

  it('serialises overlapping operations in call order', async () => {
    const rig = makeRig(chain(), 'top-down');
    const { child } = branchPoint(rig.graph);
    await rig.session.open();
    await Promise.all([
      rig.session.dragNode(child.keyString, { x: 10, y: 10 }),
      rig.session.setCollapsed(child.keyString, true),
      rig.session.tidy(),
    ]);
    expect(rig.requests.map((r) => r.collapsedKeys?.length ?? 0)).toEqual([0, 0, 1, 1]);
    expect(rig.store.row(child.keyString)?.collapsed).toBe(true);
  });
});

describe('churn through the session equals an engine-level replay', () => {
  it.each(LAYOUT_MODES)(
    '%s',
    async (mode) => {
      const graph = chain(40);
      const script = generateChurnScript(graph, { seed: 3, operationCount: 8 });
      const rig = makeRig(graph, mode);
      await rig.session.open();

      const engine = createRoutedEngine();
      let replayGraph = graph;
      let tree = buildChainTree(replayGraph, ROOT);
      let previous = await engine.layout({
        type: 'full',
        tree,
        mode,
        manualPositions: [],
        collapsedKeys: [],
        rootOffset: 0,
      });

      for (const operation of script) {
        if (operation.kind === 'add') {
          const known = new Set(replayGraph.systems.map((s) => s.id));
          const missing = [operation.connection.endA, operation.connection.endB]
            .filter((id): id is number => id !== null && !known.has(id))
            .map((id) => ({ id }));
          await rig.session.addConnection(operation.connection, missing);
        } else {
          await rig.session.removeConnections([operation.connectionId]);
        }
        replayGraph = applyChurn(replayGraph, [operation]);
        const nextTree = buildChainTree(replayGraph, ROOT);
        const before = new Set(tree.nodes.map((n) => n.keyString));
        const after = new Set(nextTree.nodes.map((n) => n.keyString));
        previous = await engine.layout({
          type: 'incremental',
          tree: nextTree,
          mode,
          manualPositions: [],
          collapsedKeys: [],
          rootOffset: 0,
          previous,
          addedNodeKeys: [...after].filter((key) => !before.has(key)),
          removedNodeKeys: [...before].filter((key) => !after.has(key)),
        });
        tree = nextTree;
        expect(positionsOf(rig.session.placedNodes())).toEqual(positionsOf(previous));
      }
    },
    60_000,
  );
});

describe('drag semantics (A5)', () => {
  it.each(TREE_MODES)('%s: plain drag stores only the dragged node and carries descendants', async (mode) => {
    const graph = chain();
    const rig = makeRig(graph, mode);
    const { parent } = branchPoint(graph);
    await rig.session.open();
    const before = positionsOf(rig.session.placedNodes());
    const [px, py] = before.get(parent.keyString) as [number, number];
    const stored = await rig.session.dragNode(parent.keyString, { x: px + 300, y: py + 200 });
    expect(stored).toEqual([{ nodeKey: parent.keyString, x: px + 300, y: py + 200 }]);
    expect(rig.store.rows().map((row) => row.nodeKey)).toEqual([parent.keyString]);
    expect(rig.store.row(parent.keyString)?.source).toBe('manual');
    const after = positionsOf(rig.session.placedNodes());
    for (const key of descendantKeys(parent)) {
      const [bx, by] = before.get(key) as [number, number];
      const [ax, ay] = after.get(key) as [number, number];
      expect([ax - bx, ay - by]).toEqual([300, 200]);
      expect(rig.store.row(key)).toBeUndefined();
    }
  });

  it.each(TREE_MODES)('%s: Alt drag pins the node and its direct children only', async (mode) => {
    const graph = chain();
    const rig = makeRig(graph, mode);
    const { parent } = branchPoint(graph);
    await rig.session.open();
    const before = positionsOf(rig.session.placedNodes());
    const target = { x: 500, y: 500 };
    await rig.session.dragNodeAlone(parent.keyString, target);
    const direct = parent.children.filter((c) => c.kind !== 'collapsed').map((c) => c.keyString);
    expect(
      rig.store
        .rows()
        .map((row) => row.nodeKey)
        .sort(),
    ).toEqual([parent.keyString, ...direct].sort());
    const after = positionsOf(rig.session.placedNodes());
    expect(after.get(parent.keyString)).toEqual([target.x, target.y]);
    for (const key of direct) {
      expect(after.get(key)).toEqual(before.get(key));
      expect(rig.store.row(key)).toMatchObject({ source: 'manual', x: before.get(key)?.[0], y: before.get(key)?.[1] });
    }
    const grandchildren = parent.children.flatMap((c) => c.children.map((g) => g.keyString));
    for (const key of grandchildren) {
      expect(rig.store.row(key)).toBeUndefined();
    }
  });

  it.each(TREE_MODES)('%s: group drag moves every selected node by one delta in one batch', async (mode) => {
    const graph = chain();
    const rig = makeRig(graph, mode);
    const { parent, child } = branchPoint(graph);
    await rig.session.open();
    const before = positionsOf(rig.session.placedNodes());
    const keys = [parent.keyString, child.keyString, ROOT_KEY];
    await rig.session.dragGroup(keys, { dx: 50, dy: 40 });
    rig.store.flush();
    expect(rig.batches).toHaveLength(1);
    const batch = rig.batches[0] as PositionsBatch;
    expect(batch.positions.map((p) => p.nodeKey).sort()).toEqual([parent.keyString, child.keyString].sort());
    const after = positionsOf(rig.session.placedNodes());
    for (const key of [parent.keyString, child.keyString]) {
      const [bx, by] = before.get(key) as [number, number];
      expect(rig.store.row(key)).toMatchObject({ x: bx + 50, y: by + 40, source: 'manual' });
      expect(after.get(key)).toEqual([bx + 50, by + 40]);
    }
    expect(rig.store.row(ROOT_KEY)).toBeUndefined();
  });

  it.each(TREE_MODES)('%s: Reset position restores the automatic layout', async (mode) => {
    const graph = chain();
    const rig = makeRig(graph, mode);
    const { parent } = branchPoint(graph);
    await rig.session.open();
    const original = positionsOf(rig.session.placedNodes());
    await rig.session.dragNode(parent.keyString, { x: 700, y: 700 });
    await rig.session.resetPosition(parent.keyString);
    expect(rig.store.row(parent.keyString)).toBeUndefined();
    expect(positionsOf(rig.session.placedNodes())).toEqual(original);
  });

  it('notifies a node subscriber of its new placement until unsubscribed', async () => {
    const graph = chain();
    const rig = makeRig(graph, 'top-down');
    const { parent } = branchPoint(graph);
    await rig.session.open();
    const listener = vi.fn();
    const unsubscribe = rig.session.subscribeNode(parent.keyString, listener);
    await rig.session.dragNode(parent.keyString, { x: 321, y: 123 });
    expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({ x: 321, y: 123, source: 'manual' }));
    unsubscribe();
    listener.mockClear();
    await rig.session.dragNode(parent.keyString, { x: 5, y: 5 });
    expect(listener).not.toHaveBeenCalled();
  });
});

describe('collapse, Tidy and root move (A6)', () => {
  it('expands from the +N marker key', async () => {
    const graph = chain();
    const rig = makeRig(graph, 'top-down');
    const { parent } = branchPoint(graph);
    await rig.session.open();
    await rig.session.setCollapsed(parent.keyString, true);
    await rig.session.setCollapsed(`+:${parent.keyString}`, false);
    expect(rig.store.collapsedKeys()).toEqual([]);
    expect(rig.session.tree().nodes.some((n) => n.kind === 'collapsed')).toBe(false);
  });

  it.each(TREE_MODES)('%s: Tidy clears manual positions and keeps collapse and root offset', async (mode) => {
    const graph = chain();
    const rig = makeRig(graph, mode);
    const { parent, child } = branchPoint(graph);
    await rig.session.open();
    const other = find(rig.session.tree().nodes, (n) => n.kind === 'primary' && n.keyString !== ROOT_KEY);
    await rig.session.dragNode(other.keyString, { x: 800, y: 800 });
    await rig.session.setCollapsed(parent.keyString, true);
    await rig.session.moveRoot(75);
    await rig.session.tidy();
    expect(rig.store.manualPositions()).toEqual([]);
    expect(rig.store.collapsedKeys()).toEqual([parent.keyString]);
    expect(rig.store.rootOffset()).toBe(75);
    const last = rig.requests.at(-1) as LayoutRequest;
    expect(last.manualPositions).toEqual([]);
    expect(last.rootOffset).toBe(75);
    expect(last.tree.nodes.map((n) => n.keyString)).not.toContain(child.keyString);
  });

  it.each(TREE_MODES)('%s: root move shifts the chain across the layout and is stored as the offset', async (mode) => {
    const rig = makeRig(chain(), mode);
    await rig.session.open();
    const before = positionsOf(rig.session.placedNodes());
    expect(await rig.session.moveRoot(120)).toBe(true);
    const after = positionsOf(rig.session.placedNodes());
    const axis = mode === 'top-down' ? 0 : 1;
    const other = 1 - axis;
    for (const [key, [bx, by]] of before) {
      const [ax, ay] = after.get(key) as [number, number];
      const b = [bx, by];
      const a = [ax, ay];
      expect((a[axis] as number) - (b[axis] as number)).toBeCloseTo(120, 1);
      expect(a[other]).toBe(b[other]);
    }
    expect(rig.store.rootOffset()).toBe(120);
    expect(rig.store.row(ROOT_KEY)).toBeUndefined();
    expect((rig.requests.at(-1) as LayoutRequest).rootOffset).toBe(120);
  });

  it('rejects a root move in radial without a request or a store change', async () => {
    const rig = makeRig(chain(), 'radial');
    await rig.session.open();
    const count = rig.requests.length;
    expect(await rig.session.moveRoot(120)).toBe(false);
    expect(rig.requests).toHaveLength(count);
    expect(rig.store.rootOffset()).toBe(0);
  });

  it('does not make the root a manual node when it is dragged', async () => {
    const rig = makeRig(chain(), 'top-down');
    await rig.session.open();
    expect(await rig.session.dragNode(ROOT_KEY, { x: 9, y: 9 })).toEqual([]);
    expect(rig.store.rows()).toEqual([]);
  });
});

describe.each(LAYOUT_MODES)('Wanderer regressions through the session: %s', (mode) => {
  const withoutNew: ChainGraph = {
    systems: wanderer553.graph.systems.filter((s) => s.id !== 5),
    connections: wanderer553.graph.connections.filter((c) => c.id !== 4),
  };

  it('#553: a new node overlaps no neighbour; tree modes move no placed node', async () => {
    const rig = makeRig(withoutNew, mode);
    await rig.session.open();
    const start = rig.session.placedNodes().map((n) => ({ nodeKey: n.nodeKey, x: n.x, y: n.y }));
    await rig.session.addConnection({ id: 4, createdAt: 4, endA: 1, endB: 5 }, [{ id: 5 }]);
    const outcome = rig.session.placedNodes().map((n) => ({ nodeKey: n.nodeKey, x: n.x, y: n.y }));
    expect(newNodeOverlapsAny(outcome, wanderer553.newNodeKey, { width: 96, height: 32 })).toBe(false);
    expect(newNodeOverlapsAny(outcome, wanderer553.newNodeKey)).toBe(false);
    if (mode !== 'radial') {
      expect(
        placedNodesUnmoved(
          start,
          outcome.filter((n) => n.nodeKey !== wanderer553.newNodeKey),
        ),
      ).toBe(true);
    }
  });

  it('#98: one batch carries every moved node and a stale update never reverts them', async () => {
    const rig = makeRig(withoutNew, mode);
    await rig.session.open();
    const start = positionsOf(rig.session.placedNodes());
    const staleRevision = rig.store.snapshot().revision;
    const { movedNodeKeys, dragDelta } = wanderer98;
    await rig.session.dragGroup(movedNodeKeys, { dx: dragDelta.dx, dy: dragDelta.dy });
    rig.store.flush();
    expect(rig.batches).toHaveLength(1);
    const dragged = movedNodeKeys.map((key) => {
      const [x, y] = start.get(key) as [number, number];
      return { nodeKey: key, x: x + dragDelta.dx, y: y + dragDelta.dy };
    });
    for (const expected of dragged) {
      expect((rig.batches[0] as PositionsBatch).positions).toContainEqual({
        nodeKey: expected.nodeKey,
        x: expected.x,
        y: expected.y,
        source: 'manual',
        collapsed: false,
      });
    }
    rig.store.mergeUpdate({
      basedOnRevision: staleRevision,
      positions: wanderer98.staleUpdate.positions.map((p) => ({ ...p, source: 'manual', collapsed: false })),
    });
    await rig.session.addConnection({ id: 4, createdAt: 4, endA: 1, endB: 5 }, [{ id: 5 }]);
    const after = positionsOf(rig.session.placedNodes());
    for (const expected of dragged) {
      expect(rig.store.row(expected.nodeKey)).toMatchObject({ x: expected.x, y: expected.y, source: 'manual' });
      expect(after.get(expected.nodeKey)).toEqual([expected.x, expected.y]);
    }
  });
});
