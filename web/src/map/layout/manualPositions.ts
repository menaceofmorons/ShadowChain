import type { ChainTree } from '../model/types';
import type { ManualPosition } from './types';

export function filterManualPositions(tree: ChainTree, positions: readonly ManualPosition[]): ManualPosition[] {
  const keys = new Set(tree.nodes.map((node) => node.keyString));
  return positions.filter((position) => keys.has(position.nodeKey));
}
