import type { NodePosition, PositionBatch } from './types';

export interface NominalNodeSize {
  readonly width: number;
  readonly height: number;
}

export const DEFAULT_NOMINAL_NODE_SIZE: NominalNodeSize = { width: 160, height: 48 };

export function nodesOverlap(
  a: NodePosition,
  b: NodePosition,
  size: NominalNodeSize = DEFAULT_NOMINAL_NODE_SIZE,
): boolean {
  return Math.abs(a.x - b.x) < size.width && Math.abs(a.y - b.y) < size.height;
}

export function newNodeOverlapsAny(
  outcome: readonly NodePosition[],
  newNodeKey: string,
  size: NominalNodeSize = DEFAULT_NOMINAL_NODE_SIZE,
): boolean {
  const added = outcome.find((node) => node.nodeKey === newNodeKey);
  if (added === undefined) {
    throw new Error(`New node missing from outcome: ${newNodeKey}`);
  }
  return outcome.some((node) => node.nodeKey !== newNodeKey && nodesOverlap(added, node, size));
}

export function movedPlacedNodes(before: readonly NodePosition[], after: readonly NodePosition[]): string[] {
  const afterByKey = new Map(after.map((node) => [node.nodeKey, node]));
  return before
    .filter((node) => {
      const next = afterByKey.get(node.nodeKey);
      return next === undefined || next.x !== node.x || next.y !== node.y;
    })
    .map((node) => node.nodeKey);
}

export function placedNodesUnmoved(before: readonly NodePosition[], after: readonly NodePosition[]): boolean {
  return movedPlacedNodes(before, after).length === 0;
}

export function newNodeOutcomeIsCorrect(
  start: readonly NodePosition[],
  outcome: readonly NodePosition[],
  newNodeKey: string,
  size: NominalNodeSize = DEFAULT_NOMINAL_NODE_SIZE,
): boolean {
  return !newNodeOverlapsAny(outcome, newNodeKey, size) && placedNodesUnmoved(start, outcome);
}

export function batchCarriesAllMoved(
  batch: PositionBatch,
  movedNodeKeys: readonly string[],
  expected: readonly NodePosition[],
): boolean {
  const byKey = new Map(batch.positions.map((node) => [node.nodeKey, node]));
  return movedNodeKeys.every((key) => {
    const want = expected.find((node) => node.nodeKey === key);
    const got = byKey.get(key);
    return want !== undefined && got !== undefined && got.x === want.x && got.y === want.y;
  });
}

export function applyBatch(state: readonly NodePosition[], batch: PositionBatch): NodePosition[] {
  const byKey = new Map(state.map((node) => [node.nodeKey, node]));
  for (const node of batch.positions) {
    byKey.set(node.nodeKey, node);
  }
  return [...byKey.values()];
}

export function staleUpdateRevertsMoved(
  stateAfterBatch: readonly NodePosition[],
  movedNodeKeys: readonly string[],
  staleUpdate: PositionBatch,
  mergeUpdate: (state: readonly NodePosition[], update: PositionBatch) => readonly NodePosition[],
): boolean {
  const result = new Map(mergeUpdate(stateAfterBatch, staleUpdate).map((n) => [n.nodeKey, n]));
  return movedNodeKeys.some((key) => {
    const kept = stateAfterBatch.find((node) => node.nodeKey === key);
    const now = result.get(key);
    return kept === undefined || now === undefined || now.x !== kept.x || now.y !== kept.y;
  });
}
