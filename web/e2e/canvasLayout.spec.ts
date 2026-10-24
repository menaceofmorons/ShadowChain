import { expect, test } from '@playwright/test';
import type { CanvasHostState } from './host/canvas';
import { DEFAULT_ENGINE_OPTIONS } from '../src/map/layout/engineOptions';
import { RADIAL_MAX_EXTENT_AT_150, RADIAL_MAX_GAP_RATIO } from '../src/map/layout/engines/elk/radialLegibility';
import { LAYOUT_MODES } from '../src/map/layout/types';
import { buildChainTree } from '../src/map/model/chainTree';
import type { ChainNode } from '../src/map/model/types';
import { generateChain, SYNTHETIC_ROOT_SYSTEM_ID } from '../src/map/synthetic';

const NODE_COUNT = 150;

const EXPECTED_ENGINE = { 'top-down': 'tidy-tree', 'left-to-right': 'tidy-tree', radial: 'elkjs' } as const;

const EXPECTED_HANDLES = {
  'top-down': { source: 'react-flow__handle-bottom', target: 'react-flow__handle-top' },
  'left-to-right': { source: 'react-flow__handle-right', target: 'react-flow__handle-left' },
  radial: { source: 'react-flow__handle-top', target: 'react-flow__handle-top' },
} as const;

interface DrawnBox {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

const readDrawnBoxes = (): DrawnBox[] =>
  [...document.querySelectorAll<HTMLElement>('.react-flow__node')].map((element) => {
    const origin = /translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)/.exec(element.style.transform);
    return {
      id: element.dataset.id ?? '',
      x: Number(origin?.[1]),
      y: Number(origin?.[2]),
      width: element.offsetWidth,
      height: element.offsetHeight,
    };
  });

const overlappingPairs = (boxes: readonly DrawnBox[]): string[] => {
  const pairs: string[] = [];
  boxes.forEach((a, index) => {
    for (const b of boxes.slice(index + 1)) {
      if (a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height) {
        pairs.push(`${a.id}/${b.id}`);
      }
    }
  });
  return pairs;
};

interface Centre {
  id: string;
  x: number;
  y: number;
}

