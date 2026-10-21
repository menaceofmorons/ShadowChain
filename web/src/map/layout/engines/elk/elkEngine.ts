import ELK from 'elkjs/lib/elk.bundled.js';
import type { ElkNode, LayoutOptions } from 'elkjs/lib/elk-api';
import type { ChainNode } from '../../../model/types';
import { resolveEngineOptions } from '../../engineOptions';
import type { EngineOptions } from '../../engineOptions';
import type { LayoutEngine, LayoutMode, LayoutRequest, PlacedNode } from '../../types';

const RANDOM_SEED = '1';
const RADIAL_COMPACTION_STEP = '8';
const RING_STEP_GROWTH = 1.03;
const MAX_RING_STEP_ATTEMPTS = 200;
const FULL_TURN = 2 * Math.PI;

// TUNE: initial radial radius per sqrt(node count) handed to elkjs, which only supplies child order.
const RADIAL_RADIUS_PER_SQRT_NODE = 100;

const initialRadialRadius = (nodeCount: number, options: EngineOptions): number =>
  Math.max(options.levelSpacing + 2 * options.nodeWidth, Math.ceil(RADIAL_RADIUS_PER_SQRT_NODE * Math.sqrt(nodeCount)));

function modeOptions(mode: LayoutMode, options: EngineOptions, radialRadius: number): LayoutOptions {
  const common: LayoutOptions = {
    'elk.randomSeed': RANDOM_SEED,
    'elk.spacing.nodeNode': String(options.siblingSpacing),
    'elk.edgeRouting': 'POLYLINE',
  };
  switch (mode) {
    case 'top-down':
      return { ...common, 'elk.algorithm': 'mrtree', 'elk.direction': 'DOWN' };
    case 'left-to-right':
      return { ...common, 'elk.algorithm': 'mrtree', 'elk.direction': 'RIGHT' };
    case 'radial':
      return {
        ...common,
        'elk.algorithm': 'radial',
        'elk.radial.radius': String(radialRadius),
        'elk.radial.centerOnRoot': 'true',
        'elk.radial.wedgeCriteria': 'LEAF_NUMBER',
        'elk.radial.compactor': 'RADIAL_COMPACTION',
        'elk.radial.compactionStepSize': RADIAL_COMPACTION_STEP,
      };
  }
}

function toElkGraph(request: LayoutRequest, options: EngineOptions, radialRadius: number): ElkNode {
  const children: ElkNode[] = [];
  const edges: { id: string; sources: string[]; targets: string[] }[] = [];
  const visit = (node: ChainNode): void => {
    const alias = node.kind === 'alias';
    children.push({
      id: node.keyString,
      width: alias ? options.aliasWidth : options.nodeWidth,
      height: alias ? options.aliasHeight : options.nodeHeight,
    });
    for (const child of node.children) {
      edges.push({ id: `${node.keyString}>${child.keyString}`, sources: [node.keyString], targets: [child.keyString] });
      visit(child);
    }
  };
  visit(request.tree.root);
  return {
    id: 'root',
    layoutOptions: modeOptions(request.mode, options, radialRadius),
    children,
    edges,
  };
}

interface Point {
  readonly x: number;
  readonly y: number;
}

interface Ring {
  readonly ids: string[];
  readonly widths: number[];
  readonly heights: number[];
  readonly parents: number[];
}

