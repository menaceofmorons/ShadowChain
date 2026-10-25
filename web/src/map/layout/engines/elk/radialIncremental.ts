import type { ChainNode } from '../../../model/types';
import { nodeSize, nodeSizeForKind } from '../../engineOptions';
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

interface RadialState {
  readonly options: EngineOptions;
  readonly root: ChainNode;
  readonly origin: Point;
  readonly gap: number;
  readonly minStep: number;
  readonly depths: Map<string, number>;
  readonly parents: Map<string, ChainNode>;
  readonly order: ChainNode[];
  readonly manualKeys: Set<string>;
  readonly positions: Map<string, Point>;
  readonly boxes: Map<string, Box>;
  readonly autoByDepth: string[][];
  readonly radii: number[];
}

interface Shift {
  readonly moving: ReadonlySet<string>;
  readonly delta: number;
  readonly spot: Point;
}

interface VacatedSlot {
  readonly ring: number;
  readonly width: number;
  readonly angle: number;
  readonly offRing: number;
}

const centreOf = (state: RadialState, key: string): Point => {
  const box = state.boxes.get(key) as Box;
  return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
};

const angleOf = (state: RadialState, key: string): number => turnOf(centreOf(state, key), state.origin);

const radiusOf = (state: RadialState, key: string): number => {
  const centre = centreOf(state, key);
  return Math.hypot(centre.x - state.origin.x, centre.y - state.origin.y);
};

const depthOf = (state: RadialState, key: string): number => state.depths.get(key) as number;

const parentTurn = (state: RadialState, key: string): number => {
  const parent = state.parents.get(key) as ChainNode;
  return parent === state.root ? 0 : angleOf(state, parent.keyString);
};

function indexTree(root: ChainNode): Pick<RadialState, 'depths' | 'parents' | 'order'> {
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
  return { depths, parents, order };
}

function carriedShifts(
  root: ChainNode,
  manual: ReadonlyMap<string, { x: number; y: number }>,
  previous: ReadonlyMap<string, PlacedNode>,
): Map<string, Point> {
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
  return carryShift;
}

function keysUnderManual(root: ChainNode, manual: ReadonlyMap<string, unknown>): Set<string> {
  const deferred = new Set<string>();
  const deferWalk = (node: ChainNode, underManual: boolean): void => {
    if (underManual) {
      deferred.add(node.keyString);
    }
    const below = underManual || (node !== root && manual.has(node.keyString));
    for (const child of node.children) {
      deferWalk(child, below);
    }
  };
  deferWalk(root, false);
  return deferred;
}

function remember(state: RadialState, node: ChainNode, x: number, y: number, onRing: boolean): void {
  const size = nodeSize(node, state.options);
  const left = toHundredths(x);
  const top = toHundredths(y);
  state.positions.set(node.keyString, { x: left, y: top });
  state.boxes.set(node.keyString, { left, top, width: size.width, height: size.height });
  if (onRing) {
    (state.autoByDepth[depthOf(state, node.keyString)] ??= []).push(node.keyString);
  }
}

function forget(state: RadialState, key: string): void {
  state.positions.delete(key);
  state.boxes.delete(key);
  const level = state.autoByDepth[depthOf(state, key)] as string[];
  level.splice(level.indexOf(key), 1);
}

function seedFromPrevious(
  state: RadialState,
  manual: ReadonlyMap<string, { x: number; y: number }>,
  previous: ReadonlyMap<string, PlacedNode>,
  carryShift: ReadonlyMap<string, Point>,
): void {
  for (const node of state.order) {
    const override = manual.get(node.keyString);
    const prior = previous.get(node.keyString);
    if (override !== undefined) {
      remember(state, node, override.x, override.y, false);
    } else if (prior?.source === 'auto') {
      const shift = carryShift.get(node.keyString);
      if (shift === undefined) {
        remember(state, node, prior.x, prior.y, node !== state.root);
      } else {
        remember(state, node, prior.x + shift.x, prior.y + shift.y, false);
      }
    }
  }
}

