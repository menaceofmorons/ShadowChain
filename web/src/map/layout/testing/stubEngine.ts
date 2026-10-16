import type { ChainNode } from '../../model/types';
import type { LayoutEngine, LayoutMode, LayoutRequest, PlacedNode } from '../types';

const SPACING = 100;

export interface StubEngineOptions {
  readonly offset?: number;
}

function place(mode: LayoutMode, depth: number, index: number, offset: number): { x: number; y: number } {
  const along = depth * SPACING + offset;
  const across = index * SPACING + offset;
  switch (mode) {
    case 'top-down':
      return { x: across, y: along };
    case 'left-to-right':
      return { x: along, y: across };
    case 'radial':
      return {
        x: Math.round(along * Math.cos(index)),
        y: Math.round(along * Math.sin(index)),
      };
  }
}

function autoPlacements(request: LayoutRequest, offset: number): Map<string, PlacedNode> {
  const nextIndex = new Map<number, number>();
  const placed = new Map<string, PlacedNode>();
  const visit = (node: ChainNode, depth: number): void => {
    const index = nextIndex.get(depth) ?? 0;
    nextIndex.set(depth, index + 1);
    placed.set(node.keyString, {
      nodeKey: node.keyString,
      ...place(request.mode, depth, index, offset),
      source: 'auto',
      alias: node.kind === 'alias',
    });
    node.children.forEach((child) => {
      visit(child, depth + 1);
    });
  };
  visit(request.tree.root, 0);
  return placed;
}

export function createStubEngine(options: StubEngineOptions = {}): LayoutEngine {
  const offset = options.offset ?? 0;
  return {
    layout(request) {
      const auto = autoPlacements(request, offset);
      const result = new Map<string, PlacedNode>();
      if (request.type === 'incremental') {
        const removed = new Set(request.removedNodeKeys);
        for (const prior of request.previous) {
          const current = auto.get(prior.nodeKey);
          if (current !== undefined && !removed.has(prior.nodeKey)) {
            result.set(prior.nodeKey, { ...prior, alias: current.alias });
          }
        }
      }
      for (const [key, node] of auto) {
        if (!result.has(key)) {
          result.set(key, node);
        }
      }
      for (const manual of request.manualPositions) {
        const node = result.get(manual.nodeKey);
        if (node !== undefined) {
          result.set(manual.nodeKey, { ...node, x: manual.x, y: manual.y, source: 'manual' });
        }
      }
      return [...result.values()];
    },
  };
}
