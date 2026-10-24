import ELK from 'elkjs/lib/elk.bundled.js';
import type { ElkNode, LayoutOptions } from 'elkjs/lib/elk-api';
import type { ChainNode } from '../../../model/types';
import { nodeSize, resolveEngineOptions } from '../../engineOptions';
import type { EngineOptions } from '../../engineOptions';
import { placementFlags } from '../../placementFlags';
import type { LayoutEngine, LayoutMode, LayoutRequest, PlacedNode } from '../../types';
import { placeRadialIncrementally } from './radialIncremental';
import { carryRadialSubtrees } from './radialRelativeSubtrees';

const RANDOM_SEED = '1';
const RING_STEP_GROWTH = 1.03;
const MAX_RING_STEP_ATTEMPTS = 200;
// TUNE: total widening passes allowed for one full radial layout, shared across ring growth attempts.
const MAX_WIDENINGS = 20000;
const WIDEN_FRACTION = 0.1;
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
        'elk.radial.compactor': 'NONE',
      };
  }
}

function toElkGraph(request: LayoutRequest, options: EngineOptions, radialRadius: number): ElkNode {
  const children: ElkNode[] = [];
  const edges: { id: string; sources: string[]; targets: string[] }[] = [];
  const visit = (node: ChainNode): void => {
    children.push({ id: node.keyString, ...nodeSize(node, options) });
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

interface Slot {
  readonly id: string;
  readonly width: number;
  readonly height: number;
  readonly angle: number;
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

function orderChildren(root: ChainNode, arranged: ElkNode): Map<string, ChainNode[]> {
  const elkCentres = new Map<string, Point>();
  for (const { id, x = 0, y = 0, width = 0, height = 0 } of arranged.children ?? []) {
    elkCentres.set(id, { x: x + width / 2, y: y + height / 2 });
  }
  const origin = elkCentres.get(root.keyString) ?? { x: 0, y: 0 };
  const elkAngle = (node: ChainNode): number => {
    const centre = elkCentres.get(node.keyString) ?? origin;
    return Math.atan2(centre.y - origin.y, centre.x - origin.x);
  };
  const ordered = new Map<string, ChainNode[]>();
  const visit = (node: ChainNode, depth: number): void => {
    const turn = (child: ChainNode): number =>
      wrapAngle(elkAngle(child) - elkAngle(node)) + (depth === 0 ? FULL_TURN : 0);
    const children = [...node.children].sort((a, b) => turn(a) - turn(b) || a.keyString.localeCompare(b.keyString));
    ordered.set(node.keyString, children);
    children.forEach((child) => {
      visit(child, depth + 1);
    });
  };
  visit(root, 0);
  return ordered;
}

const minTurn = (radius: number, slot: number): number => 2 * Math.asin(Math.min(1, slot / (2 * radius)));

function angleNeeds(
  root: ChainNode,
  ordered: ReadonlyMap<string, ChainNode[]>,
  radii: readonly number[],
  slot: number,
) {
  const needs = new Map<string, number>();
  const visit = (node: ChainNode, depth: number): number => {
    const below = (ordered.get(node.keyString) ?? []).reduce((sum, child) => sum + visit(child, depth + 1), 0);
    const need = Math.max(below, depth === 0 ? 0 : minTurn(radii[depth] as number, slot));
    needs.set(node.keyString, need);
    return need;
  };
  visit(root, 0);
  return needs;
}

function levelShares(
  root: ChainNode,
  ordered: ReadonlyMap<string, ChainNode[]>,
  needs: ReadonlyMap<string, number>,
  levelTotal: number,
  slot: number,
  radii: readonly number[],
): number[] {
  const shares = Array.from({ length: levelTotal }, () => 0);
  const visit = (node: ChainNode, depth: number): void => {
    const children = ordered.get(node.keyString) ?? [];
    const below = children.reduce((sum, child) => sum + (needs.get(child.keyString) as number), 0);
    if (depth > 0 && (children.length === 0 || minTurn(radii[depth] as number, slot) >= below)) {
      shares[depth] = (shares[depth] as number) + (needs.get(node.keyString) as number);
      return;
    }
    children.forEach((child) => {
      visit(child, depth + 1);
    });
  };
  visit(root, 0);
  return shares;
}

const cumulative = (steps: readonly number[]): number[] => {
  let radius = 0;
  return steps.map((step) => (radius += step));
};

function levelRadii(
  root: ChainNode,
  ordered: ReadonlyMap<string, ChainNode[]>,
  levelCounts: readonly number[],
  minStep: number,
  slot: number,
  budget: { left: number },
): number[] {
  const steps = levelCounts.map((_, depth) => (depth === 0 ? 0 : minStep));
  let radii = cumulative(steps);
  while (budget.left > 0) {
    budget.left -= 1;
    const needs = angleNeeds(root, ordered, radii, slot);
    if ((needs.get(root.keyString) as number) <= FULL_TURN) {
      break;
    }
    const shares = levelShares(root, ordered, needs, radii.length, slot, radii);
    let best = 1;
    let bestGain = -1;
    for (let depth = radii.length - 1; depth >= 1; depth -= 1) {
      const gain = shares[depth] as number;
      if (gain > bestGain) {
        bestGain = gain;
        best = depth;
      }
    }
    steps[best] = (steps[best] as number) + Math.max(minStep * WIDEN_FRACTION, (radii.at(-1) as number) * 0.005);
    radii = cumulative(steps);
  }
  return radii;
}

function wedgeSlots(
  root: ChainNode,
  ordered: ReadonlyMap<string, ChainNode[]>,
  needs: ReadonlyMap<string, number>,
  options: EngineOptions,
): Slot[][] {
  const levels: Slot[][] = [];
  const visit = (node: ChainNode, depth: number, start: number, end: number): void => {
    (levels[depth] ??= []).push({
      id: node.keyString,
      ...nodeSize(node, options),
      angle: depth === 0 ? 0 : (start + end) / 2,
    });
    const children = ordered.get(node.keyString) ?? [];
    const total = children.reduce((sum, child) => sum + (needs.get(child.keyString) as number), 0);
    let cursor = start;
    for (const child of children) {
      const share = ((end - start) * (needs.get(child.keyString) as number)) / total;
      visit(child, depth + 1, cursor, cursor + share);
      cursor += share;
    }
  };
  visit(root, 0, 0, FULL_TURN);
  return levels;
}

function levelBoxes(levels: readonly (readonly Slot[])[], radii: readonly number[]): Box[] {
  return levels.flatMap((level, depth) =>
    level.map(({ id, width, height, angle }) => ({
      id,
      left: (radii[depth] as number) * Math.cos(angle) - width / 2,
      top: (radii[depth] as number) * Math.sin(angle) - height / 2,
      width,
      height,
    })),
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

function placeOnLevelRings(
  root: ChainNode,
  arranged: ElkNode,
  options: EngineOptions,
): { id: string; x: number; y: number }[] {
  const ordered = orderChildren(root, arranged);
  const gap = options.siblingSpacing / 2;
  const slot = options.nodeWidth + gap;
  const minStep = Math.max(options.nodeWidth + options.levelSpacing, slot);
  const levelCounts: number[] = [];
  const count = (node: ChainNode, depth: number): void => {
    levelCounts[depth] = (levelCounts[depth] ?? 0) + 1;
    (ordered.get(node.keyString) ?? []).forEach((child) => {
      count(child, depth + 1);
    });
  };
  count(root, 0);
  let growth = 1;
  const budget = { left: MAX_WIDENINGS };
  let boxes: Box[] = [];
  for (let attempt = 0; attempt < MAX_RING_STEP_ATTEMPTS; attempt += 1) {
    const radii = levelRadii(root, ordered, levelCounts, minStep * growth, slot * growth, budget);
    const needs = angleNeeds(root, ordered, radii, slot * growth);
    boxes = levelBoxes(wedgeSlots(root, ordered, needs, options), radii);
    if (!hasOverlap(boxes, gap / 2)) {
      break;
    }
    growth *= RING_STEP_GROWTH;
  }
  const minLeft = Math.min(...boxes.map((box) => box.left));
  const minTop = Math.min(...boxes.map((box) => box.top));
  return boxes.map((box) => ({ id: box.id, x: toHundredths(box.left - minLeft), y: toHundredths(box.top - minTop) }));
}

function applyManual(placed: Map<string, PlacedNode>, request: LayoutRequest): void {
  if (request.mode === 'radial') {
    const carried = carryRadialSubtrees(request.tree.root, placed, request.manualPositions);
    const manualKeys = new Set(request.manualPositions.map((position) => position.nodeKey));
    for (const [key, spot] of carried) {
      const node = placed.get(key) as PlacedNode;
      if (manualKeys.has(key)) {
        placed.set(key, { ...node, x: spot.x, y: spot.y, source: 'manual' });
      } else {
        placed.set(key, { ...node, x: toHundredths(spot.x), y: toHundredths(spot.y) });
      }
    }
    return;
  }
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
      if (request.type === 'incremental' && request.mode === 'radial') {
        const spots = placeRadialIncrementally(request, options);
        if (spots !== null) {
          const placed = new Map<string, PlacedNode>();
          for (const node of request.tree.nodes) {
            const spot = spots.get(node.keyString) as { x: number; y: number };
            placed.set(node.keyString, {
              nodeKey: node.keyString,
              x: spot.x,
              y: spot.y,
              source: 'auto',
              ...placementFlags(request, node),
            });
          }
          applyManual(placed, request);
          return [...placed.values()];
        }
      }
      const radius = initialRadialRadius(request.tree.nodes.length, options);
      const arranged = await elk.layout(toElkGraph(request, options, radius));
      const laidOut: ElkNode =
        request.mode === 'radial'
          ? { ...arranged, children: placeOnLevelRings(request.tree.root, arranged, options) }
          : arranged;
      const nodeByKey = new Map(request.tree.nodes.map((node) => [node.keyString, node]));
      const placed = new Map<string, PlacedNode>();
      for (const child of laidOut.children ?? []) {
        placed.set(child.id, {
          nodeKey: child.id,
          x: child.x ?? 0,
          y: child.y ?? 0,
          source: 'auto',
          ...placementFlags(request, nodeByKey.get(child.id)),
        });
      }
      applyManual(placed, request);
      return [...placed.values()];
    },
  };
}