function inferRingRadii(state: RadialState): void {
  const seenRadii = [...state.boxes.keys()]
    .filter((key) => key !== state.root.keyString && !state.manualKeys.has(key))
    .map((key) => radiusOf(state, key))
    .sort((a, b) => a - b);
  for (const radius of seenRadii) {
    if (radius - (state.radii.at(-1) as number) >= RING_MATCH) {
      state.radii.push(radius);
    } else if (state.radii.length > 1) {
      state.radii[state.radii.length - 1] = radius;
    }
  }
}

function ringRadius(state: RadialState, depth: number): number {
  const { radii } = state;
  for (let level = 1; level <= depth; level += 1) {
    if (radii[level] === undefined) {
      const inner = radii[level - 1] as number;
      const before = level >= 2 ? (radii[level - 2] as number) : 0;
      radii[level] = inner + (level >= 2 ? Math.max(inner - before, state.minStep) : state.minStep);
    }
  }
  return radii[depth] as number;
}

function pruneInconsistentRings(state: RadialState): void {
  for (let depth = 1; depth < state.autoByDepth.length; depth += 1) {
    const ring = [...(state.autoByDepth[depth] ?? [])];
    const consistent = ring.filter((key) => {
      const parent = (state.parents.get(key) as ChainNode).keyString;
      return state.boxes.has(parent) && Math.abs(radiusOf(state, key) - (state.radii[depth] as number)) < RING_MATCH;
    });
    const sorted = consistent.sort((a, b) => angleOf(state, a) - angleOf(state, b));
    const keep = new Set(
      longestNonDecreasing(sorted.map((key) => parentTurn(state, key))).map((index) => sorted[index] as string),
    );
    for (const key of ring) {
      if (!keep.has(key)) {
        forget(state, key);
      }
    }
  }
}

function isFree(state: RadialState, box: Box, moving?: ReadonlySet<string>): boolean {
  for (const [key, other] of state.boxes) {
    if (moving?.has(key) !== true && boxesCollide(box, other, state.gap)) {
      return false;
    }
  }
  return true;
}

function boxAt(state: RadialState, node: ChainNode, radius: number, angle: number): Box {
  const size = nodeSize(node, state.options);
  return {
    left: state.origin.x + radius * Math.cos(angle) - size.width / 2,
    top: state.origin.y + radius * Math.sin(angle) - size.height / 2,
    width: size.width,
    height: size.height,
  };
}

function rotatedBox(state: RadialState, key: string, delta: number): Box {
  const box = state.boxes.get(key) as Box;
  const centre = centreOf(state, key);
  const dx = centre.x - state.origin.x;
  const dy = centre.y - state.origin.y;
  const x = state.origin.x + dx * Math.cos(delta) - dy * Math.sin(delta);
  const y = state.origin.y + dx * Math.sin(delta) + dy * Math.cos(delta);
  return { ...box, left: toHundredths(x - box.width / 2), top: toHundredths(y - box.height / 2) };
}

function rotate(state: RadialState, keys: ReadonlySet<string>, delta: number): void {
  for (const key of keys) {
    const box = rotatedBox(state, key, delta);
    state.boxes.set(key, box);
    state.positions.set(key, { x: box.left, y: box.top });
  }
}

function scan(
  state: RadialState,
  node: ChainNode,
  radius: number,
  preferred: number,
  arc: Arc,
  step: number,
): Point | null {
  const reach = Math.max(preferred - arc.from, arc.to - preferred);
  for (let k = 0; k * step <= reach; k += 1) {
    for (const direction of k === 0 ? [1] : [1, -1]) {
      const angle = preferred + direction * k * step;
      if (angle > arc.from && angle < arc.to) {
        const box = boxAt(state, node, radius, angle);
        if (isFree(state, box)) {
          return { x: box.left, y: box.top };
        }
      }
    }
  }
  return null;
}

function ringsOf(state: RadialState, moving: ReadonlySet<string>): string[][] {
  const rings = new Map<number, string[]>();
  for (const key of moving) {
    rings.set(depthOf(state, key), [...(rings.get(depthOf(state, key)) ?? []), key]);
  }
  return [...rings.values()].map((keys) => keys.sort((a, b) => angleOf(state, a) - angleOf(state, b)));
}

