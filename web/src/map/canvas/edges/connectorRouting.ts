import { DEFAULT_ENGINE_OPTIONS } from '../../layout/engineOptions';
import type { LayoutMode } from '../../layout/types';

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface Size {
  readonly width: number;
  readonly height: number;
}

export interface Rect extends Point, Size {}

export type Cubic = readonly [Point, Point, Point, Point];

export interface ConnectorPath {
  readonly segments: readonly Cubic[];
  readonly d: string;
  readonly start: Point;
  readonly end: Point;
  readonly badge: Point;
}

export interface BusRank {
  readonly rank: number;
  readonly runs: number;
}

export interface ConnectorInput {
  readonly mode: LayoutMode;
  readonly source: Rect;
  readonly target: Rect;
  readonly slotStart: number;
  readonly slots: number;
  readonly paths: number;
  readonly bus?: readonly BusRank[];
}

export interface SiblingItem {
  readonly target: Rect;
  readonly paths: number;
}

export interface SiblingPlan {
  readonly slotStart: number;
  readonly bus: readonly BusRank[];
}

export const CONNECTOR_PARALLEL_GAP = 6;
export const CONNECTOR_TARGET_SPACING = 8;
export const CONNECTOR_RADIAL_SPACING = 12;
export const CONNECTOR_MIN_CONTROL = 16;
export const CONNECTOR_BUS_MARGIN = 10;
export const CONNECTOR_BUS_MAX_STEP = 8;
export const CONNECTOR_CORNER_RADIUS = 10;
const STRAIGHT_ACROSS = 2;
const CONNECTOR_TARGET_EDGE_INSET = 4;
const BADGE_SAMPLES = 24;

const round = (value: number): number => Math.round(value * 100) / 100;

const lerp = (a: Point, b: Point, t: number): Point => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

export function cubicAt(cubic: Cubic, t: number): Point {
  const [p0, p1, p2, p3] = cubic;
  const a = lerp(p0, p1, t);
  const b = lerp(p1, p2, t);
  const c = lerp(p2, p3, t);
  return lerp(lerp(a, b, t), lerp(b, c, t), t);
}

export function samplePath(path: ConnectorPath, stepsPerSegment: number): Point[] {
  const points: Point[] = [];
  path.segments.forEach((segment, segmentIndex) => {
    for (let i = segmentIndex === 0 ? 0 : 1; i <= stepsPerSegment; i += 1) {
      points.push(cubicAt(segment, i / stepsPerSegment));
    }
  });
  return points;
}

const fmt = (p: Point): string => `${String(round(p.x))} ${String(round(p.y))}`;

const toD = (segments: readonly Cubic[]): string => {
  const first = segments[0] as Cubic;
  return segments.reduce((d, [, p1, p2, p3]) => `${d} C ${fmt(p1)}, ${fmt(p2)}, ${fmt(p3)}`, `M ${fmt(first[0])}`);
};

const lineSegment = (a: Point, b: Point): Cubic => [a, lerp(a, b, 1 / 3), lerp(a, b, 2 / 3), b];

const cornerSegment = (from: Point, corner: Point, to: Point): Cubic => [
  from,
  lerp(from, corner, 2 / 3),
  lerp(to, corner, 2 / 3),
  to,
];

function lengthMidpoint(segments: readonly Cubic[]): Point {
  const points = segments.flatMap((segment, segmentIndex) =>
    Array.from({ length: BADGE_SAMPLES + 1 }, (_, i) => cubicAt(segment, i / BADGE_SAMPLES)).slice(
      segmentIndex === 0 ? 0 : 1,
    ),
  );
  const lengths = [0];
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1] as Point;
    const b = points[i] as Point;
    lengths.push((lengths[i - 1] as number) + Math.hypot(b.x - a.x, b.y - a.y));
  }
  const half = (lengths[lengths.length - 1] as number) / 2;
  const at = lengths.findIndex((length) => length >= half);
  if (at <= 0) {
    return points[0] as Point;
  }
  const before = lengths[at - 1] as number;
  const span = (lengths[at] as number) - before;
  return lerp(points[at - 1] as Point, points[at] as Point, span === 0 ? 0 : (half - before) / span);
}

const finish = (segments: readonly Cubic[]): ConnectorPath => ({
  segments,
  d: toD(segments),
  start: (segments[0] as Cubic)[0],
  end: (segments[segments.length - 1] as Cubic)[3],
  badge: lengthMidpoint(segments),
});

const centreOf = (rect: Rect): Point => ({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });

const spreadOffset = (pathIndex: number, paths: number, spacing: number): number =>
  (pathIndex - (paths - 1) / 2) * spacing;

