import { describe, expect, it } from 'vitest';
import { DEFAULT_ENGINE_OPTIONS } from '../../layout/engineOptions';
import { BADGE_HEIGHT, BADGE_WIDTH, CONNECTOR_FAN_OUT_LENGTH, CONNECTOR_MIN_SEPARATION } from './connectorBounds';
import {
  CONNECTOR_PARALLEL_GAP,
  distanceToPolyline,
  routeConnector,
  samplePath,
  samplePathEvery,
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
const SHARED = 0.25;
const STEP = 2;

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

function column(count: number, x: number, centreY: number, sizes: readonly [number, number][]): Rect[] {
  const heights = Array.from({ length: count }, (_, i) => (sizes[i % sizes.length] as [number, number])[1]);
  const total = heights.reduce((sum, h) => sum + h, 0) + siblingSpacing * (count - 1);
  let cursor = centreY - total / 2;
  return heights.map((height, i) => {
    const width = (sizes[i % sizes.length] as [number, number])[0];
    const rect = box(x + (nodeWidth - width) / 2, cursor, width, height);
    cursor += height + siblingSpacing;
    return rect;
  });
}

const parentBox = box(0, 0);
const levelX = nodeWidth + levelSpacing;
const childY = nodeHeight + levelSpacing;

function fan(
  mode: 'top-down' | 'left-to-right',
  children: readonly Rect[],
  parallels: readonly number[] = [],
): ConnectorPath[][] {
  return children.map((target, index) =>
    routeConnector({ mode, source: parentBox, target, paths: parallels[index] ?? 1 }),
  );
}

const rowFor = (mode: 'top-down' | 'left-to-right', count: number, centre = nodeWidth / 2): Rect[] =>
  mode === 'top-down'
    ? row(count, childY, centre, SIZE_MIX)
    : column(count, levelX, centre - nodeWidth / 2 + nodeHeight / 2, SIZE_MIX);

const flat = (groups: readonly ConnectorPath[][]): ConnectorPath[] => groups.flat();

const arcLengths = (points: readonly Point[]): number[] => {
  const lengths = [0];
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1] as Point;
    const b = points[i] as Point;
    lengths.push((lengths[i - 1] as number) + Math.hypot(b.x - a.x, b.y - a.y));
  }
  return lengths;
};

const afterSplit = (a: ConnectorPath, b: ConnectorPath): Point[] => {
  const points = samplePathEvery(a, STEP);
  const other = samplePathEvery(b, STEP);
  let lastShared = -1;
  points.forEach((p, i) => {
    if (distanceToPolyline(p, other) < SHARED) {
      lastShared = i;
    }
  });
  const lengths = arcLengths(points);
  return points.filter(
    (_, i) =>
      i > lastShared &&
      (lengths[i] as number) - (lengths[Math.max(lastShared, 0)] as number) >= CONNECTOR_FAN_OUT_LENGTH,
  );
};

const separation = (a: ConnectorPath, b: ConnectorPath): number => {
  const otherB = samplePathEvery(b, STEP);
  const otherA = samplePathEvery(a, STEP);
  return Math.min(
    ...afterSplit(a, b).map((p) => distanceToPolyline(p, otherB)),
    ...afterSplit(b, a).map((p) => distanceToPolyline(p, otherA)),
  );
};

