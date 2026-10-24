import type { ChainTree } from '../model/types';

export type LayoutMode = 'top-down' | 'left-to-right' | 'radial';

export const LAYOUT_MODES: readonly LayoutMode[] = ['top-down', 'left-to-right', 'radial'];

export type PositionSource = 'auto' | 'manual';

export interface ManualPosition {
  readonly nodeKey: string;
  readonly x: number;
  readonly y: number;
}

export interface PlacedNode {
  readonly nodeKey: string;
  readonly x: number;
  readonly y: number;
  readonly source: PositionSource;
  readonly alias: boolean;
  readonly collapsed: boolean;
  readonly hiddenCount: number | null;
}

export interface FullLayoutRequest {
  readonly type: 'full';
  readonly tree: ChainTree;
  readonly mode: LayoutMode;
  readonly manualPositions: readonly ManualPosition[];
  readonly collapsedKeys?: readonly string[];
  readonly rootOffset?: number;
}

export interface IncrementalLayoutRequest {
  readonly type: 'incremental';
  readonly tree: ChainTree;
  readonly mode: LayoutMode;
  readonly manualPositions: readonly ManualPosition[];
  readonly collapsedKeys?: readonly string[];
  readonly rootOffset?: number;
  readonly previous: readonly PlacedNode[];
  readonly addedNodeKeys: readonly string[];
  readonly removedNodeKeys: readonly string[];
}

export type LayoutRequest = FullLayoutRequest | IncrementalLayoutRequest;

export type LayoutErrorCode = 'malformed-request' | 'engine-failure';

export interface LayoutErrorInfo {
  readonly code: LayoutErrorCode;
  readonly message: string;
}

export interface LayoutRequestMessage {
  readonly id: number;
  readonly request: LayoutRequest;
}

export type LayoutResponseMessage =
  | { readonly id: number; readonly ok: true; readonly nodes: readonly PlacedNode[] }
  | { readonly id: number; readonly ok: false; readonly error: LayoutErrorInfo };

export interface LayoutEngine {
  layout(request: LayoutRequest): readonly PlacedNode[] | Promise<readonly PlacedNode[]>;
}

export class LayoutError extends Error {
  readonly code: LayoutErrorCode;

  constructor(info: LayoutErrorInfo) {
    super(info.message);
    this.name = 'LayoutError';
    this.code = info.code;
  }
}