interface Frame {
  readonly alongEnd: (rect: Rect) => number;
  readonly alongStart: (rect: Rect) => number;
  readonly alongCentre: (rect: Rect) => number;
  readonly acrossStart: (rect: Rect) => number;
  readonly acrossSize: (rect: Rect) => number;
  readonly alongHalf: number;
  readonly point: (along: number, across: number) => Point;
}

const FRAMES: Record<'top-down' | 'left-to-right', Frame> = {
  'top-down': {
    alongEnd: (r) => r.y + r.height,
    alongStart: (r) => r.y,
    alongCentre: (r) => r.y + r.height / 2,
    acrossStart: (r) => r.x,
    acrossSize: (r) => r.width,
    alongHalf: DEFAULT_ENGINE_OPTIONS.nodeHeight / 2,
    point: (along, across) => ({ x: across, y: along }),
  },
  'left-to-right': {
    alongEnd: (r) => r.x + r.width,
    alongStart: (r) => r.x,
    alongCentre: (r) => r.x + r.width / 2,
    acrossStart: (r) => r.y,
    acrossSize: (r) => r.height,
    alongHalf: DEFAULT_ENGINE_OPTIONS.nodeWidth / 2,
    point: (along, across) => ({ x: along, y: across }),
  },
};

const anchorAcross = (frame: Frame, source: Rect, slot: number, slots: number): number =>
  frame.acrossStart(source) + (frame.acrossSize(source) * (slot + 1)) / (slots + 1);

const targetAcross = (frame: Frame, target: Rect, pathIndex: number, paths: number): number => {
  const room = Math.max(0, frame.acrossSize(target) / 2 - CONNECTOR_TARGET_EDGE_INSET);
  const offset = Math.max(-room, Math.min(room, spreadOffset(pathIndex, paths, CONNECTOR_TARGET_SPACING)));
  return frame.acrossStart(target) + frame.acrossSize(target) / 2 + offset;
};

export function planSiblings(
  mode: 'top-down' | 'left-to-right',
  source: Rect,
  items: readonly SiblingItem[],
): { slots: number; plans: SiblingPlan[] } {
  const frame = FRAMES[mode];
  const slots = items.reduce((sum, item) => sum + Math.max(1, item.paths), 0);
  const runs: { item: number; path: number; shift: number; target: number }[] = [];
  const slotStarts: number[] = [];
  let slot = 0;
  items.forEach((item, itemIndex) => {
    slotStarts.push(slot);
    const paths = Math.max(1, item.paths);
    for (let path = 0; path < paths; path += 1) {
      const target = targetAcross(frame, item.target, path, paths);
      runs.push({ item: itemIndex, path, shift: target - anchorAcross(frame, source, slot, slots), target });
      slot += 1;
    }
  });
  const bus: BusRank[][] = items.map((item) =>
    Array.from({ length: Math.max(1, item.paths) }, () => ({ rank: 0, runs: 1 })),
  );
  for (const sign of [-1, 1]) {
    const members = runs
      .filter(({ shift }) => Math.sign(shift) === sign && Math.abs(shift) >= STRAIGHT_ACROSS)
      .sort((a, b) => sign * (b.target - a.target));
    members.forEach(({ item, path }, rank) => {
      (bus[item] as BusRank[])[path] = { rank, runs: members.length };
    });
  }
  return { slots, plans: slotStarts.map((slotStart, i) => ({ slotStart, bus: bus[i] as BusRank[] })) };
}

function smoothPath(
  frame: Frame,
  alongFrom: number,
  acrossFrom: number,
  alongTo: number,
  acrossTo: number,
): ConnectorPath {
  const reach = Math.max(Math.abs(alongTo - alongFrom) / 2, CONNECTOR_MIN_CONTROL);
  const direction = alongTo >= alongFrom ? 1 : -1;
  const cubic: Cubic = [
    frame.point(alongFrom, acrossFrom),
    frame.point(alongFrom + direction * reach, acrossFrom),
    frame.point(alongTo - direction * reach, acrossTo),
    frame.point(alongTo, acrossTo),
  ];
  return finish([cubic]);
}

