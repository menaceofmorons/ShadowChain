// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { collapseChainTree } from '../../../model/chainOps';
import { buildChainTree } from '../../../model/chainTree';
import type { ChainGraph, ChainNode, ChainTree } from '../../../model/types';
import { generateChain, SYNTHETIC_ROOT_SYSTEM_ID } from '../../../synthetic';
import { DEFAULT_ENGINE_OPTIONS } from '../../engineOptions';
import type { PlacedNode } from '../../types';
import { createElkEngine } from './elkEngine';
import { RADIAL_MAX_EXTENT_AT_150, RADIAL_MAX_GAP_RATIO, smoothRingRadii } from './radialLegibility';

const OPTIONS = DEFAULT_ENGINE_OPTIONS;
const RING_TOLERANCE = 1;
const RATIO_TOLERANCE = 1.005;
const ANGLE_TOLERANCE = 1e-3;
const MAX_CHILD_TURN = 2.5;
const CASES = [
  { nodes: 150, seed: 7 },
  { nodes: 150, seed: 8 },
  { nodes: 500, seed: 7 },
] as const;

const engine = createElkEngine();
const treeOf = (graph: ChainGraph): ChainTree => buildChainTree(graph, SYNTHETIC_ROOT_SYSTEM_ID);

const sizeOf = (node: PlacedNode): { w: number; h: number } => {
  if (node.alias) return { w: OPTIONS.aliasWidth, h: OPTIONS.aliasHeight };
  if (node.hiddenCount !== null) return { w: OPTIONS.collapsedWidth, h: OPTIONS.collapsedHeight };
  return { w: OPTIONS.nodeWidth, h: OPTIONS.nodeHeight };
};

const centreOf = (node: PlacedNode): { x: number; y: number } => {
  const { w, h } = sizeOf(node);
  return { x: node.x + w / 2, y: node.y + h / 2 };
};

const wrap = (angle: number): number => {
  const turned = angle % (2 * Math.PI);
  if (turned > Math.PI) return turned - 2 * Math.PI;
  return turned <= -Math.PI ? turned + 2 * Math.PI : turned;
};

const layoutOf = async (tree: ChainTree, collapsedKeys: readonly string[] = []): Promise<Map<string, PlacedNode>> =>
  new Map(
    (await engine.layout({ type: 'full', tree, mode: 'radial', manualPositions: [], collapsedKeys })).map((node) => [
      node.nodeKey,
      node,
    ]),
  );

interface Geometry {
  readonly angle: (node: ChainNode) => number;
  readonly radius: (node: ChainNode) => number;
}

const geometryOf = (tree: ChainTree, placed: ReadonlyMap<string, PlacedNode>): Geometry => {
  const origin = centreOf(placed.get(tree.root.keyString) as PlacedNode);
  const centre = (node: ChainNode) => centreOf(placed.get(node.keyString) as PlacedNode);
  return {
    angle: (node) => Math.atan2(centre(node).y - origin.y, centre(node).x - origin.x),
    radius: (node) => Math.hypot(centre(node).x - origin.x, centre(node).y - origin.y),
  };
};

const levelsOf = (tree: ChainTree): ChainNode[][] => {
  const levels: ChainNode[][] = [];
  const walk = (node: ChainNode, depth: number): void => {
    (levels[depth] ??= []).push(node);
    node.children.forEach((child) => {
      walk(child, depth + 1);
    });
  };
  walk(tree.root, 0);
  return levels;
};

const ringRadii = (tree: ChainTree, geometry: Geometry): number[] =>
  levelsOf(tree).map((level) => level.reduce((sum, node) => sum + geometry.radius(node), 0) / level.length);

const extentOf = (placed: ReadonlyMap<string, PlacedNode>): { width: number; height: number } => {
  const boxes = [...placed.values()].map((node) => ({ node, size: sizeOf(node) }));
  const span = (low: (b: (typeof boxes)[number]) => number, high: (b: (typeof boxes)[number]) => number) =>
    Math.max(...boxes.map(high)) - Math.min(...boxes.map(low));
  return {
    width: span(
      (b) => b.node.x,
      (b) => b.node.x + b.size.w,
    ),
    height: span(
      (b) => b.node.y,
      (b) => b.node.y + b.size.h,
    ),
  };
};

const subtreeSpan = (node: ChainNode, reference: number, geometry: Geometry): [number, number] => {
  const own = wrap(geometry.angle(node) - reference);
  return node.children.reduce<[number, number]>(
    ([low, high], child) => {
      const [childLow, childHigh] = subtreeSpan(child, reference, geometry);
      return [Math.min(low, childLow), Math.max(high, childHigh)];
    },
    [own, own],
  );
};

const starGraph = (children: number): ChainGraph => ({
  systems: Array.from({ length: children + 1 }, (_, index) => ({ id: SYNTHETIC_ROOT_SYSTEM_ID + index })),
  connections: Array.from({ length: children }, (_, index) => ({
    id: index + 1,
    createdAt: index + 1,
    endA: SYNTHETIC_ROOT_SYSTEM_ID,
    endB: SYNTHETIC_ROOT_SYSTEM_ID + index + 1,
  })),
});

