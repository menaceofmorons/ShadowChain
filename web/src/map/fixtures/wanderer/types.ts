import type { ChainGraph } from '../../model/types';

export interface NodePosition {
  readonly nodeKey: string;
  readonly x: number;
  readonly y: number;
}

export interface FixtureSource {
  readonly issueNumber: number;
  readonly url: string;
  readonly summary: string;
}

export interface Reconstruction {
  readonly reconstructed: true;
  readonly note: string;
}

export interface NewNodeOverlapFixture {
  readonly source: FixtureSource;
  readonly reconstruction: Reconstruction;
  readonly graph: ChainGraph;
  readonly startPositions: readonly NodePosition[];
  readonly newNodeKey: string;
  readonly step: string;
  readonly expected: string;
}

export interface PositionBatch {
  readonly positions: readonly NodePosition[];
}

export interface MultiDragFixture {
  readonly source: FixtureSource;
  readonly reconstruction: Reconstruction;
  readonly startPositions: readonly NodePosition[];
  readonly movedNodeKeys: readonly string[];
  readonly dragDelta: { readonly dx: number; readonly dy: number };
  readonly staleUpdate: PositionBatch;
  readonly expected: string;
}
