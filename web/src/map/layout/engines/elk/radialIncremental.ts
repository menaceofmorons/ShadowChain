import type { ChainNode } from '../../../model/types';
import { nodeSize } from '../../engineOptions';
import type { EngineOptions } from '../../engineOptions';
import type { IncrementalLayoutRequest, PlacedNode } from '../../types';

const FULL_TURN = 2 * Math.PI;

// TUNE: angular scan step as a fraction of a node width along the ring; smaller finds tighter slots at more cost.
const SCAN_STEP_FRACTION = 0.25;

interface Point {
  readonly x: number;
  readonly y: number;
}

interface Box {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

interface Arc {
  readonly from: number;
  readonly to: number;
}

const toHundredths = (value: number): number => Math.round(value * 100) / 100;

const turnOf = (centre: Point, origin: Point): number => {
  const turn = Math.atan2(centre.y - origin.y, centre.x - origin.x);
  return turn < 0 ? turn + FULL_TURN : turn;
};

const RING_MATCH = 1;

function longestNonDecreasing(values: readonly number[]): number[] {
  const tails: number[] = [];
  const previousIndex: number[] = [];
  values.forEach((value, index) => {
    let low = 0;
    let high = tails.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if ((values[tails[middle] as number] as number) <= value) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    tails[low] = index;
    previousIndex[index] = low > 0 ? (tails[low - 1] as number) : -1;
  });
  const chain: number[] = [];
  for (let at = tails.length > 0 ? (tails.at(-1) as number) : -1; at >= 0; at = previousIndex[at] as number) {
    chain.push(at);
  }
  return chain;
}

const boxesCollide = (a: Box, b: Box, gap: number): boolean =>
  a.left < b.left + b.width + gap &&
  b.left < a.left + a.width + gap &&
  a.top < b.top + b.height + gap &&
  b.top < a.top + a.height + gap;

const sideOf = (a: Point, b: Point, c: Point): number =>
  Math.sign((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x));

function hasCrossing(
  order: readonly ChainNode[],
  parents: ReadonlyMap<string, ChainNode>,
  boxes: ReadonlyMap<string, Box>,
  manualKeys: ReadonlySet<string>,
): boolean {
  const centre = (key: string): Point => {
    const box = boxes.get(key) as Box;
    return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
  };
  const edges = order
    .filter((node) => parents.has(node.keyString) && !manualKeys.has(node.keyString))
    .map((node) => {
      const parent = (parents.get(node.keyString) as ChainNode).keyString;
      return { from: parent, to: node.keyString, a: centre(parent), b: centre(node.keyString) };
    })
    .filter((edge) => !manualKeys.has(edge.from));
  for (let i = 0; i < edges.length; i += 1) {
    const first = edges[i] as (typeof edges)[number];
    for (let j = i + 1; j < edges.length; j += 1) {
      const second = edges[j] as (typeof edges)[number];
      if (
        first.from !== second.from &&
        first.to !== second.from &&
        first.from !== second.to &&
        first.to !== second.to &&
        sideOf(first.a, first.b, second.a) !== sideOf(first.a, first.b, second.b) &&
        sideOf(second.a, second.b, first.a) !== sideOf(second.a, second.b, first.b)
      ) {
        return true;
      }
    }
  }
  return false;
}

export function placeRadialIncrementally(
  request: IncrementalLayoutRequest,
  options: EngineOptions,
): Map<string, Point> | null {
  const { root } = request.tree;
  const removed = new Set(request.removedNodeKeys);
  const manual = new Map(request.manualPositions.map((position) => [position.nodeKey, position]));
  const previous = new Map<string, PlacedNode>(
    request.previous.filter((node) => !removed.has(node.nodeKey)).map((node) => [node.nodeKey, node]),
  );
  const previousRoot = previous.get(root.keyString);
  if (previousRoot === undefined) {
    return null;
  }

  const depths = new Map<string, number>();
  const parents = new Map<string, ChainNode>();
  const order: ChainNode[] = [];
  const walk = (node: ChainNode, depth: number): void => {
    depths.set(node.keyString, depth);
    order.push(node);
    for (const child of node.children) {
      parents.set(child.keyString, node);
      walk(child, depth + 1);
    }
  };
  walk(root, 0);

  const manualKeys = new Set(manual.keys());
  const carryShift = new Map<string, Point>();
  const carryWalk = (node: ChainNode, inherited: Point | null): void => {
    const override = manual.get(node.keyString);
    const prior = previous.get(node.keyString);
    let shift = inherited;
    if (node !== root && override !== undefined) {
      shift = prior === undefined ? null : { x: override.x - prior.x, y: override.y - prior.y };
    }
    if (shift !== null && override === undefined && prior?.source === 'auto') {
      carryShift.set(node.keyString, shift);
    }
    for (const child of node.children) {
      carryWalk(child, shift);
    }
  };
  carryWalk(root, null);
  const carriedKeys = new Set(carryShift.keys());
  for (const key of carriedKeys) {
    manualKeys.add(key);
  }
  const gap = options.siblingSpacing / 4;
  const slot = options.nodeWidth + options.siblingSpacing / 2;
  const minStep = Math.max(options.nodeWidth + options.levelSpacing, slot);
  const rootSize = nodeSize(root, options);
  const origin: Point = { x: previousRoot.x + rootSize.width / 2, y: previousRoot.y + rootSize.height / 2 };

  const positions = new Map<string, Point>();
  const boxes = new Map<string, Box>();
  const autoByDepth: string[][] = [];
  const remember = (node: ChainNode, x: number, y: number, onRing: boolean): void => {
    const size = nodeSize(node, options);
    const left = toHundredths(x);
    const top = toHundredths(y);
    positions.set(node.keyString, { x: left, y: top });
    boxes.set(node.keyString, { left, top, width: size.width, height: size.height });
    if (onRing) {
      (autoByDepth[depths.get(node.keyString) as number] ??= []).push(node.keyString);
    }
  };

  for (const node of order) {
    const override = manual.get(node.keyString);
    const prior = previous.get(node.keyString);
    if (override !== undefined) {
      remember(node, override.x, override.y, false);
    } else if (prior?.source === 'auto') {
      const shift = carryShift.get(node.keyString);
      if (shift === undefined) {
        remember(node, prior.x, prior.y, node !== root);
      } else {
        remember(node, prior.x + shift.x, prior.y + shift.y, false);
      }
    }
  }

  const centreOf = (key: string): Point => {
    const box = boxes.get(key) as Box;
    return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
  };
  const angleOf = (key: string): number => turnOf(centreOf(key), origin);

  const radii: number[] = [0];
  const seenRadii = [...boxes.keys()]
    .filter((key) => key !== root.keyString && !manualKeys.has(key))
    .map((key) => Math.hypot(centreOf(key).x - origin.x, centreOf(key).y - origin.y))
    .sort((a, b) => a - b);
  for (const radius of seenRadii) {
    if (radius - (radii.at(-1) as number) >= RING_MATCH) {
      radii.push(radius);
    } else if (radii.length > 1) {
      radii[radii.length - 1] = radius;
    }
  }
  const ringRadius = (depth: number): number => {
    for (let level = 1; level <= depth; level += 1) {
      if (radii[level] === undefined) {
        const inner = radii[level - 1] as number;
        const before = level >= 2 ? (radii[level - 2] as number) : 0;
        radii[level] = inner + (level >= 2 ? Math.max(inner - before, minStep) : minStep);
      }
    }
    return radii[depth] as number;
  };

  const forget = (key: string): void => {
    positions.delete(key);
    boxes.delete(key);
    const level = autoByDepth[depths.get(key) as number] as string[];
    level.splice(level.indexOf(key), 1);
  };

  const radiusOf = (key: string): number => Math.hypot(centreOf(key).x - origin.x, centreOf(key).y - origin.y);
  for (let depth = 1; depth < autoByDepth.length; depth += 1) {
    const ring = [...(autoByDepth[depth] ?? [])];
    const consistent = ring.filter((key) => {
      const parent = (parents.get(key) as ChainNode).keyString;
      return boxes.has(parent) && Math.abs(radiusOf(key) - (radii[depth] as number)) < RING_MATCH;
    });
    const parentTurn = (key: string): number => {
      const parent = parents.get(key) as ChainNode;
      return parent === root ? 0 : angleOf(parent.keyString);
    };
    const sorted = consistent.sort((a, b) => angleOf(a) - angleOf(b));
    const keep = new Set(longestNonDecreasing(sorted.map(parentTurn)).map((index) => sorted[index] as string));
    for (const key of ring) {
      if (!keep.has(key)) {
        forget(key);
      }
    }
  }
  const added = order.filter((node) => !boxes.has(node.keyString));

  const depthOf = (key: string): number => depths.get(key) as number;

  const isFree = (box: Box, moving?: ReadonlySet<string>): boolean => {
    for (const [key, other] of boxes) {
      if (moving?.has(key) !== true && boxesCollide(box, other, gap)) {
        return false;
      }
    }
    return true;
  };

  const boxAt = (node: ChainNode, radius: number, angle: number): Box => {
    const size = nodeSize(node, options);
    return {
      left: origin.x + radius * Math.cos(angle) - size.width / 2,
      top: origin.y + radius * Math.sin(angle) - size.height / 2,
      width: size.width,
      height: size.height,
    };
  };

  const rotatedBox = (key: string, delta: number): Box => {
    const box = boxes.get(key) as Box;
    const centre = centreOf(key);
    const dx = centre.x - origin.x;
    const dy = centre.y - origin.y;
    const x = origin.x + dx * Math.cos(delta) - dy * Math.sin(delta);
    const y = origin.y + dx * Math.sin(delta) + dy * Math.cos(delta);
    return { ...box, left: toHundredths(x - box.width / 2), top: toHundredths(y - box.height / 2) };
  };

  const rotate = (keys: ReadonlySet<string>, delta: number): void => {
    for (const key of keys) {
      const box = rotatedBox(key, delta);
      boxes.set(key, box);
      positions.set(key, { x: box.left, y: box.top });
    }
  };

  const scan = (node: ChainNode, radius: number, preferred: number, arc: Arc, step: number): Point | null => {
    const reach = Math.max(preferred - arc.from, arc.to - preferred);
    for (let k = 0; k * step <= reach; k += 1) {
      for (const direction of k === 0 ? [1] : [1, -1]) {
        const angle = preferred + direction * k * step;
        if (angle > arc.from && angle < arc.to) {
          const box = boxAt(node, radius, angle);
          if (isFree(box)) {
            return { x: box.left, y: box.top };
          }
        }
      }
    }
    return null;
  };

  interface Shift {
    readonly moving: ReadonlySet<string>;
    readonly delta: number;
    readonly spot: Point;
  }

  const ringsOf = (moving: ReadonlySet<string>): string[][] => {
    const rings = new Map<number, string[]>();
    for (const key of moving) {
      rings.set(depthOf(key), [...(rings.get(depthOf(key)) ?? []), key]);
    }
    return [...rings.values()].map((keys) => keys.sort((a, b) => angleOf(a) - angleOf(b)));
  };

  const boundaryClear = (box: Box, moving: ReadonlySet<string>, rings: readonly string[][], delta: number): boolean => {
    for (const ring of rings) {
      const turned = ring.map((key) => rotatedBox(key, delta));
      if (turned.some((candidate) => boxesCollide(box, candidate, gap))) {
        return false;
      }
      for (let at = 1; at < turned.length; at += 1) {
        if (boxesCollide(turned[at - 1] as Box, turned[at] as Box, gap)) {
          return false;
        }
      }
      const edges = [turned[0] as Box, turned.at(-1) as Box];
      for (const peer of autoByDepth[depthOf(ring[0] as string)] ?? []) {
        if (!moving.has(peer) && edges.some((edge) => boxesCollide(edge, boxes.get(peer) as Box, gap))) {
          return false;
        }
      }
    }
    return true;
  };

  const tryShift = (
    node: ChainNode,
    radius: number,
    arc: Arc,
    preferred: number,
    step: number,
    forward: boolean,
  ): Shift | null => {
    const depth = depthOf(node.keyString);
    const moving = new Set(
      [...boxes.keys()].filter(
        (key) =>
          !manualKeys.has(key) &&
          key !== root.keyString &&
          depthOf(key) >= depth &&
          (forward ? angleOf(key) >= arc.to : angleOf(key) <= arc.from),
      ),
    );
    const rings = ringsOf(moving);
    const angles = [...moving].map(angleOf);
    const headroom = forward ? FULL_TURN - Math.max(0, ...angles) : Math.min(FULL_TURN, ...angles);
    const sign = forward ? 1 : -1;
    for (let angle = forward ? Math.max(preferred, arc.from + step) : arc.to - step; ; angle += sign * step) {
      if (angle <= 0 || angle >= FULL_TURN || (forward ? angle < arc.from : angle > arc.to)) {
        return null;
      }
      const box = boxAt(node, radius, angle);
      if (!isFree(box, moving)) {
        continue;
      }
      for (let delta = 0; delta < headroom - 1e-6; delta += step) {
        const reaches = forward ? angle < arc.to + delta : angle > arc.from - delta;
        if (reaches && boundaryClear(box, moving, rings, sign * delta)) {
          return { moving, delta: sign * delta, spot: { x: box.left, y: box.top } };
        }
      }
      return null;
    }
  };

  const vacatedSize = (prior: PlacedNode): { width: number; height: number } => {
    if (prior.alias) {
      return { width: options.aliasWidth, height: options.aliasHeight };
    }
    return prior.hiddenCount === null
      ? { width: options.nodeWidth, height: options.nodeHeight }
      : { width: options.collapsedWidth, height: options.collapsedHeight };
  };
  const vacated = request.previous
    .filter((prior) => removed.has(prior.nodeKey) && prior.source === 'auto' && !manualKeys.has(prior.nodeKey))
    .map((prior) => {
      const size = vacatedSize(prior);
      const centre = { x: prior.x + size.width / 2, y: prior.y + size.height / 2 };
      const radius = Math.hypot(centre.x - origin.x, centre.y - origin.y);
      let ring = 1;
      for (let level = 1; level < radii.length; level += 1) {
        if (Math.abs((radii[level] as number) - radius) < Math.abs((radii[ring] as number) - radius)) {
          ring = level;
        }
      }
      return {
        ring,
        width: size.width,
        angle: turnOf(centre, origin),
        offRing: Math.abs((radii[ring] as number) - radius),
      };
    })
    .filter((slot) => radii.length > 1 && slot.offRing < RING_MATCH)
    .sort((a, b) => a.ring - b.ring || a.angle - b.angle);
  const farAway: Box = { left: 1e9, top: 1e9, width: 1, height: 1 };
  for (const slot of vacated) {
    const moving = new Set(
      [...boxes.keys()].filter(
        (key) =>
          !manualKeys.has(key) && key !== root.keyString && depthOf(key) >= slot.ring && angleOf(key) > slot.angle,
      ),
    );
    const rings = ringsOf(moving);
    const upper = Math.min(
      FULL_TURN,
      ...[...(autoByDepth[slot.ring] ?? [])].map(angleOf).filter((a) => a > slot.angle),
    );
    const step = (options.nodeWidth * SCAN_STEP_FRACTION) / (radii[slot.ring] as number);
    let best = 0;
    const footprint = (slot.width + options.siblingSpacing) / (radii[slot.ring] as number);
    for (let delta = step; delta <= Math.min(upper - slot.angle, footprint); delta += step) {
      if (!boundaryClear(farAway, moving, rings, -delta)) {
        break;
      }
      best = delta;
    }
    if (best > 0) {
      rotate(moving, -best);
    }
  }

  for (const node of added) {
    const depth = depthOf(node.keyString);
    const parent = parents.get(node.keyString) as ChainNode;
    const radius = ringRadius(depth);
    const step = (options.nodeWidth * SCAN_STEP_FRACTION) / radius;
    const parentAngle = depth === 1 ? 0 : angleOf(parent.keyString);
    const ring = autoByDepth[depth] ?? [];
    const parentAngleOf = (key: string): number => {
      const owner = parents.get(key) as ChainNode;
      return owner === root ? 0 : angleOf(owner.keyString);
    };
    let lower = 0;
    let upper = FULL_TURN;
    let lastSibling: number | null = null;
    for (const key of ring) {
      const angle = angleOf(key);
      if (parentAngleOf(key) <= parentAngle) {
        lower = Math.max(lower, angle);
        if (parents.get(key) === parent) {
          lastSibling = Math.max(lastSibling ?? 0, angle);
        }
      } else {
        upper = Math.min(upper, angle);
      }
    }
    const preferred = Math.min(Math.max(lastSibling ?? parentAngle, lower), upper);
    const arc: Arc = { from: lower, to: upper };
    let slice: Arc = arc;
    if (depth > 1) {
      const above = (autoByDepth[depth - 1] ?? []).map(angleOf);
      slice = {
        from: Math.max(lower, Math.max(0, ...above.filter((angle) => angle < parentAngle))),
        to: Math.min(upper, Math.min(FULL_TURN, ...above.filter((angle) => angle > parentAngle))),
      };
    }
    let spot = scan(node, radius, preferred, slice, step) ?? scan(node, radius, preferred, arc, step);
    if (spot === null) {
      const shifts = [true, false]
        .map((forward) => tryShift(node, radius, arc, preferred, step, forward))
        .filter((shift): shift is Shift => shift !== null)
        .sort((a, b) => a.moving.size - b.moving.size);
      const shift = shifts[0];
      if (shift !== undefined) {
        rotate(shift.moving, shift.delta);
        spot = shift.spot;
      }
    }
    if (spot === null) {
      return null;
    }
    remember(node, spot.x, spot.y, true);
  }

  return hasCrossing(order, parents, boxes, manualKeys) ? null : positions;
}