function boundaryClear(
  state: RadialState,
  box: Box,
  moving: ReadonlySet<string>,
  rings: readonly string[][],
  delta: number,
): boolean {
  for (const ring of rings) {
    const turned = ring.map((key) => rotatedBox(state, key, delta));
    if (turned.some((candidate) => boxesCollide(box, candidate, state.gap))) {
      return false;
    }
    for (let at = 1; at < turned.length; at += 1) {
      if (boxesCollide(turned[at - 1] as Box, turned[at] as Box, state.gap)) {
        return false;
      }
    }
    const edges = [turned[0] as Box, turned.at(-1) as Box];
    for (const peer of state.autoByDepth[depthOf(state, ring[0] as string)] ?? []) {
      if (!moving.has(peer) && edges.some((edge) => boxesCollide(edge, state.boxes.get(peer) as Box, state.gap))) {
        return false;
      }
    }
  }
  return true;
}

function tryShift(
  state: RadialState,
  node: ChainNode,
  radius: number,
  arc: Arc,
  preferred: number,
  step: number,
  forward: boolean,
): Shift | null {
  const depth = depthOf(state, node.keyString);
  const moving = new Set(
    [...state.boxes.keys()].filter(
      (key) =>
        !state.manualKeys.has(key) &&
        key !== state.root.keyString &&
        depthOf(state, key) >= depth &&
        (forward ? angleOf(state, key) >= arc.to : angleOf(state, key) <= arc.from),
    ),
  );
  const rings = ringsOf(state, moving);
  const angles = [...moving].map((key) => angleOf(state, key));
  const headroom = forward ? FULL_TURN - Math.max(0, ...angles) : Math.min(FULL_TURN, ...angles);
  const sign = forward ? 1 : -1;
  for (let angle = forward ? Math.max(preferred, arc.from + step) : arc.to - step; ; angle += sign * step) {
    if (angle <= 0 || angle >= FULL_TURN || (forward ? angle < arc.from : angle > arc.to)) {
      return null;
    }
    const box = boxAt(state, node, radius, angle);
    if (!isFree(state, box, moving)) {
      continue;
    }
    for (let delta = 0; delta < headroom - 1e-6; delta += step) {
      const reaches = forward ? angle < arc.to + delta : angle > arc.from - delta;
      if (reaches && boundaryClear(state, box, moving, rings, sign * delta)) {
        return { moving, delta: sign * delta, spot: { x: box.left, y: box.top } };
      }
    }
    return null;
  }
}

