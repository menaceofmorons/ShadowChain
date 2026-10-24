import type { ChainNode } from '../model/types';
import type { LayoutRequest, PlacedNode } from './types';

export function placementFlags(
  request: LayoutRequest,
  node: ChainNode | undefined,
): Pick<PlacedNode, 'alias' | 'collapsed' | 'hiddenCount'> {
  if (node === undefined) {
    return { alias: false, collapsed: false, hiddenCount: null };
  }
  return {
    alias: node.kind === 'alias',
    collapsed: request.collapsedKeys?.includes(node.keyString) ?? false,
    hiddenCount: node.kind === 'collapsed' ? node.hiddenCount : null,
  };
}
