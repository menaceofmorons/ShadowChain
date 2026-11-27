import { describe, expect, it } from 'vitest';
import type { CanvasEdge, CanvasNode } from '../canvasAdapter';
import { buildFlowEdges } from './flowEdges';

const NODES: CanvasNode[] = ['a', 'b', 'c'].map((key) => ({ key, x: 0, y: 0, isAlias: false }));
const size = () => ({ width: 10, height: 10 });

describe('synthetic edge ids', () => {
  it('keeps a +N edge id when an earlier edge is removed', () => {
    const marker: CanvasEdge = { connectionId: -2, sourceKey: 'a', targetKey: 'c' };
    const before = buildFlowEdges(
      NODES,
      [{ connectionId: 1, sourceKey: 'a', targetKey: 'b' }, marker],
      'top-down',
      size,
      new Map(),
    );
    const after = buildFlowEdges(NODES, [{ ...marker, connectionId: -1 }], 'top-down', size, before.cache);
    expect(after.edges[0]?.id).toBe(before.edges[1]?.id);
    expect(after.edges[0]).toBe(before.edges[1]);
  });
});