describe.each(CASES)('radial rules at $nodes nodes, seed $seed', ({ nodes, seed }) => {
  const tree = treeOf(generateChain({ nodeCount: nodes, seed }));
  const placedPromise = layoutOf(tree);

  it('rule 1: every level is one circle around the root, each strictly outside the previous', async () => {
    const geometry = geometryOf(tree, await placedPromise);
    let previous = -1;
    for (const level of levelsOf(tree)) {
      const ring = geometry.radius(level[0] as ChainNode);
      for (const node of level) {
        expect(Math.abs(geometry.radius(node) - ring)).toBeLessThan(RING_TOLERANCE);
      }
      expect(ring).toBeGreaterThan(previous);
      previous = ring;
    }
  });

  it('rule 2: children fan out from their parent inside the parent slice, siblings keep apart', async () => {
    const geometry = geometryOf(tree, await placedPromise);
    const visit = (node: ChainNode, depth: number): void => {
      if (depth > 0 && node.children.length > 0) {
        const turns = node.children.map((child) => wrap(geometry.angle(child) - geometry.angle(node)));
        expect(Math.min(...turns)).toBeLessThan(ANGLE_TOLERANCE);
        expect(Math.max(...turns)).toBeGreaterThan(-ANGLE_TOLERANCE);
        expect(Math.max(...turns.map(Math.abs))).toBeLessThan(MAX_CHILD_TURN);
        const spans = node.children
          .map((child) => subtreeSpan(child, geometry.angle(node), geometry))
          .sort((a, b) => a[0] - b[0]);
        spans.slice(1).forEach(([low], index) => {
          expect(low).toBeGreaterThan((spans[index] as [number, number])[1] - ANGLE_TOLERANCE);
        });
      }
      node.children.forEach((child) => {
        visit(child, depth + 1);
      });
    };
    visit(tree.root, 0);
  });

  it('rule 3: every ring has room for the boxes it carries', async () => {
    const placed = await placedPromise;
    const geometry = geometryOf(tree, placed);
    levelsOf(tree).forEach((level, depth) => {
      if (depth === 0) return;
      const widths = level.reduce((sum, node) => sum + sizeOf(placed.get(node.keyString) as PlacedNode).w, 0);
      expect(2 * Math.PI * geometry.radius(level[0] as ChainNode)).toBeGreaterThanOrEqual(widths);
    });
  });

  it('rule 4: ring gaps stay within the stated ratio between adjacent levels', async () => {
    const radii = ringRadii(tree, geometryOf(tree, await placedPromise));
    const gaps = radii.slice(1).map((radius, index) => radius - (radii[index] as number));
    gaps.slice(1).forEach((gap, index) => {
      const ratio = Math.max(gap, gaps[index] as number) / Math.min(gap, gaps[index] as number);
      expect(ratio, `gap ${String(index + 1)} to ${String(index + 2)}`).toBeLessThanOrEqual(
        RADIAL_MAX_GAP_RATIO * RATIO_TOLERANCE,
      );
    });
  });

  it.skipIf(nodes !== 150)('rule 6: overall extent at 150 nodes is within the stated bound', async () => {
    const { width, height } = extentOf(await placedPromise);
    expect(Math.max(width, height)).toBeLessThanOrEqual(RADIAL_MAX_EXTENT_AT_150);
  });
});

describe('rule 3: a level that needs more room grows as a whole', () => {
  it('ring 1 grows for all its nodes when more children are added, and stays one circle', async () => {
    const radiusAt = async (children: number): Promise<number> => {
      const tree = treeOf(starGraph(children));
      const geometry = geometryOf(tree, await layoutOf(tree));
      const radii = tree.root.children.map((child) => geometry.radius(child));
      expect(Math.max(...radii) - Math.min(...radii)).toBeLessThan(RING_TOLERANCE);
      return radii[0] as number;
    };
    const few = await radiusAt(4);
    const many = await radiusAt(40);
    expect(many).toBeGreaterThan(few);
    expect(2 * Math.PI * many).toBeGreaterThanOrEqual(40 * OPTIONS.nodeWidth);
  });
});

describe('rules 1 and 4 with collapsed +N nodes present', () => {
  it('keeps one circle per level and bounded gaps when branches are collapsed', async () => {
    const full = treeOf(generateChain({ nodeCount: 150, seed: 7 }));
    const targets = full.root.children.flatMap((child) => child.children.slice(0, 1)).slice(0, 4);
    const tree = collapseChainTree(full, new Set(targets.map((node) => node.keyString)));
    const placed = await layoutOf(
      tree,
      targets.map((node) => node.keyString),
    );
    expect([...placed.values()].filter((node) => node.hiddenCount !== null)).toHaveLength(targets.length);
    const geometry = geometryOf(tree, placed);
    for (const level of levelsOf(tree)) {
      const ring = geometry.radius(level[0] as ChainNode);
      expect(Math.max(...level.map((node) => Math.abs(geometry.radius(node) - ring)))).toBeLessThan(RING_TOLERANCE);
    }
  });
});

describe('smoothRingRadii', () => {
  it('leaves radii that already meet the ratio as they are', () => {
    expect(smoothRingRadii([0, 200, 400, 600], 200, 2)).toEqual([0, 200, 400, 600]);
  });

  it('never moves a ring inward and keeps every gap within the ratio', () => {
    const minimum = [0, 560, 1299, 1635, 3226, 3450, 3674, 3898, 4122];
    const smooth = smoothRingRadii(minimum, 224, 2);
    smooth.forEach((radius, depth) => {
      expect(radius).toBeGreaterThanOrEqual((minimum[depth] as number) - 1e-6);
    });
    const gaps = smooth.slice(1).map((radius, index) => radius - (smooth[index] as number));
    gaps.slice(1).forEach((gap, index) => {
      expect(Math.max(gap, gaps[index] as number) / Math.min(gap, gaps[index] as number)).toBeLessThanOrEqual(2 + 1e-9);
    });
    expect(gaps.every((gap) => gap >= 224 - 1e-9)).toBe(true);
  });
});
