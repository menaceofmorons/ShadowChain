import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyBatch, batchCarriesAllMoved, staleUpdateRevertsMoved, wanderer98 } from '../fixtures/wanderer';
import type { NodePosition, PositionBatch } from '../fixtures/wanderer';
import { POSITION_WRITE_DEBOUNCE_MS, createPositionStore } from './index';
import type { PositionsBatch } from './index';

const toFixtureBatch = (batch: PositionsBatch): PositionBatch => ({
  positions: batch.positions.flatMap((row) =>
    row.x !== null && row.y !== null ? [{ nodeKey: row.nodeKey, x: row.x, y: row.y }] : [],
  ),
});

function setup() {
  const batches: PositionsBatch[] = [];
  const store = createPositionStore({ tabId: 'tab-1', rootSystemId: 1, onBatch: (batch) => batches.push(batch) });
  return { store, batches };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('positionStore rows', () => {
  it('holds a collapse-only row with NULL coordinates and auto source', () => {
    const { store } = setup();
    store.setCollapsed('s:2', true);
    expect(store.row('s:2')).toEqual({
      tabId: 'tab-1',
      rootSystemId: 1,
      nodeKey: 's:2',
      x: null,
      y: null,
      source: 'auto',
      collapsed: true,
    });
    expect(store.manualPositions()).toEqual([]);
    expect(store.collapsedKeys()).toEqual(['s:2']);
  });

  it('holds a manual row and returns it in the layout-contract form', () => {
    const { store } = setup();
    store.setManualPosition('s:3', 10, 20);
    expect(store.row('s:3')).toMatchObject({ x: 10, y: 20, source: 'manual', collapsed: false });
    expect(store.manualPositions()).toEqual([{ nodeKey: 's:3', x: 10, y: 20 }]);
  });

  it('resets one override only and keeps its collapse state', () => {
    const { store } = setup();
    store.setManualPosition('s:2', 1, 1);
    store.setManualPosition('s:3', 2, 2);
    store.setCollapsed('s:2', true);
    store.resetPosition('s:2');
    expect(store.manualPositions()).toEqual([{ nodeKey: 's:3', x: 2, y: 2 }]);
    expect(store.row('s:2')).toMatchObject({ x: null, y: null, source: 'auto', collapsed: true });
  });

  it('drops a row that is neither manual nor collapsed', () => {
    const { store } = setup();
    store.setManualPosition('s:2', 1, 1);
    store.resetPosition('s:2');
    expect(store.row('s:2')).toBeUndefined();
    expect(store.rows()).toEqual([]);
  });

  it('clears all manual rows but keeps collapse rows and root offset', () => {
    const { store } = setup();
    store.setManualPosition('s:2', 1, 1);
    store.setManualPosition('s:3', 2, 2);
    store.setCollapsed('s:3', true);
    store.setCollapsed('s:4', true);
    store.setRootOffset(120);
    store.clearManual();
    expect(store.manualPositions()).toEqual([]);
    expect(store.collapsedKeys().sort()).toEqual(['s:3', 's:4']);
    expect(store.rootOffset()).toBe(120);
    expect(store.tab()).toEqual({ id: 'tab-1', rootSystemId: 1, rootOffset: 120 });
  });

  it('sets and clears collapse', () => {
    const { store } = setup();
    store.setCollapsed('s:2', true);
    store.setCollapsed('s:2', false);
    expect(store.collapsedKeys()).toEqual([]);
    expect(store.row('s:2')).toBeUndefined();
  });
});

describe('positionStore batch writer', () => {
  it('sends many moves inside the window as one batch carrying every moved node', () => {
    const { store, batches } = setup();
    store.setManualPosition('s:2', 1, 1);
    vi.advanceTimersByTime(POSITION_WRITE_DEBOUNCE_MS - 1);
    store.setManualPosition('s:3', 2, 2);
    store.setManualPosition('s:2', 5, 5);
    vi.advanceTimersByTime(POSITION_WRITE_DEBOUNCE_MS - 1);
    expect(batches).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(batches).toHaveLength(1);
    expect(batches[0]!.positions).toEqual([
      { nodeKey: 's:2', x: 5, y: 5, source: 'manual', collapsed: false },
      { nodeKey: 's:3', x: 2, y: 2, source: 'manual', collapsed: false },
    ]);
    vi.advanceTimersByTime(5000);
    expect(batches).toHaveLength(1);
  });

  it('carries root offset and a cleared row in the batch', () => {
    const { store, batches } = setup();
    store.setManualPosition('s:2', 1, 1);
    store.flush();
    store.resetPosition('s:2');
    store.setRootOffset(40);
    store.flush();
    expect(batches[1]).toEqual({
      positions: [{ nodeKey: 's:2', x: null, y: null, source: 'auto', collapsed: false }],
      rootOffset: 40,
    });
  });

  it('sends nothing for a no-op change and nothing after dispose', () => {
    const { store, batches } = setup();
    store.resetPosition('s:9');
    store.setManualPosition('s:2', 1, 1);
    store.dispose();
    vi.advanceTimersByTime(2000);
    expect(batches).toHaveLength(0);
  });

  it('writeBatch merges per node row and leaves unnamed rows alone', () => {
    const { store } = setup();
    store.setManualPosition('s:2', 1, 1);
    store.setManualPosition('s:3', 2, 2);
    store.writeBatch({
      positions: [{ nodeKey: 's:3', x: 9, y: 9, source: 'manual', collapsed: true }],
      rootOffset: 7,
    });
    expect(store.row('s:2')).toMatchObject({ x: 1, y: 1 });
    expect(store.row('s:3')).toMatchObject({ x: 9, y: 9, collapsed: true });
    expect(store.rootOffset()).toBe(7);
  });
});

describe('positionStore against the Wanderer #98 fixture', () => {
  const { startPositions, movedNodeKeys, dragDelta, staleUpdate } = wanderer98;
  const dragged: NodePosition[] = startPositions
    .filter((node) => movedNodeKeys.includes(node.nodeKey))
    .map((node) => ({ nodeKey: node.nodeKey, x: node.x + dragDelta.dx, y: node.y + dragDelta.dy }));

  it('sends one batch carrying every moved node', () => {
    const { store, batches } = setup();
    store.setManualPositions(dragged);
    vi.advanceTimersByTime(POSITION_WRITE_DEBOUNCE_MS);
    expect(batches).toHaveLength(1);
    expect(batchCarriesAllMoved(toFixtureBatch(batches[0]!), movedNodeKeys, dragged)).toBe(true);
  });

  it('applies the batch like the reference merge', () => {
    const { store, batches } = setup();
    store.setManualPositions(dragged);
    store.flush();
    const reference = applyBatch(startPositions, toFixtureBatch(batches[0]!));
    for (const node of reference.filter((n) => movedNodeKeys.includes(n.nodeKey))) {
      expect(store.row(node.nodeKey)).toMatchObject({ x: node.x, y: node.y });
    }
  });

  it('never reverts moved nodes on a stale update', () => {
    const { store } = setup();
    const staleRevision = store.snapshot().revision;
    store.setManualPositions(dragged);
    store.flush();
    const state: NodePosition[] = store.manualPositions();
    const merge = (_: readonly NodePosition[], update: PositionBatch): NodePosition[] => {
      store.mergeUpdate({
        basedOnRevision: staleRevision,
        positions: update.positions.map((node) => ({ ...node, source: 'manual', collapsed: false })),
      });
      return store.manualPositions();
    };
    expect(staleUpdateRevertsMoved(state, movedNodeKeys, staleUpdate, merge)).toBe(false);
    for (const node of dragged) {
      expect(store.row(node.nodeKey)).toMatchObject({ x: node.x, y: node.y });
    }
  });

  it('applies an update to rows changed only before its snapshot', () => {
    const { store } = setup();
    store.setManualPosition('s:2', 1, 1);
    store.flush();
    const revision = store.snapshot().revision;
    store.mergeUpdate({
      basedOnRevision: revision,
      positions: [{ nodeKey: 's:2', x: 8, y: 8, source: 'manual', collapsed: false }],
    });
    expect(store.row('s:2')).toMatchObject({ x: 8, y: 8 });
  });

  it('ignores an update for a row with a pending unsent change', () => {
    const { store } = setup();
    store.setManualPosition('s:2', 1, 1);
    store.mergeUpdate({
      basedOnRevision: store.snapshot().revision,
      positions: [{ nodeKey: 's:2', x: 8, y: 8, source: 'manual', collapsed: false }],
    });
    expect(store.row('s:2')).toMatchObject({ x: 1, y: 1 });
  });
});

describe('positionStore per-node subscriptions', () => {
  it('notifies a subscriber only for its own key', () => {
    const { store } = setup();
    const own = vi.fn();
    const other = vi.fn();
    store.subscribeNode('s:2', own);
    store.subscribeNode('s:3', other);
    store.setManualPosition('s:2', 1, 1);
    expect(own).toHaveBeenCalledTimes(1);
    expect(own.mock.calls[0]![0]).toMatchObject({ x: 1, y: 1 });
    expect(other).not.toHaveBeenCalled();
  });

  it('does not notify on a no-op change, on root offset, or after unsubscribe', () => {
    const { store } = setup();
    const listener = vi.fn();
    const unsubscribe = store.subscribeNode('s:2', listener);
    store.resetPosition('s:2');
    store.setRootOffset(10);
    store.setManualPosition('s:3', 1, 1);
    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
    store.setManualPosition('s:2', 1, 1);
    expect(listener).not.toHaveBeenCalled();
  });

  it('notifies with undefined when a row is removed', () => {
    const { store } = setup();
    store.setManualPosition('s:2', 1, 1);
    const listener = vi.fn();
    store.subscribeNode('s:2', listener);
    store.resetPosition('s:2');
    expect(listener).toHaveBeenCalledWith(undefined);
  });
});
