import type { ReactNode } from 'react';
import type { LayoutMode } from '../layout/types';
import type { ConnectionId } from '../model/nodeKey';

export interface CanvasNode {
  key: string;
  x: number;
  y: number;
  isAlias: boolean;
  hiddenCount?: number | null;
  isRoot?: boolean;
}

export interface CanvasEdge {
  connectionId: ConnectionId;
  sourceKey: string;
  targetKey: string;
}

export interface MovedNode {
  key: string;
  x: number;
  y: number;
}

export interface CanvasAdapterProps {
  nodes: readonly CanvasNode[];
  edges: readonly CanvasEdge[];
  mode?: LayoutMode;
  children?: ReactNode;
  onNodeSelect: (key: string) => void;
  onNodesMoved: (moved: readonly MovedNode[]) => void;
}
