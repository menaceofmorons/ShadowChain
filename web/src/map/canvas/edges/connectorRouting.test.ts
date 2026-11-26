import { describe, expect, it } from 'vitest';
import { DEFAULT_ENGINE_OPTIONS } from '../../layout/engineOptions';
import { BADGE_HEIGHT, BADGE_WIDTH, CONNECTOR_FAN_OUT_LENGTH, CONNECTOR_MIN_SEPARATION } from './connectorBounds';
import {
  planSiblings,
  CONNECTOR_PARALLEL_GAP,
  distanceToPolyline,
  routeConnector,
  samplePath,
  type ConnectorPath,
  type Point,
  type Rect,
} from './connectorRouting';

const {
  nodeWidth,
  nodeHeight,
  aliasWidth,
  aliasHeight,
  collapsedWidth,
  collapsedHeight,
  siblingSpacing,
  levelSpacing,
} = DEFAULT_ENGINE_OPTIONS;

const SAMPLES = 24;

const box = (x: number, y: number, width = nodeWidth, height = nodeHeight): Rect => ({ x, y, width, height });

const SIZE_MIX: readonly [number, number][] = [
  [nodeWidth, nodeHeight],
  [aliasWidth, aliasHeight],
  [collapsedWidth, collapsedHeight],
];

function row(count: number, y: number, centreX: number, sizes: readonly [number, number][]): Rect[] {
  const widths = Array.from({ length: count }, (_, i) => (sizes[i % sizes.length] as [number, number])[0]);
  const total = widths.reduce((sum, w) => sum + w, 0) + siblingSpacing * (count - 1);
  let cursor = centreX - total / 2;
  return widths.map((width, i) => {
    const height = (sizes[i % sizes.length] as [number, number])[1];
    const rect = box(cursor, y + (nodeHeight - height) / 2, width, height);
    cursor += width + siblingSpacing;
    return rect;
  });
}

const parentBox = box(0, 0);
const childY = nodeHeight + levelSpacing;
const transpose = (rect: Rect): Rect => ({ x: rect.y, y: rect.x, width: rect.height, height: rect.width });

function fan(
  mode: 'top-down' | 'left-to-right',
  children: readonly Rect[],
  parallels: readonly number[] = [],
): ConnectorPath[][] {
  const source = mode === 'top-down' ? parentBox : transpose(parentBox);
  const targets = children.map((child) => (mode === 'top-down' ? child : transpose(child)));
  const { slots, plans } = planSiblings(
    mode,
    source,
    targets.map((target, index) => ({ target, paths: parallels[index] ?? 1 })),
  );
  return targets.map((target, index) => {
    const plan = plans[index] as { slotStart: number; bus: readonly { rank: number; runs: number }[] };
    return routeConnector({
      mode,
      source,
      target,
      slotStart: plan.slotStart,
      slots,
      paths: parallels[index] ?? 1,
      bus: plan.bus,
    });
  });
}

const flat = (groups: readonly ConnectorPath[][]): ConnectorPath[] => groups.flat();

const separation = (a: ConnectorPath, b: ConnectorPath): number => {
  const beyondFanOut = (path: ConnectorPath): Point[] => {
    const points = samplePath(path, SAMPLES);
    const start = path.start;
    return points.filter((p) => Math.hypot(p.x - start.x, p.y - start.y) >= CONNECTOR_FAN_OUT_LENGTH);
  };
  const other = beyondFanOut(b);
  return Math.min(...beyondFanOut(a).map((p) => distanceToPolyline(p, other)));
};

const insideBadge = (badge: Point, rect: Rect): boolean =>
  badge.x + BADGE_WIDTH / 2 > rect.x &&
  badge.x - BADGE_WIDTH / 2 < rect.x + rect.width &&
  badge.y + BADGE_HEIGHT / 2 > rect.y &&
  badge.y - BADGE_HEIGHT / 2 < rect.y + rect.height;

const crossesRect = (path: ConnectorPath, rect: Rect): boolean =>
  samplePath(path, SAMPLES).some(
    (p) =>
      p.x > rect.x + 0.5 && p.x < rect.x + rect.width - 0.5 && p.y > rect.y + 0.5 && p.y < rect.y + rect.height - 0.5,
  );

