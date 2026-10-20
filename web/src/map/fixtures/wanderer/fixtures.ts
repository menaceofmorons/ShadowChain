import type { MultiDragFixture, NewNodeOverlapFixture, NodePosition } from './types';

const at = (nodeKey: string, x: number, y: number): NodePosition => ({ nodeKey, x, y });

const RECONSTRUCTION_NOTE =
  'Reconstructed from the issue text; the issue publishes no graph or coordinates, so these are illustrative.';

export const wanderer553: NewNodeOverlapFixture = {
  source: {
    issueNumber: 553,
    url: 'https://github.com/wanderer-industries/wanderer/issues/553',
    summary:
      'Jumping into a new hole places the newly created system exactly on top of a neighbouring system, so it cannot be seen; reporter suggests offsetting new unmoved systems.',
  },
  reconstruction: { reconstructed: true, note: RECONSTRUCTION_NOTE },
  graph: {
    systems: [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }],
    connections: [
      { id: 1, createdAt: 1, endA: 1, endB: 2 },
      { id: 2, createdAt: 2, endA: 1, endB: 3 },
      { id: 3, createdAt: 3, endA: 1, endB: 4 },
      { id: 4, createdAt: 4, endA: 1, endB: 5 },
    ],
  },
  startPositions: [at('s:1', 0, 0), at('s:2', 300, -100), at('s:3', 300, 0), at('s:4', 300, 100)],
  newNodeKey: 's:5',
  step: 'Connection 4 from system 1 to new system 5 is added while systems 1 to 4 are already placed.',
  expected: 'System 5 overlaps no neighbour and no placed node moves.',
};

export const wanderer98: MultiDragFixture = {
  source: {
    issueNumber: 98,
    url: 'https://github.com/wanderer-industries/wanderer/issues/98',
    summary:
      'After dragging a multi-node selection only the dragged node position was saved; the others reverted on the next change (signature paste, settings edit, refresh).',
  },
  reconstruction: { reconstructed: true, note: RECONSTRUCTION_NOTE },
  startPositions: [at('s:1', 0, 0), at('s:2', 300, -100), at('s:3', 300, 0), at('s:4', 300, 100)],
  movedNodeKeys: ['s:2', 's:3', 's:4'],
  dragDelta: { dx: 50, dy: 40 },
  staleUpdate: {
    positions: [at('s:1', 0, 0), at('s:2', 300, -100), at('s:3', 300, 0), at('s:4', 300, 100)],
  },
  expected: 'One batch carries every moved node at its dragged position; the later stale update never reverts them.',
};