function treePath(input: ConnectorInput, pathIndex: number): ConnectorPath {
  const { mode, source, target, slotStart, slots, paths } = input;
  const frame = FRAMES[mode as 'top-down' | 'left-to-right'];
  const alongFrom = frame.alongEnd(source);
  const alongTo = frame.alongStart(target);
  const acrossFrom = anchorAcross(frame, source, slotStart + pathIndex, slots);
  const acrossTo = targetAcross(frame, target, pathIndex, paths);
  const shift = acrossTo - acrossFrom;
  const sign = Math.sign(shift);
  const bandEnd = frame.alongCentre(source) + frame.alongHalf;
  const busMin = bandEnd + CONNECTOR_BUS_MARGIN;
  const busMax = Math.min(
    bandEnd + DEFAULT_ENGINE_OPTIONS.levelSpacing - CONNECTOR_BUS_MARGIN,
    alongTo - CONNECTOR_BUS_MARGIN,
  );
  if (Math.abs(shift) < STRAIGHT_ACROSS || busMax - busMin < 1) {
    return smoothPath(frame, alongFrom, acrossFrom, alongTo, acrossTo);
  }
  const { rank, runs } = input.bus?.[pathIndex] ?? { rank: 0, runs: 1 };
  const step = runs > 1 ? Math.min(CONNECTOR_BUS_MAX_STEP, (busMax - busMin) / (runs - 1)) : 0;
  const bus = busMin + (busMax - busMin - step * (runs - 1)) / 2 + rank * step;
  const radius = Math.min(CONNECTOR_CORNER_RADIUS, Math.abs(shift) / 2, bus - alongFrom, alongTo - bus);
  const at = (along: number, across: number): Point => frame.point(along, across);
  const segments: Cubic[] = [
    lineSegment(at(alongFrom, acrossFrom), at(bus - radius, acrossFrom)),
    cornerSegment(at(bus - radius, acrossFrom), at(bus, acrossFrom), at(bus, acrossFrom + sign * radius)),
    lineSegment(at(bus, acrossFrom + sign * radius), at(bus, acrossTo - sign * radius)),
    cornerSegment(at(bus, acrossTo - sign * radius), at(bus, acrossTo), at(bus + radius, acrossTo)),
    lineSegment(at(bus + radius, acrossTo), at(alongTo, acrossTo)),
  ];
  return finish(segments);
}

function exitParameter(rect: Rect, direction: Point): number {
  const halfWidth = rect.width / 2;
  const halfHeight = rect.height / 2;
  const alongX = direction.x === 0 ? Infinity : halfWidth / Math.abs(direction.x);
  const alongY = direction.y === 0 ? Infinity : halfHeight / Math.abs(direction.y);
  return Math.min(alongX, alongY);
}

function radialPath(input: ConnectorInput, pathIndex: number): ConnectorPath {
  const { source, target, paths } = input;
  const from = centreOf(source);
  const to = centreOf(target);
  const length = Math.hypot(to.x - from.x, to.y - from.y);
  const unit: Point = length === 0 ? { x: 0, y: 0 } : { x: (to.x - from.x) / length, y: (to.y - from.y) / length };
  const leave = exitParameter(source, unit);
  const arrive = length - exitParameter(target, { x: -unit.x, y: -unit.y });
  const visible = length > 0 && leave < arrive;
  const tMiddle = visible ? (leave + arrive) / 2 / length : 0.5;
  const bow = spreadOffset(pathIndex, paths, CONNECTOR_RADIAL_SPACING) * 2;
  const control: Point = {
    x: (from.x + to.x) / 2 - unit.y * bow,
    y: (from.y + to.y) / 2 + unit.x * bow,
  };
  const cubic: Cubic = [from, lerp(from, control, 2 / 3), lerp(to, control, 2 / 3), to];
  return { ...finish([cubic]), badge: cubicAt(cubic, tMiddle) };
}

export function routeConnector(input: ConnectorInput): ConnectorPath[] {
  const build = input.mode === 'radial' ? radialPath : treePath;
  return Array.from({ length: Math.max(1, input.paths) }, (_, pathIndex) => build(input, pathIndex));
}

export function rectFromHandle(mode: LayoutMode, role: 'source' | 'target', handle: Point, size: Size): Rect {
  const { width, height } = size;
  switch (mode) {
    case 'radial':
      return { x: handle.x - width / 2, y: handle.y - height / 2, width, height };
    case 'top-down':
      return role === 'source'
        ? { x: handle.x - width / 2, y: handle.y - height, width, height }
        : { x: handle.x - width / 2, y: handle.y, width, height };
    case 'left-to-right':
      return role === 'source'
        ? { x: handle.x - width, y: handle.y - height / 2, width, height }
        : { x: handle.x, y: handle.y - height / 2, width, height };
  }
}

export function distanceToPolyline(point: Point, polyline: readonly Point[]): number {
  let best = Infinity;
  for (let i = 1; i < polyline.length; i += 1) {
    const a = polyline[i - 1] as Point;
    const b = polyline[i] as Point;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lengthSquared = dx * dx + dy * dy;
    const t =
      lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared));
    best = Math.min(best, Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy)));
  }
  return best;
}
