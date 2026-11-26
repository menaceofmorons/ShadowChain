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

export interface ConnectorInput {
  readonly mode: LayoutMode;
  readonly source: Rect;
  readonly target: Rect;
  readonly paths: number;
}

export const CONNECTOR_PARALLEL_GAP = 6;
export const CONNECTOR_TARGET_SPACING = 18;
export const CONNECTOR_RADIAL_SPACING = 12;
export const CONNECTOR_TRUNK_OFFSET = 24;
export const CONNECTOR_BUS_MARGIN = 10;
const CONNECTOR_PARALLEL_LEVEL = 8;
const CONNECTOR_DROP_CLEARANCE = 22;
const CONNECTOR_BADGE_CLEARANCE = 12;
export const CONNECTOR_CORNER_RADIUS = 10;
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

export function samplePathEvery(path: ConnectorPath, step: number): Point[] {
  const points: Point[] = [];
  path.segments.forEach((segment, segmentIndex) => {
    const chord = Math.hypot(segment[3].x - segment[0].x, segment[3].y - segment[0].y);
    const steps = Math.max(8, Math.ceil(chord / step));
    for (let i = segmentIndex === 0 ? 0 : 1; i <= steps; i += 1) {
      points.push(cubicAt(segment, i / steps));
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

const targetAcross = (frame: Frame, target: Rect, pathIndex: number, paths: number): number => {
  const room = Math.max(0, frame.acrossSize(target) / 2 - CONNECTOR_TARGET_EDGE_INSET);
  const offset = Math.max(-room, Math.min(room, spreadOffset(pathIndex, paths, CONNECTOR_TARGET_SPACING)));
  return frame.acrossStart(target) + frame.acrossSize(target) / 2 + offset;
};

function dropBadge(frame: Frame, from: number, alongTo: number, across: number, fraction: number): Point {
  const stop = Math.max(from, alongTo - CONNECTOR_BADGE_CLEARANCE);
  return frame.point(from + (stop - from) * fraction, across);
}

function busRoute(
  frame: Frame,
  line: { alongFrom: number; acrossFrom: number; alongTo: number; acrossTo: number },
  bus: number,
  radii: { first: number; second: number },
  fraction: number,
): ConnectorPath {
  const { alongFrom, acrossFrom, alongTo, acrossTo } = line;
  const sign = Math.sign(acrossTo - acrossFrom);
  const at = (along: number, across: number): Point => frame.point(along, across);
  const { first, second } = radii;
  const drop = lineSegment(at(bus + second, acrossTo), at(alongTo, acrossTo));
  const segments: Cubic[] = [
    lineSegment(at(alongFrom, acrossFrom), at(bus - first, acrossFrom)),
    cornerSegment(at(bus - first, acrossFrom), at(bus, acrossFrom), at(bus, acrossFrom + sign * first)),
    lineSegment(at(bus, acrossFrom + sign * first), at(bus, acrossTo - sign * second)),
    cornerSegment(at(bus, acrossTo - sign * second), at(bus, acrossTo), at(bus + second, acrossTo)),
    drop,
  ];
  return { ...finish(segments), badge: dropBadge(frame, bus + second, alongTo, acrossTo, fraction) };
}

function snappedPath(
  frame: Frame,
  line: { alongFrom: number; acrossFrom: number; alongTo: number },
  target: Rect,
  pathIndex: number,
  paths: number,
  bus: number,
): ConnectorPath {
  const room = Math.max(0, frame.acrossSize(target) / 2 - CONNECTOR_TARGET_EDGE_INSET);
  const centre = frame.acrossStart(target) + frame.acrossSize(target) / 2;
  const lateral = (index: number): number => {
    const wanted = centre + spreadOffset(index, paths, CONNECTOR_TARGET_SPACING);
    return Math.max(centre - room, Math.min(centre + room, wanted)) - line.acrossFrom;
  };
  const own = lateral(pathIndex);
  const fraction = (pathIndex + 1) / (paths + 1);
  const end = line.acrossFrom + own;
  if (Math.abs(own) < 1) {
    const drop = lineSegment(frame.point(bus, end), frame.point(line.alongTo, end));
    const stem = lineSegment(frame.point(line.alongFrom, line.acrossFrom), frame.point(bus, end));
    return { ...finish([stem, drop]), badge: dropBadge(frame, bus, line.alongTo, end, fraction) };
  }
  const sameSide = Array.from({ length: paths }, (_, k) => Math.abs(lateral(k)))
    .filter((size, k) => Math.sign(lateral(k)) === Math.sign(own) && size > 0)
    .sort((x, y) => x - y);
  const farther = sameSide.length - 1 - sameSide.indexOf(Math.abs(own));
  const level = Math.min(bus + CONNECTOR_PARALLEL_LEVEL * (1 + farther), line.alongTo - CONNECTOR_DROP_CLEARANCE);
  const radius = Math.min(CONNECTOR_CORNER_RADIUS, Math.abs(own) / 2, line.alongTo - level);
  return busRoute(frame, { ...line, acrossTo: end }, level, { first: radius, second: radius }, fraction);
}

function treePath(input: ConnectorInput, pathIndex: number): ConnectorPath {
  const { mode, source, target, paths } = input;
  const frame = FRAMES[mode as 'top-down' | 'left-to-right'];
  const alongFrom = frame.alongEnd(source);
  const alongTo = frame.alongStart(target);
  const acrossFrom = frame.acrossStart(source) + frame.acrossSize(source) / 2;
  const acrossTo = targetAcross(frame, target, pathIndex, paths);
  const shifts = Array.from({ length: paths }, (_, k) => targetAcross(frame, target, k, paths) - acrossFrom);
  const branching = shifts.every(
    (shift) => Math.abs(shift) >= 2 * CONNECTOR_CORNER_RADIUS && Math.sign(shift) === Math.sign(shifts[0] as number),
  );
  const bandEnd = frame.alongCentre(source) + frame.alongHalf;
  const bus = Math.min(bandEnd + CONNECTOR_TRUNK_OFFSET, alongTo - CONNECTOR_BUS_MARGIN);
  if (!branching || bus - alongFrom < CONNECTOR_CORNER_RADIUS) {
    return snappedPath(frame, { alongFrom, acrossFrom, alongTo }, target, pathIndex, paths, bus);
  }
  const second = Math.min(CONNECTOR_CORNER_RADIUS, alongTo - bus);
  return busRoute(
    frame,
    { alongFrom, acrossFrom, alongTo, acrossTo },
    bus,
    { first: CONNECTOR_CORNER_RADIUS, second },
    (pathIndex + 1) / (paths + 1),
  );
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