describe('connectorRouting', () => {
  describe('C1 near sides', () => {
    it('top-down leaves the parent bottom and enters the child top', () => {
      const child = box(300, childY);
      const path = routeConnector({
        mode: 'top-down',
        source: parentBox,
        target: child,
        slotStart: 0,
        slots: 1,
        paths: 1,
      })[0] as ConnectorPath;
      expect(path.start.y).toBe(parentBox.y + parentBox.height);
      expect(path.end).toEqual({ x: child.x + child.width / 2, y: child.y });
    });

    it('left-to-right leaves the parent right side and enters the child left side', () => {
      const child = box(nodeWidth + levelSpacing, 300);
      const path = routeConnector({
        mode: 'left-to-right',
        source: parentBox,
        target: child,
        slotStart: 0,
        slots: 1,
        paths: 1,
      })[0] as ConnectorPath;
      expect(path.start.x).toBe(parentBox.x + parentBox.width);
      expect(path.end).toEqual({ x: child.x, y: child.y + child.height / 2 });
    });
  });

  describe('C2 own anchors', () => {
    it('spreads anchors along the parent side in child order', () => {
      const paths = flat(fan('top-down', row(5, childY, nodeWidth / 2, SIZE_MIX)));
      const starts = paths.map((p) => p.start.x);
      expect([...starts].sort((a, b) => a - b)).toEqual(starts);
      expect(new Set(starts).size).toBe(5);
      starts.forEach((x) => {
        expect(x).toBeGreaterThan(parentBox.x);
        expect(x).toBeLessThan(parentBox.x + parentBox.width);
      });
    });

    it('left-to-right spreads anchors along the parent right side', () => {
      const paths = flat(fan('left-to-right', row(4, childY, nodeWidth / 2, [[nodeWidth, nodeHeight]])));
      const starts = paths.map((p) => p.start.y);
      expect([...starts].sort((a, b) => a - b)).toEqual(starts);
      expect(new Set(starts).size).toBe(4);
      paths.forEach((p) => {
        expect(p.start.x).toBe(nodeHeight);
      });
    });

    it('a single child leaves at the middle of the side', () => {
      const [path] = flat(fan('top-down', row(1, childY, nodeWidth / 2, SIZE_MIX)));
      expect((path as ConnectorPath).start.x).toBe(parentBox.x + parentBox.width / 2);
    });
  });

  describe('C3 sibling separation', () => {
    it.each([2, 3, 6, 10, 14])('keeps %i mixed-size siblings apart beyond the fan-out length', (count) => {
      const paths = flat(fan('top-down', row(count, childY, nodeWidth / 2, SIZE_MIX)));
      for (let i = 0; i < paths.length; i += 1) {
        for (let j = i + 1; j < paths.length; j += 1) {
          expect(separation(paths[i] as ConnectorPath, paths[j] as ConnectorPath)).toBeGreaterThanOrEqual(
            CONNECTOR_MIN_SEPARATION,
          );
        }
      }
    });

    it('keeps wide fans apart when the children sit far to one side of the parent', () => {
      const paths = flat(fan('top-down', row(8, childY, 1500, SIZE_MIX)));
      for (let i = 0; i < paths.length; i += 1) {
        for (let j = i + 1; j < paths.length; j += 1) {
          expect(separation(paths[i] as ConnectorPath, paths[j] as ConnectorPath)).toBeGreaterThanOrEqual(
            CONNECTOR_MIN_SEPARATION,
          );
        }
      }
    });

    it('left-to-right siblings stay apart too', () => {
      const paths = flat(fan('left-to-right', row(7, childY, nodeWidth / 2, SIZE_MIX)));
      for (let i = 0; i < paths.length; i += 1) {
        for (let j = i + 1; j < paths.length; j += 1) {
          expect(separation(paths[i] as ConnectorPath, paths[j] as ConnectorPath)).toBeGreaterThanOrEqual(
            CONNECTOR_MIN_SEPARATION,
          );
        }
      }
    });
  });

  describe('parallel pair among siblings', () => {
    it('keeps every path of a three-way fan with a parallel pair apart', () => {
      const children = row(3, childY, nodeWidth / 2, SIZE_MIX);
      const paths = flat(fan('top-down', children, [1, 2, 1]));
      expect(paths).toHaveLength(4);
      for (let i = 0; i < paths.length; i += 1) {
        for (let j = i + 1; j < paths.length; j += 1) {
          expect(separation(paths[i] as ConnectorPath, paths[j] as ConnectorPath)).toBeGreaterThanOrEqual(
            CONNECTOR_MIN_SEPARATION,
          );
        }
      }
    });

    it('a parallel pair under a wide parent never crosses a neighbouring node', () => {
      const children = row(5, childY, nodeWidth / 2, SIZE_MIX);
      const groups = fan('top-down', children, [1, 3, 1, 2, 1]);
      groups.forEach((group, i) => {
        group.forEach((path) => {
          children.forEach((child, j) => {
            if (i !== j) {
              expect(crossesRect(path, child)).toBe(false);
            }
          });
        });
      });
    });
  });

  describe('C4 and C7 on hand-built trees', () => {
    it.each(['top-down', 'left-to-right'] as const)(
      '%s: no connector crosses a sibling or the parent, badges clear',
      (mode) => {
        const children = row(7, childY, 600, SIZE_MIX);
        const source = mode === 'top-down' ? parentBox : transpose(parentBox);
        const targets = children.map((child) => (mode === 'top-down' ? child : transpose(child)));
        const paths = flat(fan(mode, children));
        paths.forEach((path, i) => {
          targets.forEach((target, j) => {
            if (i !== j) {
              expect(crossesRect(path, target)).toBe(false);
            }
            expect(insideBadge(path.badge, target)).toBe(false);
          });
          expect(crossesRect(path, source)).toBe(false);
          expect(insideBadge(path.badge, source)).toBe(false);
        });
      },
    );
  });

  describe('C5 parallel connections', () => {
    it.each(['top-down', 'left-to-right', 'radial'] as const)(
      '%s draws separate paths at least the gap apart at mid-length',
      (mode) => {
        const target = mode === 'left-to-right' ? box(nodeWidth + levelSpacing, 300) : box(300, childY);
        const paths = routeConnector({ mode, source: parentBox, target, slotStart: 0, slots: 1, paths: 3 });
        expect(new Set(paths.map((p) => p.d)).size).toBe(3);
        for (let i = 1; i < paths.length; i += 1) {
          const a = (paths[i - 1] as ConnectorPath).badge;
          const b = (paths[i] as ConnectorPath).badge;
          expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThanOrEqual(CONNECTOR_PARALLEL_GAP - 0.001);
        }
      },
    );

    it('a straight pair stays at least the gap apart along its length', () => {
      const paths = routeConnector({
        mode: 'top-down',
        source: parentBox,
        target: box(0, childY),
        slotStart: 0,
        slots: 1,
        paths: 2,
      });
      const [a, b] = paths.map((p) => samplePath(p, SAMPLES)) as [Point[], Point[]];
      a.forEach((point) => {
        expect(distanceToPolyline(point, b)).toBeGreaterThanOrEqual(CONNECTOR_PARALLEL_GAP - 0.001);
      });
    });

    it('one connection yields one path', () => {
      expect(
        routeConnector({
          mode: 'top-down',
          source: parentBox,
          target: box(0, childY),
          slotStart: 0,
          slots: 1,
          paths: 1,
        }),
      ).toHaveLength(1);
    });
  });

  describe('leaves', () => {
    it.each([
      ['alias', aliasWidth, aliasHeight],
      ['+N', collapsedWidth, collapsedHeight],
    ])('a %s leaf ends on its top edge with the badge clear of both nodes', (_name, width, height) => {
      const child = box(240, childY + (nodeHeight - height) / 2, width, height);
      const path = routeConnector({
        mode: 'top-down',
        source: parentBox,
        target: child,
        slotStart: 0,
        slots: 1,
        paths: 1,
      })[0] as ConnectorPath;
      expect(path.end).toEqual({ x: child.x + width / 2, y: child.y });
      expect(insideBadge(path.badge, parentBox)).toBe(false);
      expect(insideBadge(path.badge, child)).toBe(false);
    });
  });

  describe('radial', () => {
    it('is a straight line between the node centres with the badge between the boxes', () => {
      const target = box(300, 200);
      const path = routeConnector({
        mode: 'radial',
        source: parentBox,
        target,
        slotStart: 0,
        slots: 1,
        paths: 1,
      })[0] as ConnectorPath;
      const [from, c1, c2, to] = path.segments[0] as readonly [Point, Point, Point, Point];
      expect(from).toEqual({ x: nodeWidth / 2, y: nodeHeight / 2 });
      expect(to).toEqual({ x: 300 + nodeWidth / 2, y: 200 + nodeHeight / 2 });
      const cross = (p: Point) => (p.x - from.x) * (to.y - from.y) - (p.y - from.y) * (to.x - from.x);
      expect(Math.abs(cross(c1))).toBeLessThan(1e-6);
      expect(Math.abs(cross(c2))).toBeLessThan(1e-6);
      expect(Math.abs(cross(path.badge))).toBeLessThan(1e-6);
      const inside = (rect: Rect) =>
        path.badge.x >= rect.x &&
        path.badge.x <= rect.x + rect.width &&
        path.badge.y >= rect.y &&
        path.badge.y <= rect.y + rect.height;
      expect(inside(parentBox) || inside(target)).toBe(false);
    });

    it('overlapping boxes fall back to a finite midpoint', () => {
      const path = routeConnector({
        mode: 'radial',
        source: parentBox,
        target: box(10, 10),
        slotStart: 0,
        slots: 1,
        paths: 1,
      })[0] as ConnectorPath;
      expect(Number.isFinite(path.badge.x)).toBe(true);
    });
  });
});
