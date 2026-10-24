import type { ChainNode } from '../../../model/types';
import { resolveEngineOptions } from '../../engineOptions';
import type { EngineOptions } from '../../engineOptions';
import { placementFlags } from '../../placementFlags';
import { LayoutError } from '../../types';
import type { LayoutEngine, LayoutMode, LayoutRequest, ManualPosition, PlacedNode } from '../../types';
import { incrementalSlots } from './incrementalPlacement';
import { carryManualSubtrees } from './relativeSubtrees';
import { childrenOf, extentOf, toPoint } from './tidyTreeGeometry';
import type { Slot } from './tidyTreeGeometry';

interface Contour {
  readonly left: number[];
  readonly right: number[];
}

function layoutSubtree(
  node: ChainNode,
  depth: number,
  mode: LayoutMode,
  options: EngineOptions,
  depths: Map<string, number>,
  levelAlong: number[],
): { contour: Contour; offsets: Map<string, number> } {
  const extent = extentOf(node, mode, options);
  levelAlong[depth] = Math.max(levelAlong[depth] ?? 0, extent.along);
  depths.set(node.keyString, depth);

  const half = extent.across / 2;
  const left = [-half];
  const right = [half];
  const children = childrenOf(node);
  if (children.length === 0) {
    return { contour: { left, right }, offsets: new Map() };
  }

  const accLeft: number[] = [];
  const accRight: number[] = [];
  const childOffsets: number[] = [];
  const subtreeOffsets = new Map<string, number>();
  const childCentreOffsets: Map<string, number>[] = [];
  children.forEach((child, index) => {
    const sub = layoutSubtree(child, depth + 1, mode, options, depths, levelAlong);
    let offset = 0;
    if (index > 0) {
      offset = Number.NEGATIVE_INFINITY;
      const shared = Math.min(accRight.length, sub.contour.left.length);
      for (let d = 0; d < shared; d += 1) {
        offset = Math.max(offset, (accRight[d] as number) + options.siblingSpacing - (sub.contour.left[d] as number));
      }
    }
    sub.contour.left.forEach((value, d) => {
      accLeft[d] = Math.min(accLeft[d] ?? Number.POSITIVE_INFINITY, value + offset);
    });
    sub.contour.right.forEach((value, d) => {
      accRight[d] = Math.max(accRight[d] ?? Number.NEGATIVE_INFINITY, value + offset);
    });
    childOffsets.push(offset);
    childCentreOffsets.push(sub.offsets);
  });

  const first = childOffsets[0] as number;
  const last = childOffsets[childOffsets.length - 1] as number;
  const shift = (first + last) / 2;

  children.forEach((child, index) => {
    const relative = (childOffsets[index] as number) - shift;
    subtreeOffsets.set(child.keyString, relative);
    for (const [key, value] of childCentreOffsets[index] as Map<string, number>) {
      subtreeOffsets.set(key, value + relative);
    }
  });

  accLeft.forEach((value, d) => {
    left[d + 1] = value - shift;
  });
  accRight.forEach((value, d) => {
    right[d + 1] = value - shift;
  });
  return { contour: { left, right }, offsets: subtreeOffsets };
}

function freshSlots(request: LayoutRequest, options: EngineOptions): Map<string, Slot> {
  const { root } = request.tree;
  const depths = new Map<string, number>();
  const levelAlong: number[] = [];
  const { offsets } = layoutSubtree(root, 0, request.mode, options, depths, levelAlong);

  const levelStart: number[] = [];
  let cursor = 0;
  levelAlong.forEach((size, depth) => {
    levelStart[depth] = cursor;
    cursor += size + options.levelSpacing;
  });

  const slots = new Map<string, Slot>();
  const nodes = [root, ...request.tree.nodes.filter((node) => node.keyString !== root.keyString)];
  for (const node of nodes) {
    const extent = extentOf(node, request.mode, options);
    const depth = depths.get(node.keyString);
    if (depth === undefined) {
      continue;
    }
    const centre = node.keyString === root.keyString ? 0 : (offsets.get(node.keyString) ?? 0);
    const band = levelAlong[depth] as number;
    slots.set(node.keyString, {
      across: centre - extent.across / 2 + (request.rootOffset ?? 0),
      along: (levelStart[depth] as number) + (band - extent.along) / 2,
    });
  }
  return slots;
}

function placeNodes(request: LayoutRequest, options: EngineOptions): PlacedNode[] {
  const slots =
    request.type === 'full'
      ? carryManualSubtrees(request.tree.root, request.mode, freshSlots(request, options), request.manualPositions)
      : incrementalSlots(request, options);
  const flags = (node: ChainNode) => placementFlags(request, node);
  const manual = new Map<string, ManualPosition>(
    request.manualPositions.map((position) => [position.nodeKey, position]),
  );
  return request.tree.nodes.flatMap((node): PlacedNode[] => {
    const slot = slots.get(node.keyString);
    if (slot === undefined) {
      return [];
    }
    const override = manual.get(node.keyString);
    if (override !== undefined) {
      return [{ nodeKey: node.keyString, x: override.x, y: override.y, source: 'manual' as const, ...flags(node) }];
    }
    return [{ nodeKey: node.keyString, ...toPoint(request.mode, slot), source: 'auto' as const, ...flags(node) }];
  });
}

export function createTidyTreeEngine(overrides: Partial<EngineOptions> = {}): LayoutEngine {
  const options = resolveEngineOptions(overrides);
  return {
    layout(request) {
      if (request.mode === 'radial') {
        throw new LayoutError({ code: 'malformed-request', message: 'tidy-tree does not support radial layout' });
      }
      return placeNodes(request, options);
    },
  };
}
