import type { LayoutEngine } from '../../layout/types';

export const createShiftingEngine = (inner: LayoutEngine, shift = 1): LayoutEngine => ({
  async layout(request) {
    const placed = await inner.layout(request);
    if (request.type === 'full') {
      return placed;
    }
    const previousKeys = new Set(request.previous.map((node) => node.nodeKey));
    return placed.map((node) => (previousKeys.has(node.nodeKey) ? { ...node, x: node.x + shift } : node));
  },
});
