import type { LayoutMode } from '../layout/types';

export interface CanvasNode {
  key: string;
  x: number;
  y: number;
  isAlias: boolean;
  hiddenCount?: number | null;
}

export interface CanvasEdge {
  connectionId: string;
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
  onNodeSelect: (key: string) => void;
  onNodesMoved: (moved: readonly MovedNode[]) => void;
}