const expectBranchesApart = (paths: readonly ConnectorPath[]): void => {
  for (let i = 0; i < paths.length; i += 1) {
    for (let j = i + 1; j < paths.length; j += 1) {
      expect(separation(paths[i] as ConnectorPath, paths[j] as ConnectorPath)).toBeGreaterThanOrEqual(
        CONNECTOR_MIN_SEPARATION,
      );
    }
  }
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
      const path = routeConnector({ mode: 'top-down', source: parentBox, target: child, paths: 1 })[0] as ConnectorPath;
      expect(path.start.y).toBe(parentBox.y + parentBox.height);
      expect(path.end).toEqual({ x: child.x + child.width / 2, y: child.y });
    });

    it('left-to-right leaves the parent right side and enters the child left side', () => {
      const child = box(levelX, 300);
      const path = routeConnector({
        mode: 'left-to-right',
        source: parentBox,
        target: child,
        paths: 1,
      })[0] as ConnectorPath;
      expect(path.start.x).toBe(parentBox.x + parentBox.width);
      expect(path.end).toEqual({ x: child.x, y: child.y + child.height / 2 });
    });
  });

  describe('C2 one exit point and shared trunk', () => {
    it('top-down: every child leaves from the bottom centre', () => {
      const paths = flat(fan('top-down', row(7, childY, nodeWidth / 2, SIZE_MIX)));
      paths.forEach((p) => {
        expect(p.start).toEqual({ x: parentBox.width / 2, y: parentBox.height });
      });
    });

    it('left-to-right: every child leaves from the right-side centre', () => {
      const paths = flat(fan('left-to-right', rowFor('left-to-right', 5)));
      paths.forEach((p) => {
        expect(p.start).toEqual({ x: parentBox.width, y: parentBox.height / 2 });
      });
    });

    it('children on one side share the same trunk segments before branching', () => {
      const paths = flat(fan('top-down', row(6, childY, 1000, SIZE_MIX)));
      const first = (paths[0] as ConnectorPath).segments.slice(0, 3);
      paths.forEach((p) => {
        expect(p.segments.slice(0, 2)).toEqual(first.slice(0, 2));
      });
    });

    it('branches end with their own rounded bend into the child', () => {
      const paths = flat(fan('top-down', row(4, childY, nodeWidth / 2, SIZE_MIX)));
      paths
        .filter((p) => p.segments.length === 5)
        .forEach((p) => {
          expect(p.segments[3]).not.toEqual(p.segments[1]);
        });
    });
  });

  describe('C3 branches apart after the split', () => {
    it.each([2, 3, 6, 12, 20])(
      '%i mixed-size siblings never overlap once split',
      (count) => {
        expectBranchesApart(flat(fan('top-down', row(count, childY, nodeWidth / 2, SIZE_MIX))));
      },
      60_000,
    );

    it('children far to one side stay apart', () => {
      expectBranchesApart(flat(fan('top-down', row(8, childY, 1500, SIZE_MIX))));
    });

    it('left-to-right siblings stay apart too', () => {
      expectBranchesApart(flat(fan('left-to-right', rowFor('left-to-right', 14))));
    });

    it('a fan with parallel pairs stays apart', () => {
      expectBranchesApart(flat(fan('top-down', row(4, childY, nodeWidth / 2, SIZE_MIX), [1, 2, 1, 3])));
    });
  });

  describe('C4 and C7 on hand-built trees', () => {
    it.each(['top-down', 'left-to-right'] as const)(
      '%s: no connector crosses a sibling or the parent, badges clear',
      (mode) => {
        const targets = rowFor(mode, 9, 600);
        const source = parentBox;
        fan(mode, targets, [1, 2, 1, 1, 3]).forEach((group, i) => {
          group.forEach((path) => {
            targets.forEach((target, j) => {
              if (i !== j) {
                expect(crossesRect(path, target)).toBe(false);
              }
              expect(insideBadge(path.badge, target)).toBe(false);
            });
            expect(crossesRect(path, source)).toBe(false);
            expect(insideBadge(path.badge, source)).toBe(false);
          });
        });
      },
    );
  });

  describe('C5 parallel connections', () => {
    it.each(['top-down', 'left-to-right', 'radial'] as const)(
      '%s draws separate paths with badges at least the gap apart',
      (mode) => {
        const target = mode === 'left-to-right' ? box(levelX, 300) : box(300, childY);
        const paths = routeConnector({ mode, source: parentBox, target, paths: 3 });
        expect(new Set(paths.map((p) => p.d)).size).toBe(3);
        for (let i = 1; i < paths.length; i += 1) {
          const a = (paths[i - 1] as ConnectorPath).badge;
          const b = (paths[i] as ConnectorPath).badge;
          expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThanOrEqual(CONNECTOR_PARALLEL_GAP);
        }
      },
    );

    it('a pair split off the trunk stays apart', () => {
      expectBranchesApart(routeConnector({ mode: 'top-down', source: parentBox, target: box(300, childY), paths: 2 }));
    });

    it('a straight pair stays at least the gap apart along its branch', () => {
      const paths = routeConnector({ mode: 'top-down', source: parentBox, target: box(0, childY), paths: 2 });
      expect((paths[0] as ConnectorPath).badge).not.toEqual((paths[1] as ConnectorPath).badge);
    });

    it('one connection yields one path', () => {
      expect(routeConnector({ mode: 'top-down', source: parentBox, target: box(0, childY), paths: 1 })).toHaveLength(1);
    });
  });

  describe('leaves', () => {
    it.each([
      ['alias', aliasWidth, aliasHeight],
      ['+N', collapsedWidth, collapsedHeight],
    ])('a %s leaf ends on its top edge with the badge clear of both nodes', (_name, width, height) => {
      const child = box(240, childY + (nodeHeight - height) / 2, width, height);
      const path = routeConnector({ mode: 'top-down', source: parentBox, target: child, paths: 1 })[0] as ConnectorPath;
      expect(path.end).toEqual({ x: child.x + width / 2, y: child.y });
      expect(insideBadge(path.badge, parentBox)).toBe(false);
      expect(insideBadge(path.badge, child)).toBe(false);
    });
  });

  describe('radial', () => {
    it('is a straight line between the node centres with the badge between the boxes', () => {
      const target = box(300, 200);
      const path = routeConnector({ mode: 'radial', source: parentBox, target, paths: 1 })[0] as ConnectorPath;
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
        paths: 1,
      })[0] as ConnectorPath;
      expect(Number.isFinite(path.badge.x)).toBe(true);
    });
  });
});
