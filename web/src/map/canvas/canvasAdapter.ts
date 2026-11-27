import type { ReactNode } from 'react';
import type { ConnectionEncoding } from '../encoding';
import type { LayoutMode } from '../layout/types';
import type { ConnectionId } from '../model/nodeKey';
import type { CanvasGesture } from './interaction/gestures';

export interface CanvasNode {
  key: string;
  x: number;
  y: number;
  isAlias: boolean;
  hiddenCount?: number | null;
  isRoot?: boolean;
  canCollapse?: boolean;
  label?: string;
}

export interface CanvasEdge {
  connectionId: ConnectionId;
  sourceKey: string;
  targetKey: string;
  encodings?: readonly ConnectionEncoding[];
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
  onGesture?: (gesture: CanvasGesture) => void | Promise<void>;
}
