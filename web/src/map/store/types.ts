import type { PositionSource } from '../layout/types';

export interface NodePositionRow {
  readonly tabId: string;
  readonly rootSystemId: number | null;
  readonly nodeKey: string;
  readonly x: number | null;
  readonly y: number | null;
  readonly source: PositionSource;
  readonly collapsed: boolean;
}

export interface MapTabRow {
  readonly id: string;
  readonly rootSystemId: number | null;
  readonly rootOffset: number;
}

export interface NodeRowWrite {
  readonly nodeKey: string;
  readonly x: number | null;
  readonly y: number | null;
  readonly source: PositionSource;
  readonly collapsed: boolean;
}

export interface PositionsBatch {
  readonly positions: readonly NodeRowWrite[];
  readonly rootOffset?: number;
}

export interface PositionsUpdate extends PositionsBatch {
  readonly basedOnRevision: number;
}

export interface PositionStoreSnapshot {
  readonly revision: number;
  readonly tab: MapTabRow;
  readonly rows: readonly NodePositionRow[];
}

export type BatchSink = (batch: PositionsBatch) => void;
export type NodeListener = (row: NodePositionRow | undefined) => void;
