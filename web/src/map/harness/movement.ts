import type { PlacedNode } from '../layout/types';

export const countMovedNodes = (previous: readonly PlacedNode[], next: readonly PlacedNode[]): number => {
  const current = new Map(next.map((node) => [node.nodeKey, node]));
  let moved = 0;
  for (const before of previous) {
    const after = current.get(before.nodeKey);
    if (after !== undefined && (after.x !== before.x || after.y !== before.y)) {
      moved += 1;
    }
  }
  return moved;
};