function vacatedSlots(
  state: RadialState,
  request: IncrementalLayoutRequest,
  removed: ReadonlySet<string>,
): VacatedSlot[] {
  const { radii, origin } = state;
  return request.previous
    .filter((prior) => removed.has(prior.nodeKey) && prior.source === 'auto' && !state.manualKeys.has(prior.nodeKey))
    .map((prior) => {
      const kind = prior.alias ? 'alias' : prior.hiddenCount === null ? 'primary' : 'collapsed';
      const size = nodeSizeForKind(kind, state.options);
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
}

function closeVacatedSlots(state: RadialState, slots: readonly VacatedSlot[]): void {
  const farAway: Box = { left: 1e9, top: 1e9, width: 1, height: 1 };
  for (const slot of slots) {
    const moving = new Set(
      [...state.boxes.keys()].filter(
        (key) =>
          !state.manualKeys.has(key) &&
          key !== state.root.keyString &&
          depthOf(state, key) >= slot.ring &&
          angleOf(state, key) > slot.angle,
      ),
    );
    const rings = ringsOf(state, moving);
    const upper = Math.min(
      FULL_TURN,
      ...(state.autoByDepth[slot.ring] ?? []).map((key) => angleOf(state, key)).filter((a) => a > slot.angle),
    );
    const slotRadius = state.radii[slot.ring] as number;
    const step = (state.options.nodeWidth * SCAN_STEP_FRACTION) / slotRadius;
    const footprint = (slot.width + state.options.siblingSpacing) / slotRadius;
    let best = 0;
    for (let delta = step; delta <= Math.min(upper - slot.angle, footprint); delta += step) {
      if (!boundaryClear(state, farAway, moving, rings, -delta)) {
        break;
      }
      best = delta;
    }
    if (best > 0) {
      rotate(state, moving, -best);
    }
  }
}

function ringArcs(
  state: RadialState,
  node: ChainNode,
  depth: number,
  parentAngle: number,
): { arc: Arc; slice: Arc; preferred: number } {
  const parent = state.parents.get(node.keyString);
  let lower = 0;
  let upper = FULL_TURN;
  let lastSibling: number | null = null;
  for (const key of state.autoByDepth[depth] ?? []) {
    const angle = angleOf(state, key);
    if (parentTurn(state, key) <= parentAngle) {
      lower = Math.max(lower, angle);
      if (state.parents.get(key) === parent) {
        lastSibling = Math.max(lastSibling ?? 0, angle);
      }
    } else {
      upper = Math.min(upper, angle);
    }
  }
  const preferred = Math.min(Math.max(lastSibling ?? parentAngle, lower), upper);
  const arc: Arc = { from: lower, to: upper };
  if (depth <= 1) {
    return { arc, slice: arc, preferred };
  }
  const above = (state.autoByDepth[depth - 1] ?? []).map((key) => angleOf(state, key));
  const slice: Arc = {
    from: Math.max(lower, Math.max(0, ...above.filter((angle) => angle < parentAngle))),
    to: Math.min(upper, Math.min(FULL_TURN, ...above.filter((angle) => angle > parentAngle))),
  };
  return { arc, slice, preferred };
}

function placeAdded(state: RadialState, node: ChainNode): boolean {
  const depth = depthOf(state, node.keyString);
  const parent = state.parents.get(node.keyString) as ChainNode;
  const radius = ringRadius(state, depth);
  const step = (state.options.nodeWidth * SCAN_STEP_FRACTION) / radius;
  const parentAngle = depth === 1 ? 0 : angleOf(state, parent.keyString);
  const { arc, slice, preferred } = ringArcs(state, node, depth, parentAngle);
  let spot = scan(state, node, radius, preferred, slice, step) ?? scan(state, node, radius, preferred, arc, step);
  if (spot === null) {
    const shift = [true, false]
      .map((forward) => tryShift(state, node, radius, arc, preferred, step, forward))
      .filter((candidate): candidate is Shift => candidate !== null)
      .sort((a, b) => a.moving.size - b.moving.size)[0];
    if (shift !== undefined) {
      rotate(state, shift.moving, shift.delta);
      spot = shift.spot;
    }
  }
  if (spot === null) {
    return false;
  }
  remember(state, node, spot.x, spot.y, true);
  return true;
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

  const carryShift = carriedShifts(root, manual, previous);
  const deferred = keysUnderManual(root, manual);
  const slot = options.nodeWidth + options.siblingSpacing / 2;
  const rootSize = nodeSize(root, options);
  const state: RadialState = {
    options,
    root,
    origin: { x: previousRoot.x + rootSize.width / 2, y: previousRoot.y + rootSize.height / 2 },
    gap: options.siblingSpacing / 4,
    minStep: Math.max(options.nodeWidth + options.levelSpacing, slot),
    ...indexTree(root),
    manualKeys: new Set([...manual.keys(), ...carryShift.keys()]),
    positions: new Map(),
    boxes: new Map(),
    autoByDepth: [],
    radii: [0],
  };

  seedFromPrevious(state, manual, previous, carryShift);
  inferRingRadii(state);
  pruneInconsistentRings(state);
  const added = state.order.filter((node) => !state.boxes.has(node.keyString));
  closeVacatedSlots(state, vacatedSlots(state, request, removed));

  for (const node of added) {
    if (deferred.has(node.keyString)) {
      state.manualKeys.add(node.keyString);
    } else if (!placeAdded(state, node)) {
      return null;
    }
  }

  return hasCrossing(state.order, state.parents, state.boxes, state.manualKeys) ? null : state.positions;
}