interface Box {
  readonly id: string;
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

const toHundredths = (value: number): number => Math.round(value * 100) / 100;

const wrapAngle = (angle: number): number => {
  const turned = angle % FULL_TURN;
  if (turned > Math.PI) {
    return turned - FULL_TURN;
  }
  return turned <= -Math.PI ? turned + FULL_TURN : turned;
};

function buildRings(root: ChainNode, arranged: ElkNode, options: EngineOptions): Ring[] {
  const elkCentres = new Map<string, Point>();
  for (const { id, x = 0, y = 0, width = 0, height = 0 } of arranged.children ?? []) {
    elkCentres.set(id, { x: x + width / 2, y: y + height / 2 });
  }
  const origin = elkCentres.get(root.keyString) ?? { x: 0, y: 0 };
  const elkAngle = (node: ChainNode): number => {
    const centre = elkCentres.get(node.keyString) ?? origin;
    return Math.atan2(centre.y - origin.y, centre.x - origin.x);
  };
  const rings: Ring[] = [];
  const visit = (node: ChainNode, depth: number, parent: number): void => {
    const alias = node.kind === 'alias';
    const ring = (rings[depth] ??= { ids: [], widths: [], heights: [], parents: [] });
    const index = ring.ids.length;
    ring.ids.push(node.keyString);
    ring.widths.push(alias ? options.aliasWidth : options.nodeWidth);
    ring.heights.push(alias ? options.aliasHeight : options.nodeHeight);
    ring.parents.push(parent);
    const ordered = node.children
      .map((child) => ({ child, sweep: wrapAngle(elkAngle(child) - elkAngle(node)) + (depth === 0 ? FULL_TURN : 0) }))
      .sort((a, b) => a.sweep - b.sweep || a.child.keyString.localeCompare(b.child.keyString));
    for (const { child } of ordered) {
      visit(child, depth + 1, index);
    }
  };
  visit(root, 0, -1);
  return rings;
}

function nonDecreasingFit(values: readonly number[]): number[] {
  const blocks: { sum: number; count: number }[] = [];
  for (const value of values) {
    blocks.push({ sum: value, count: 1 });
    while (blocks.length > 1) {
      const last = blocks[blocks.length - 1] as { sum: number; count: number };
      const before = blocks[blocks.length - 2] as { sum: number; count: number };
      if (before.sum / before.count <= last.sum / last.count) {
        break;
      }
      blocks.splice(blocks.length - 2, 2, { sum: before.sum + last.sum, count: before.count + last.count });
    }
  }
  return blocks.flatMap(({ sum, count }) => Array.from({ length: count }, () => sum / count));
}

function spaceOnRing(targets: readonly number[], gap: number): number[] {
  const count = targets.length;
  const fitted = nonDecreasingFit(targets.map((target, index) => target - index * gap));
  const lowest = gap / 2;
  const highest = FULL_TURN - gap / 2 - (count - 1) * gap;
  return fitted.map((value, index) => Math.min(Math.max(value, lowest), highest) + index * gap);
}

function ringAngles(rings: readonly Ring[], step: number, slot: number): number[][] | null {
  const angles: number[][] = [[0]];
  for (let depth = 1; depth < rings.length; depth += 1) {
    const ring = rings[depth] as Ring;
    const gap = 2 * Math.asin(Math.min(1, slot / (2 * depth * step)));
    if (ring.ids.length * gap > FULL_TURN) {
      return null;
    }
    const before = angles[depth - 1] as number[];
    const targets =
      depth === 1
        ? ring.ids.map((_, index) => ((index + 0.5) * FULL_TURN) / ring.ids.length)
        : ring.parents.map((parent) => before[parent] as number);
    angles.push(spaceOnRing(targets, gap));
  }
  return angles;
}

function ringBoxes(rings: readonly Ring[], angles: readonly (readonly number[])[], step: number): Box[] {
  return rings.flatMap((ring, depth) =>
    ring.ids.map((id, index) => {
      const width = ring.widths[index] as number;
      const height = ring.heights[index] as number;
      const angle = (angles[depth] as readonly number[])[index] as number;
      return {
        id,
        left: depth * step * Math.cos(angle) - width / 2,
        top: depth * step * Math.sin(angle) - height / 2,
        width,
        height,
      };
    }),
  );
}

function hasOverlap(boxes: readonly Box[], gap: number): boolean {
  for (let i = 0; i < boxes.length; i += 1) {
    const a = boxes[i] as Box;
    for (let j = i + 1; j < boxes.length; j += 1) {
      const b = boxes[j] as Box;
      if (
        a.left < b.left + b.width + gap &&
        b.left < a.left + a.width + gap &&
        a.top < b.top + b.height + gap &&
        b.top < a.top + a.height + gap
      ) {
        return true;
      }
    }
  }
  return false;
}

function placeOnFixedRings(
  root: ChainNode,
  arranged: ElkNode,
  options: EngineOptions,
): { id: string; x: number; y: number }[] {
  const rings = buildRings(root, arranged, options);
  const gap = options.siblingSpacing / 2;
  const slot = Math.hypot(options.nodeWidth + gap, options.nodeHeight + gap);
  const crowding = Math.max(
    ...rings.map((ring, depth) => (depth === 0 ? 0 : (ring.ids.length * slot) / (FULL_TURN * depth))),
  );
  let step = Math.max(options.nodeWidth + options.levelSpacing, crowding);
  let boxes: Box[] = [];
  for (let attempt = 0; attempt < MAX_RING_STEP_ATTEMPTS; attempt += 1) {
    const angles = ringAngles(rings, step, slot);
    boxes = angles === null ? [] : ringBoxes(rings, angles, step);
    if (angles !== null && !hasOverlap(boxes, gap / 2)) {
      break;
    }
    step *= RING_STEP_GROWTH;
  }
  const minLeft = Math.min(...boxes.map((box) => box.left));
  const minTop = Math.min(...boxes.map((box) => box.top));
  return boxes.map((box) => ({ id: box.id, x: toHundredths(box.left - minLeft), y: toHundredths(box.top - minTop) }));
}

function applyManual(placed: Map<string, PlacedNode>, request: LayoutRequest): void {
  for (const manual of request.manualPositions) {
    const node = placed.get(manual.nodeKey);
    if (node !== undefined) {
      placed.set(manual.nodeKey, { ...node, x: manual.x, y: manual.y, source: 'manual' });
    }
  }
}

export function createElkEngine(overrides: Partial<EngineOptions> = {}): LayoutEngine {
  const options = resolveEngineOptions(overrides);
  const elk = new ELK();
  return {
    async layout(request) {
      const radius = initialRadialRadius(request.tree.nodes.length, options);
      const arranged = await elk.layout(toElkGraph(request, options, radius));
      const laidOut: ElkNode =
        request.mode === 'radial'
          ? { ...arranged, children: placeOnFixedRings(request.tree.root, arranged, options) }
          : arranged;
      const aliasByKey = new Map(request.tree.nodes.map((node) => [node.keyString, node.kind === 'alias']));
      const placed = new Map<string, PlacedNode>();
      for (const child of laidOut.children ?? []) {
        placed.set(child.id, {
          nodeKey: child.id,
          x: child.x ?? 0,
          y: child.y ?? 0,
          source: 'auto',
          alias: aliasByKey.get(child.id) ?? false,
        });
      }
      applyManual(placed, request);
      return [...placed.values()];
    },
  };
}
