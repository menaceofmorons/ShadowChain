import ELK from 'elkjs/lib/elk.bundled.js';
import type { ElkNode, LayoutOptions } from 'elkjs/lib/elk-api';
import type { ChainNode } from '../../../model/types';
import { resolveEngineOptions } from '../../engineOptions';
import type { EngineOptions } from '../../engineOptions';
import type { LayoutEngine, LayoutMode, LayoutRequest, PlacedNode } from '../../types';

const RANDOM_SEED = '1';
const RADIAL_COMPACTION_STEP = '8';
const RING_STEP_GROWTH = 1.12;
const MAX_RING_STEP_ATTEMPTS = 60;
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

interface RadialSlot {
  readonly id: string;
  readonly depth: number;
  readonly angle: number;
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

function leafCounts(root: ChainNode): Map<string, number> {
  const counts = new Map<string, number>();
  const visit = (node: ChainNode): number => {
    const count = node.children.length === 0 ? 1 : node.children.reduce((sum, child) => sum + visit(child), 0);
    counts.set(node.keyString, count);
    return count;
  };
  visit(root);
  return counts;
}

function radialSlots(root: ChainNode, arranged: ElkNode, options: EngineOptions): RadialSlot[] {
  const elkCentres = new Map<string, Point>();
  for (const { id, x = 0, y = 0, width = 0, height = 0 } of arranged.children ?? []) {
    elkCentres.set(id, { x: x + width / 2, y: y + height / 2 });
  }
  const origin = elkCentres.get(root.keyString) ?? { x: 0, y: 0 };
  const elkAngle = (node: ChainNode): number => {
    const centre = elkCentres.get(node.keyString) ?? origin;
    return Math.atan2(centre.y - origin.y, centre.x - origin.x);
  };
  const leaves = leafCounts(root);
  const slots: RadialSlot[] = [];
  const spread = (node: ChainNode, depth: number, from: number, to: number): void => {
    const alias = node.kind === 'alias';
    slots.push({
      id: node.keyString,
      depth,
      angle: (from + to) / 2,
      width: alias ? options.aliasWidth : options.nodeWidth,
      height: alias ? options.aliasHeight : options.nodeHeight,
    });
    const total = leaves.get(node.keyString) ?? 1;
    const ordered = node.children
      .map((child) => ({ child, sweep: wrapAngle(elkAngle(child) - elkAngle(node)) + (depth === 0 ? FULL_TURN : 0) }))
      .sort((a, b) => a.sweep - b.sweep || a.child.keyString.localeCompare(b.child.keyString));
    let cursor = from;
    for (const { child } of ordered) {
      const share = ((to - from) * (leaves.get(child.keyString) ?? 1)) / total;
      spread(child, depth + 1, cursor, cursor + share);
      cursor += share;
    }
  };
  spread(root, 0, 0, FULL_TURN);
  return slots;
}

function ringBoxes(slots: readonly RadialSlot[], step: number) {
  return slots.map((slot) => {
    const radius = slot.depth * step;
    return {
      id: slot.id,
      left: radius * Math.cos(slot.angle) - slot.width / 2,
      top: radius * Math.sin(slot.angle) - slot.height / 2,
      width: slot.width,
      height: slot.height,
    };
  });
}

function hasOverlap(boxes: ReturnType<typeof ringBoxes>, gap: number): boolean {
  for (let i = 0; i < boxes.length; i += 1) {
    const a = boxes[i] as (typeof boxes)[number];
    for (let j = i + 1; j < boxes.length; j += 1) {
      const b = boxes[j] as (typeof boxes)[number];
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
  const slots = radialSlots(root, arranged, options);
  let step = options.nodeWidth + options.levelSpacing;
  let boxes = ringBoxes(slots, step);
  for (
    let attempt = 1;
    attempt < MAX_RING_STEP_ATTEMPTS && hasOverlap(boxes, options.siblingSpacing / 2);
    attempt += 1
  ) {
    step *= RING_STEP_GROWTH;
    boxes = ringBoxes(slots, step);
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
