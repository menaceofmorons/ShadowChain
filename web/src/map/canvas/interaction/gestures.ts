import type { LayoutMode } from '../../layout/types';
import type { CanvasNodeKind } from '../nodeKinds';
import { acrossDelta, type Point } from './rootAxis';

export type CanvasGesture =
  | { readonly type: 'drag-node'; readonly key: string; readonly to: Point }
  | { readonly type: 'drag-node-alone'; readonly key: string; readonly to: Point }
  | { readonly type: 'drag-group'; readonly keys: readonly string[]; readonly delta: { dx: number; dy: number } }
  | { readonly type: 'move-root'; readonly delta: number }
  | { readonly type: 'reset-position'; readonly key: string }
  | { readonly type: 'set-collapsed'; readonly key: string; readonly collapsed: boolean };

export interface DraggedNode {
  readonly key: string;
  readonly kind: CanvasNodeKind;
  readonly isRoot: boolean;
  readonly start: Point;
  readonly end: Point;
}

export interface DragInput {
  readonly mode: LayoutMode;
  readonly alone: boolean;
  readonly nodes: readonly DraggedNode[];
}

const hasMoved = (node: DraggedNode): boolean => node.start.x !== node.end.x || node.start.y !== node.end.y;

export function planDrag({ mode, alone, nodes }: DragInput): CanvasGesture | null {
  const moved = nodes.filter((node) => node.kind !== 'collapsed' && hasMoved(node));
  const others = moved.filter((node) => !node.isRoot);
  const [first] = others;
  if (first === undefined) {
    const root = moved.find((node) => node.isRoot);
    if (root === undefined) {
      return null;
    }
    const delta = acrossDelta(mode, root.start, root.end);
    return delta === 0 ? null : { type: 'move-root', delta };
  }
  if (others.length === 1) {
    return { type: alone ? 'drag-node-alone' : 'drag-node', key: first.key, to: first.end };
  }
  return {
    type: 'drag-group',
    keys: others.map((node) => node.key),
    delta: { dx: first.end.x - first.start.x, dy: first.end.y - first.start.y },
  };
}

export interface MenuTarget {
  readonly key: string;
  readonly kind: CanvasNodeKind;
  readonly isRoot: boolean;
  readonly canCollapse: boolean;
}

export interface MenuItem {
  readonly id: 'collapse' | 'expand' | 'reset';
  readonly label: string;
  readonly gesture: CanvasGesture;
}

export function menuItemsFor({ key, kind, isRoot, canCollapse }: MenuTarget): MenuItem[] {
  if (kind === 'collapsed') {
    return [{ id: 'expand', label: 'Expand', gesture: { type: 'set-collapsed', key, collapsed: false } }];
  }
  const items: MenuItem[] = [];
  if (canCollapse && kind === 'system' && !isRoot) {
    items.push({ id: 'collapse', label: 'Collapse', gesture: { type: 'set-collapsed', key, collapsed: true } });
  }
  if (!isRoot) {
    items.push({ id: 'reset', label: 'Reset position', gesture: { type: 'reset-position', key } });
  }
  return items;
}
