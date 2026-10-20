import { describe, expect, it } from 'vitest';
import { buildChainTree } from '../../model/chainTree';
import {
  applyBatch,
  batchCarriesAllMoved,
  movedPlacedNodes,
  newNodeOutcomeIsCorrect,
  newNodeOverlapsAny,
  placedNodesUnmoved,
  staleUpdateRevertsMoved,
} from './assertions';
import { wanderer553, wanderer98 } from './fixtures';
import type { NodePosition, PositionBatch } from './types';

const at = (nodeKey: string, x: number, y: number): NodePosition => ({ nodeKey, x, y });

describe.each([wanderer553, wanderer98])('fixture $source.issueNumber', (fixture) => {
  it('carries a source reference and is marked reconstructed', () => {
    expect(fixture.source.url).toBe(
      `https://github.com/wanderer-industries/wanderer/issues/${fixture.source.issueNumber}`,
    );
    expect(fixture.source.summary.length).toBeGreaterThan(0);
    expect(fixture.reconstruction.reconstructed).toBe(true);
    expect(fixture.expected.length).toBeGreaterThan(0);
  });
});

describe('wanderer #553', () => {
  const { startPositions, newNodeKey, graph } = wanderer553;
  const neighbour = startPositions[1]!;

  it('graph builds a tree containing the new node', () => {
    const tree = buildChainTree(graph, 1);
    expect(tree.nodes.map((n) => n.keyString)).toContain(newNodeKey);
  });

  it('accepts a correct outcome', () => {
    const outcome = [...startPositions, at(newNodeKey, 600, 200)];
    expect(newNodeOverlapsAny(outcome, newNodeKey)).toBe(false);
    expect(newNodeOutcomeIsCorrect(startPositions, outcome, newNodeKey)).toBe(true);
  });

  it('fails the reported outcome of landing exactly on a neighbour', () => {
    const outcome = [...startPositions, at(newNodeKey, neighbour.x, neighbour.y)];
    expect(newNodeOverlapsAny(outcome, newNodeKey)).toBe(true);
    expect(newNodeOutcomeIsCorrect(startPositions, outcome, newNodeKey)).toBe(false);
  });

  it('fails when a placed node moves', () => {
    const outcome = [at('s:1', 5, 0), ...startPositions.slice(1), at(newNodeKey, 600, 200)];
    expect(placedNodesUnmoved(startPositions, outcome)).toBe(false);
    expect(movedPlacedNodes(startPositions, outcome)).toEqual(['s:1']);
    expect(newNodeOutcomeIsCorrect(startPositions, outcome, newNodeKey)).toBe(false);
  });

  it('honours a configured node size', () => {
    const outcome = [...startPositions, at(newNodeKey, neighbour.x + 10, neighbour.y)];
    expect(newNodeOverlapsAny(outcome, newNodeKey, { width: 5, height: 5 })).toBe(false);
    expect(newNodeOverlapsAny(outcome, newNodeKey)).toBe(true);
  });
});

describe('wanderer #98', () => {
  const { startPositions, movedNodeKeys, dragDelta, staleUpdate } = wanderer98;
  const dragged = startPositions.map((node) =>
    movedNodeKeys.includes(node.nodeKey) ? at(node.nodeKey, node.x + dragDelta.dx, node.y + dragDelta.dy) : node,
  );
  const expectedMoved = dragged.filter((node) => movedNodeKeys.includes(node.nodeKey));
  const correctBatch: PositionBatch = { positions: expectedMoved };
  const buggyBatch: PositionBatch = { positions: expectedMoved.slice(0, 1) };

  const naiveMerge = applyBatch;
  const guardedMerge = (state: readonly NodePosition[], update: PositionBatch) =>
    applyBatch(state, { positions: update.positions.filter((node) => !movedNodeKeys.includes(node.nodeKey)) });

  it('accepts a batch carrying every moved node', () => {
    expect(batchCarriesAllMoved(correctBatch, movedNodeKeys, expectedMoved)).toBe(true);
  });

  it('fails the reported outcome of only the dragged node being saved', () => {
    expect(batchCarriesAllMoved(buggyBatch, movedNodeKeys, expectedMoved)).toBe(false);
  });

  it('detects a stale update reverting moved nodes', () => {
    const state = applyBatch(startPositions, correctBatch);
    expect(staleUpdateRevertsMoved(state, movedNodeKeys, staleUpdate, naiveMerge)).toBe(true);
  });

  it('accepts a merge where the stale update never reverts moved nodes', () => {
    const state = applyBatch(startPositions, correctBatch);
    expect(staleUpdateRevertsMoved(state, movedNodeKeys, staleUpdate, guardedMerge)).toBe(false);
  });
});
