import type { ChainNode } from '../../../model/types';
import type { ManualPosition } from '../../types';

interface Point {
  readonly x: number;
  readonly y: number;
}

export function carryRadialSubtrees(
  root: ChainNode,
  base: ReadonlyMap<string, Point>,
  manualPositions: readonly ManualPosition[],
): Map<string, Point> {
  const manual = new Map(manualPositions.map((position) => [position.nodeKey, position]));
  const result = new Map<string, Point>();
  const visit = (node: ChainNode, parent: ChainNode | undefined): void => {
    const own = base.get(node.keyString);
    if (own === undefined) {
      return;
    }
    const pinned = manual.get(node.keyString);
    if (pinned !== undefined) {
      result.set(node.keyString, { x: pinned.x, y: pinned.y });
    } else if (parent === undefined) {
      result.set(node.keyString, own);
    } else {
      const parentBase = base.get(parent.keyString) as Point;
      const parentResult = result.get(parent.keyString) as Point;
      result.set(node.keyString, {
        x: parentResult.x + own.x - parentBase.x,
        y: parentResult.y + own.y - parentBase.y,
      });
    }
    for (const child of node.children) {
      visit(child, node);
    }
  };
  visit(root, undefined);
  return result;
}
