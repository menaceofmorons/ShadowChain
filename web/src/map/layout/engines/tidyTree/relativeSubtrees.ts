import type { ChainNode } from '../../../model/types';
import type { LayoutMode, ManualPosition } from '../../types';
import { childrenOf, toSlot } from './tidyTreeGeometry';
import type { Slot } from './tidyTreeGeometry';

const shiftedSlot = (slot: Slot, dAcross: number, dAlong: number): Slot => ({
  across: slot.across + dAcross,
  along: slot.along + dAlong,
});

export function carryManualSubtrees(
  root: ChainNode,
  mode: LayoutMode,
  base: ReadonlyMap<string, Slot>,
  manualPositions: readonly ManualPosition[],
): Map<string, Slot> {
  const manual = new Map(manualPositions.map((position) => [position.nodeKey, toSlot(mode, position.x, position.y)]));
  const result = new Map<string, Slot>();
  const visit = (node: ChainNode, parent: ChainNode | undefined): void => {
    const own = base.get(node.keyString);
    if (own === undefined) {
      return;
    }
    const pinned = manual.get(node.keyString);
    if (pinned !== undefined) {
      result.set(node.keyString, pinned);
    } else if (parent === undefined) {
      result.set(node.keyString, own);
    } else {
      const parentBase = base.get(parent.keyString) as Slot;
      const parentResult = result.get(parent.keyString) as Slot;
      result.set(
        node.keyString,
        shiftedSlot(parentResult, own.across - parentBase.across, own.along - parentBase.along),
      );
    }
    for (const child of childrenOf(node)) {
      visit(child, node);
    }
  };
  visit(root, undefined);
  return result;
}
