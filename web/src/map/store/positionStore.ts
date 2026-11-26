import type { ManualPosition } from '../layout/types';
import type {
  BatchSink,
  MapTabRow,
  NodeListener,
  NodePositionRow,
  NodeRowWrite,
  PositionsBatch,
  PositionsUpdate,
  PositionStoreSnapshot,
} from './types';

export const POSITION_WRITE_DEBOUNCE_MS = 500;

export interface PositionStoreOptions {
  readonly tabId: string;
  readonly rootSystemId?: number | null;
  readonly onBatch: BatchSink;
  readonly debounceMs?: number;
}

export interface PositionStore {
  readonly tab: () => MapTabRow;
  readonly row: (nodeKey: string) => NodePositionRow | undefined;
  readonly rows: () => NodePositionRow[];
  readonly snapshot: () => PositionStoreSnapshot;
  readonly manualPositions: () => ManualPosition[];
  readonly collapsedKeys: () => string[];
  readonly rootOffset: () => number;
  readonly setManualPosition: (nodeKey: string, x: number, y: number) => void;
  readonly setManualPositions: (positions: readonly ManualPosition[]) => void;
  readonly resetPosition: (nodeKey: string) => void;
  readonly clearManual: () => void;
  readonly setCollapsed: (nodeKey: string, collapsed: boolean) => void;
  readonly setRootOffset: (rootOffset: number) => void;
  readonly writeBatch: (batch: PositionsBatch) => void;
  readonly mergeUpdate: (update: PositionsUpdate) => void;
  readonly subscribeNode: (nodeKey: string, listener: NodeListener) => () => void;
  readonly flush: () => void;
  readonly dispose: () => void;
}

type RowState = Pick<NodeRowWrite, 'x' | 'y' | 'source' | 'collapsed'>;

const isEmptyRow = (row: RowState): boolean =>
  row.source === 'auto' && !row.collapsed && row.x === null && row.y === null;

const sameRow = (a: NodePositionRow | undefined, b: NodePositionRow | undefined): boolean =>
  a === b ||
  (a !== undefined &&
    b !== undefined &&
    a.x === b.x &&
    a.y === b.y &&
    a.source === b.source &&
    a.collapsed === b.collapsed);

export function createPositionStore(options: PositionStoreOptions): PositionStore {
  const { tabId, onBatch } = options;
  const rootSystemId = options.rootSystemId ?? null;
  const debounceMs = options.debounceMs ?? POSITION_WRITE_DEBOUNCE_MS;

  const rowsByKey = new Map<string, NodePositionRow>();
  const rowRevision = new Map<string, number>();
  const listeners = new Map<string, Set<NodeListener>>();
  const dirtyKeys = new Set<string>();
  let rootOffset = 0;
  let rootOffsetRevision = 0;
  let rootOffsetDirty = false;
  let revision = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const notify = (nodeKey: string): void => {
    const row = rowsByKey.get(nodeKey);
    listeners.get(nodeKey)?.forEach((listener) => listener(row));
  };

  const emitBatch = (): void => {
    timer = undefined;
    if (dirtyKeys.size === 0 && !rootOffsetDirty) {
      return;
    }
    const positions: NodeRowWrite[] = [...dirtyKeys].map((nodeKey): NodeRowWrite => {
      const row = rowsByKey.get(nodeKey);
      return row === undefined
        ? { nodeKey, x: null, y: null, source: 'auto', collapsed: false }
        : { nodeKey, x: row.x, y: row.y, source: row.source, collapsed: row.collapsed };
    });
    const batch: PositionsBatch = rootOffsetDirty ? { positions, rootOffset } : { positions };
    dirtyKeys.clear();
    rootOffsetDirty = false;
    onBatch(batch);
  };

  const schedule = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    timer = setTimeout(emitBatch, debounceMs);
  };

  const putRow = (nodeKey: string, next: RowState): boolean => {
    const before = rowsByKey.get(nodeKey);
    const after: NodePositionRow | undefined = isEmptyRow(next)
      ? undefined
      : { tabId, rootSystemId, nodeKey, x: next.x, y: next.y, source: next.source, collapsed: next.collapsed };
    if (sameRow(before, after)) {
      return false;
    }
    if (after === undefined) {
      rowsByKey.delete(nodeKey);
    } else {
      rowsByKey.set(nodeKey, after);
    }
    revision += 1;
    rowRevision.set(nodeKey, revision);
    notify(nodeKey);
    return true;
  };

  const change = (nodeKey: string, patch: Partial<RowState>): void => {
    const base: RowState = rowsByKey.get(nodeKey) ?? { x: null, y: null, source: 'auto', collapsed: false };
    if (putRow(nodeKey, { x: base.x, y: base.y, source: base.source, collapsed: base.collapsed, ...patch })) {
      dirtyKeys.add(nodeKey);
      schedule();
    }
  };

  const setOffset = (value: number): void => {
    if (value === rootOffset) {
      return;
    }
    rootOffset = value;
    revision += 1;
    rootOffsetRevision = revision;
    rootOffsetDirty = true;
    schedule();
  };

  return {
    tab: () => ({ id: tabId, rootSystemId, rootOffset }),
    row: (nodeKey) => rowsByKey.get(nodeKey),
    rows: () => [...rowsByKey.values()],
    snapshot: () => ({ revision, tab: { id: tabId, rootSystemId, rootOffset }, rows: [...rowsByKey.values()] }),
    manualPositions: () =>
      [...rowsByKey.values()].flatMap((row) =>
        row.source === 'manual' && row.x !== null && row.y !== null
          ? [{ nodeKey: row.nodeKey, x: row.x, y: row.y }]
          : [],
      ),
    collapsedKeys: () => [...rowsByKey.values()].filter((row) => row.collapsed).map((row) => row.nodeKey),
    rootOffset: () => rootOffset,
    setManualPosition: (nodeKey, x, y) => change(nodeKey, { x, y, source: 'manual' }),
    setManualPositions: (positions) => {
      positions.forEach((position) => change(position.nodeKey, { x: position.x, y: position.y, source: 'manual' }));
    },
    resetPosition: (nodeKey) => change(nodeKey, { x: null, y: null, source: 'auto' }),
    clearManual: () => {
      [...rowsByKey.values()]
        .filter((row) => row.source === 'manual')
        .forEach((row) => change(row.nodeKey, { x: null, y: null, source: 'auto' }));
    },
    setCollapsed: (nodeKey, collapsed) => change(nodeKey, { collapsed }),
    setRootOffset: setOffset,
    writeBatch: (batch) => {
      batch.positions.forEach((entry) => change(entry.nodeKey, entry));
      if (batch.rootOffset !== undefined) {
        setOffset(batch.rootOffset);
      }
    },
    mergeUpdate: (update) => {
      update.positions.forEach((entry) => {
        const locallyChanged = (rowRevision.get(entry.nodeKey) ?? 0) > update.basedOnRevision;
        if (!locallyChanged && !dirtyKeys.has(entry.nodeKey)) {
          putRow(entry.nodeKey, entry);
        }
      });
      if (update.rootOffset !== undefined && rootOffsetRevision <= update.basedOnRevision && !rootOffsetDirty) {
        rootOffset = update.rootOffset;
      }
    },
    subscribeNode: (nodeKey, listener) => {
      const set = listeners.get(nodeKey) ?? new Set<NodeListener>();
      set.add(listener);
      listeners.set(nodeKey, set);
      return () => {
        set.delete(listener);
      };
    },
    flush: () => {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      emitBatch();
    },
    dispose: () => {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
    },
  };
}
