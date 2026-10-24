import type { ChainNode } from '../../../model/types';
import { nodeSize } from '../../engineOptions';
import type { EngineOptions } from '../../engineOptions';
import type { LayoutMode } from '../../types';

export interface Slot {
  readonly across: number;
  readonly along: number;
}

export interface Extent {
  readonly across: number;
  readonly along: number;
}

export const childrenOf = (node: ChainNode): readonly ChainNode[] => (node.kind === 'alias' ? [] : node.children);

export const extentOf = (node: ChainNode, mode: LayoutMode, options: EngineOptions): Extent => {
  const { width, height } = nodeSize(node, options);
  return mode === 'top-down' ? { across: width, along: height } : { across: height, along: width };
};

export const toSlot = (mode: LayoutMode, x: number, y: number): Slot =>
  mode === 'top-down' ? { across: x, along: y } : { across: y, along: x };

export const toPoint = (mode: LayoutMode, slot: Slot): { x: number; y: number } =>
  mode === 'top-down' ? { x: slot.across, y: slot.along } : { x: slot.along, y: slot.across };