const readScreenCentres = (): Centre[] =>
  [...document.querySelectorAll<HTMLElement>('.react-flow__node')].map((element) => {
    const rect = element.getBoundingClientRect();
    return { id: element.dataset.id ?? '', x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  });

const treeFor = (nodeCount: number, seed: number): ChainNode =>
  buildChainTree(generateChain({ nodeCount, seed }), SYNTHETIC_ROOT_SYSTEM_ID).root;

const depthsOf = (nodeCount: number, seed: number): Map<string, number> => {
  const depths = new Map<string, number>();
  const walk = (node: ChainNode, depth: number): void => {
    depths.set(node.keyString, depth);
    node.children.forEach((child) => {
      walk(child, depth + 1);
    });
  };
  walk(treeFor(nodeCount, seed), 0);
  return depths;
};

const RING_TOLERANCE_PX = 1;
const RATIO_TOLERANCE = 1.005;
const ANGLE_TOLERANCE = 1e-3;
const RADIAL_CASES = [
  { nodes: 150, seed: 7 },
  { nodes: 150, seed: 8 },
  { nodes: 500, seed: 7 },
] as const;

const wrapAngle = (angle: number): number => {
  const turned = angle % (2 * Math.PI);
  if (turned > Math.PI) return turned - 2 * Math.PI;
  return turned <= -Math.PI ? turned + 2 * Math.PI : turned;
};

for (const { nodes, seed } of RADIAL_CASES) {
  test.describe(`radial rules as drawn on screen, ${String(nodes)} nodes, seed ${String(seed)}`, () => {
    const url = `/e2e/host/canvas.html?mode=radial&size=${String(nodes)}&seed=${String(seed)}`;

    test('rules 1 and 4: one circle per level, each outside the previous, gaps within the ratio', async ({ page }) => {
      await page.goto(url);
      await page.waitForFunction(() => (window as unknown as { __canvas: CanvasHostState }).__canvas.done);
      const centres = await page.evaluate(readScreenCentres);
      const depths = depthsOf(nodes, seed);
      const root = centres.find((centre) => depths.get(centre.id) === 0) as Centre;
      const radiiByDepth = new Map<number, number[]>();
      for (const centre of centres) {
        const depth = depths.get(centre.id) as number;
        radiiByDepth.set(depth, [...(radiiByDepth.get(depth) ?? []), Math.hypot(centre.x - root.x, centre.y - root.y)]);
      }
      const levels = [...radiiByDepth.entries()].sort(([a], [b]) => a - b);
      expect(levels.length).toBeGreaterThan(2);
      let previous = -1;
      for (const [depth, radii] of levels) {
        const ring = radii[0] as number;
        expect(
          Math.max(...radii.map((radius) => Math.abs(radius - ring))),
          `ring ${String(depth)} spread`,
        ).toBeLessThan(RING_TOLERANCE_PX);
        expect(ring, `ring ${String(depth)} outside the previous`).toBeGreaterThan(previous);
        previous = ring;
      }
      const means = levels.map(([, radii]) => radii.reduce((sum, radius) => sum + radius, 0) / radii.length);
      const gaps = means.slice(1).map((radius, index) => radius - (means[index] as number));
      gaps.slice(1).forEach((gap, index) => {
        const ratio = Math.max(gap, gaps[index] as number) / Math.min(gap, gaps[index] as number);
        expect(ratio, `gap ${String(index + 1)} to ${String(index + 2)}`).toBeLessThanOrEqual(
          RADIAL_MAX_GAP_RATIO * RATIO_TOLERANCE,
        );
      });
    });

    test('rule 2: children fan out from their parent on screen', async ({ page }) => {
      await page.goto(url);
      await page.waitForFunction(() => (window as unknown as { __canvas: CanvasHostState }).__canvas.done);
      const centres = new Map((await page.evaluate(readScreenCentres)).map((centre) => [centre.id, centre]));
      const rootNode = treeFor(nodes, seed);
      const origin = centres.get(rootNode.keyString) as Centre;
      const angleOf = (node: ChainNode): number => {
        const centre = centres.get(node.keyString) as Centre;
        return Math.atan2(centre.y - origin.y, centre.x - origin.x);
      };
      const visit = (node: ChainNode, depth: number): void => {
        if (depth > 0 && node.children.length > 0) {
          const turns = node.children.map((child) => wrapAngle(angleOf(child) - angleOf(node)));
          expect(Math.min(...turns), node.keyString).toBeLessThan(ANGLE_TOLERANCE);
          expect(Math.max(...turns), node.keyString).toBeGreaterThan(-ANGLE_TOLERANCE);
        }
        node.children.forEach((child) => {
          visit(child, depth + 1);
        });
      };
      visit(rootNode, 0);
    });

    test('rule 5: the root is drawn differently from depth-1 nodes and ring guides are on the page', async ({ page }) => {
      await page.goto(url);
      await page.waitForFunction(() => (window as unknown as { __canvas: CanvasHostState }).__canvas.done);
      const rootNode = treeFor(nodes, seed);
      const border = (key: string) =>
        page.evaluate((id) => {
          const element = document.querySelector<HTMLElement>(`.react-flow__node[data-id="${id}"] > div`);
          return element === null ? null : getComputedStyle(element).borderTopWidth;
        }, key);
      const rootBorder = await border(rootNode.keyString);
      expect(rootBorder).not.toBeNull();
      for (const child of rootNode.children) {
        expect(await border(child.keyString)).not.toBe(rootBorder);
      }
      const state = await page.evaluate(() => (window as unknown as { __canvas: CanvasHostState }).__canvas);
      const deepest = Math.max(...depthsOf(nodes, seed).values());
      expect(state.ringGuides).toBe(deepest);
    });

    if (nodes === NODE_COUNT) {
      test('rule 6: overall extent is within the stated bound', async ({ page }) => {
        await page.goto(url);
        await page.waitForFunction(() => (window as unknown as { __canvas: CanvasHostState }).__canvas.done);
        const boxes = await page.evaluate(readDrawnBoxes);
        const width = Math.max(...boxes.map((box) => box.x + box.width)) - Math.min(...boxes.map((box) => box.x));
        const height = Math.max(...boxes.map((box) => box.y + box.height)) - Math.min(...boxes.map((box) => box.y));
        expect(Math.max(width, height)).toBeLessThanOrEqual(RADIAL_MAX_EXTENT_AT_150);
      });
    }
  });
}

test.describe('radial with +N nodes drawn', () => {
  test('no drawn boxes overlap', async ({ page }) => {
    await page.goto(`/e2e/host/canvas.html?mode=radial&size=${String(NODE_COUNT)}&seed=7&collapse=5`);
    await page.waitForFunction(() => (window as unknown as { __canvas: CanvasHostState }).__canvas.done);
    const state = await page.evaluate(() => (window as unknown as { __canvas: CanvasHostState }).__canvas);
    expect(state.error).toBeNull();
    expect(state.collapsedCount).toBe(5);
    const boxes = await page.evaluate(readDrawnBoxes);
    expect(boxes.filter((box) => box.id.startsWith('+:'))).toHaveLength(5);
    expect(overlappingPairs(boxes)).toEqual([]);
  });
});

test.describe('collapsed branches drawn as +N nodes', () => {
  const COLLAPSED_BRANCHES = 5;
  for (const mode of ['top-down', 'left-to-right'] as const) {
    test(`${mode}: +N nodes are drawn at the engine size and nothing overlaps`, async ({ page }, testInfo) => {
      await page.goto(
        `/e2e/host/canvas.html?mode=${mode}&size=${String(NODE_COUNT)}&seed=7&collapse=${String(COLLAPSED_BRANCHES)}`,
      );
      await page.waitForFunction(() => (window as unknown as { __canvas: CanvasHostState }).__canvas.done);
      const state = await page.evaluate(() => (window as unknown as { __canvas: CanvasHostState }).__canvas);
      expect(state.error).toBeNull();
      expect(state.collapsedCount).toBe(COLLAPSED_BRANCHES);
      expect(state.nodeCount).toBe(state.expectedNodeCount);
      expect(state.edgeCount).toBe(state.expectedNodeCount - 1);
      const boxes = await page.evaluate(readDrawnBoxes);
      const plusN = boxes.filter((box) => box.id.startsWith('+:'));
      expect(plusN).toHaveLength(COLLAPSED_BRANCHES);
      for (const box of plusN) {
        expect(box.width).toBe(DEFAULT_ENGINE_OPTIONS.collapsedWidth);
        expect(box.height).toBe(DEFAULT_ENGINE_OPTIONS.collapsedHeight);
      }
      const labels = await page.evaluate(() =>
        [...document.querySelectorAll<HTMLElement>('.react-flow__node')]
          .filter((element) => (element.dataset.id ?? '').startsWith('+:'))
          .map((element) => element.textContent ?? ''),
      );
      expect(labels.every((label) => /^\+\d+$/.test(label))).toBe(true);
      expect(overlappingPairs(boxes)).toEqual([]);
      await testInfo.attach(`canvas-collapsed-${mode}`, { body: await page.screenshot(), contentType: 'image/png' });
    });
  }
});

test.describe('150-node chain on the canvas through the map entry point', () => {
  for (const mode of LAYOUT_MODES) {
    test(`${mode}: every node and parent edge renders using the registered engine`, async ({ page }, testInfo) => {
      const problems: string[] = [];
      page.on('pageerror', (error) => {
        problems.push(error.message);
      });
      await page.goto(`/e2e/host/canvas.html?mode=${mode}&size=${String(NODE_COUNT)}&seed=7`);
      await page.waitForFunction(() => (window as unknown as { __canvas: CanvasHostState }).__canvas.done);
      const state = await page.evaluate(() => (window as unknown as { __canvas: CanvasHostState }).__canvas);
      expect(problems).toEqual([]);
      expect(state.error).toBeNull();
      expect(state.engine).toBe(EXPECTED_ENGINE[mode]);
      expect(state.expectedNodeCount).toBeGreaterThanOrEqual(NODE_COUNT);
      expect(state.nodeCount).toBe(state.expectedNodeCount);
      expect(state.edgeCount).toBe(state.expectedNodeCount - 1);
      await testInfo.attach(`canvas-${mode}`, { body: await page.screenshot(), contentType: 'image/png' });
    });

    test(`${mode}: drawn boxes do not overlap and connectors use the mode's sides`, async ({ page }) => {
      await page.goto(`/e2e/host/canvas.html?mode=${mode}&size=${String(NODE_COUNT)}&seed=7`);
      await page.waitForFunction(() => (window as unknown as { __canvas: CanvasHostState }).__canvas.done);
      const boxes = await page.evaluate(readDrawnBoxes);
      expect(boxes.length).toBeGreaterThanOrEqual(NODE_COUNT);
      expect(boxes.every((box) => Number.isFinite(box.x) && Number.isFinite(box.y) && box.width > 0)).toBe(true);
      expect(overlappingPairs(boxes)).toEqual([]);
      const handles = await page.evaluate(() => ({
        source: [...document.querySelectorAll('.react-flow__handle.source')].map((handle) => handle.className),
        target: [...document.querySelectorAll('.react-flow__handle.target')].map((handle) => handle.className),
      }));
      expect(handles.source).toHaveLength(boxes.length);
      expect(handles.source.every((name) => name.includes(EXPECTED_HANDLES[mode].source))).toBe(true);
      expect(handles.target.every((name) => name.includes(EXPECTED_HANDLES[mode].target))).toBe(true);
      const edgeKinds = await page.evaluate(() =>
        [...document.querySelectorAll('.react-flow__edge')].map((edge) =>
          edge.classList.contains('react-flow__edge-straight'),
        ),
      );
      expect(edgeKinds.every((straight) => straight === (mode === 'radial'))).toBe(true);
    });
  }
});
