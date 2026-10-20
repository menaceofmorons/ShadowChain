import type { ChainNode } from '../../../model/types';
import { resolveEngineOptions } from '../../engineOptions';
import type { EngineOptions } from '../../engineOptions';
import { LayoutError } from '../../types';
import type { LayoutEngine, LayoutMode, LayoutRequest, ManualPosition, PlacedNode } from '../../types';

interface Slot {
  readonly across: number;
  readonly along: number;
}

interface Extent {
  readonly across: number;
  readonly along: number;
}

interface Rect {
  across: number;
  along: number;
  readonly acrossSize: number;
  readonly alongSize: number;
}

interface Contour {
  readonly left: number[];
  readonly right: number[];
}

const isAlias = (node: ChainNode): boolean => node.kind === 'alias';

const childrenOf = (node: ChainNode): readonly ChainNode[] => (isAlias(node) ? [] : node.children);

const extentOf = (node: ChainNode, mode: LayoutMode, options: EngineOptions): Extent => {
  const width = isAlias(node) ? options.aliasWidth : options.nodeWidth;
  const height = isAlias(node) ? options.aliasHeight : options.nodeHeight;
  return mode === 'top-down' ? { across: width, along: height } : { across: height, along: width };
};

const toSlot = (mode: LayoutMode, x: number, y: number): Slot =>
  mode === 'top-down' ? { across: x, along: y } : { across: y, along: x };

const toPoint = (mode: LayoutMode, slot: Slot): { x: number; y: number } =>
  mode === 'top-down' ? { x: slot.across, y: slot.along } : { x: slot.along, y: slot.across };

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
  const nodes = [root, ...request.tree.nodes.filter((node) => node !== root)];
  for (const node of nodes) {
    const extent = extentOf(node, request.mode, options);
    const depth = depths.get(node.keyString);
    if (depth === undefined) {
      continue;
    }
    const centre = node === root ? 0 : (offsets.get(node.keyString) ?? 0);
    const band = levelAlong[depth] as number;
    slots.set(node.keyString, {
      across: centre - extent.across / 2,
      along: (levelStart[depth] as number) + (band - extent.along) / 2,
    });
  }
  return slots;
}

const overlaps = (a: Rect, b: Rect): boolean =>
  a.across < b.across + b.acrossSize &&
  b.across < a.across + a.acrossSize &&
  a.along < b.along + b.alongSize &&
  b.along < a.along + a.alongSize;

function incrementalSlots(request: LayoutRequest, options: EngineOptions): Map<string, Slot> {
  if (request.type !== 'incremental') {
    return freshSlots(request, options);
  }
  const mode = request.mode;
  const nodes = new Map(request.tree.nodes.map((node) => [node.keyString, node]));
  const removed = new Set(request.removedNodeKeys);
  const slots = new Map<string, Slot>();
  const rects = new Map<string, Rect>();

  const remember = (node: ChainNode, slot: Slot): void => {
    const extent = extentOf(node, mode, options);
    slots.set(node.keyString, slot);
    rects.set(node.keyString, {
      across: slot.across,
      along: slot.along,
      acrossSize: extent.across,
      alongSize: extent.along,
    });
  };

  for (const prior of request.previous) {
    const node = nodes.get(prior.nodeKey);
    if (node !== undefined && !removed.has(prior.nodeKey)) {
      remember(node, toSlot(mode, prior.x, prior.y));
    }
  }

  const parents = new Map<string, ChainNode>();
  for (const node of request.tree.nodes) {
    for (const child of childrenOf(node)) {
      parents.set(child.keyString, node);
    }
  }

  const pending = new Set(request.addedNodeKeys);
  for (const node of request.tree.nodes) {
    if (slots.has(node.keyString) || !pending.has(node.keyString)) {
      continue;
    }
    placeAdded(node);
  }
  for (const node of request.tree.nodes) {
    if (!slots.has(node.keyString)) {
      placeAdded(node);
    }
  }
  return slots;

  function placeAdded(node: ChainNode): void {
    const extent = extentOf(node, mode, options);
    const parent = parents.get(node.keyString);
    const parentRect = parent === undefined ? undefined : rects.get(parent.keyString);
    let across = 0;
    let along = 0;
    if (parent !== undefined && parentRect !== undefined) {
      along = parentRect.along + parentRect.alongSize + options.levelSpacing;
      const earlier = childrenOf(parent)
        .slice(0, childrenOf(parent).indexOf(node))
        .map((sibling) => rects.get(sibling.keyString))
        .filter((rect): rect is Rect => rect !== undefined);
      const rightmost = earlier.reduce(
        (max, rect) => Math.max(max, rect.across + rect.acrossSize),
        Number.NEGATIVE_INFINITY,
      );
      across =
        earlier.length > 0
          ? rightmost + options.siblingSpacing
          : parentRect.across + parentRect.acrossSize / 2 - extent.across / 2;
    }
    const candidate: Rect = { across, along, acrossSize: extent.across, alongSize: extent.along };
    for (;;) {
      const blocker = [...rects.values()].find((rect) => overlaps(candidate, rect));
      if (blocker === undefined) {
        break;
      }
      candidate.across = blocker.across + blocker.acrossSize + options.siblingSpacing;
    }
    slots.set(node.keyString, { across: candidate.across, along: candidate.along });
    rects.set(node.keyString, candidate);
  }
}

function placeNodes(request: LayoutRequest, options: EngineOptions): PlacedNode[] {
  const slots = request.type === 'full' ? freshSlots(request, options) : incrementalSlots(request, options);
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
      return [
        { nodeKey: node.keyString, x: override.x, y: override.y, source: 'manual' as const, alias: isAlias(node) },
      ];
    }
    return [{ nodeKey: node.keyString, ...toPoint(request.mode, slot), source: 'auto' as const, alias: isAlias(node) }];
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
