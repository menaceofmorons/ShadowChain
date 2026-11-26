import { expect, test, type Page } from '@playwright/test';
import type { CanvasHostState } from './host/canvas';
import {
  BADGE_HEIGHT,
  BADGE_WIDTH,
  CONNECTOR_ASSERTED_FAN,
  CONNECTOR_FAN_OUT_LENGTH,
  CONNECTOR_MIN_SEPARATION,
  CONNECTOR_SAMPLE_STEP,
} from '../src/map/canvas/edges/connectorBounds';

import { distanceToPolyline, type Point as ConnectorPoint } from '../src/map/canvas/edges/connectorRouting';

interface Box {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface DrawnPath {
  points: ConnectorPoint[];
  badge: ConnectorPoint | null;
}

interface DrawnConnector {
  id: string;
  source: string;
  target: string;
  paths: DrawnPath[];
}

interface Scene {
  boxes: Box[];
  connectors: DrawnConnector[];
}

const readScene = (step: number): Scene => {
  const boxes = [...document.querySelectorAll<HTMLElement>('.react-flow__node')].map((element) => {
    const origin = /translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)/.exec(element.style.transform);
    return {
      id: element.dataset.id ?? '',
      x: Number(origin?.[1]),
      y: Number(origin?.[2]),
      width: element.offsetWidth,
      height: element.offsetHeight,
    };
  });
  const connectors = [...document.querySelectorAll<SVGGElement>('[data-connector]')].map((group) => ({
    id: group.dataset.connector ?? '',
    source: group.dataset.source ?? '',
    target: group.dataset.target ?? '',
    paths: [...group.querySelectorAll<SVGGElement>('[data-path]')].map((pathGroup) => {
      const path = pathGroup.querySelector<SVGPathElement>('path');
      const points: { x: number; y: number }[] = [];
      if (path !== null) {
        const length = path.getTotalLength();
        const count = Math.max(2, Math.ceil(length / step));
        for (let i = 0; i <= count; i += 1) {
          const point = path.getPointAtLength((length * i) / count);
          points.push({ x: point.x, y: point.y });
        }
      }
      const badge = pathGroup.querySelector<SVGGElement>('[data-badge]');
      const at = /translate\((-?[\d.]+)\s+(-?[\d.]+)\)/.exec(badge?.getAttribute('transform') ?? '');
      return { points, badge: at === null ? null : { x: Number(at[1]), y: Number(at[2]) } };
    }),
  }));
  return { boxes, connectors };
};

const arcLengths = (points: readonly ConnectorPoint[]): number[] => {
  const lengths = [0];
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1] as ConnectorPoint;
    const b = points[i] as ConnectorPoint;
    lengths.push((lengths[i - 1] as number) + Math.hypot(b.x - a.x, b.y - a.y));
  }
  return lengths;
};

const beyondFanOut = (points: readonly ConnectorPoint[]): ConnectorPoint[] => {
  const lengths = arcLengths(points);
  return points.filter((_, i) => (lengths[i] as number) >= CONNECTOR_FAN_OUT_LENGTH);
};

export interface Measurement {
  minSeparation: number;
  worstPair: string;
  wideFanMinSeparation: number;
  wideFans: number;
  throughNode: string[];
  badgeOverNode: string[];
  connectors: number;
  widestFan: number;
}

const pathsOf = (connectors: readonly DrawnConnector[]): DrawnPath[] =>
  connectors.flatMap((connector) => connector.paths);

export function measure(scene: Scene): Measurement {
  const bySource = new Map<string, DrawnConnector[]>();
  scene.connectors.forEach((connector) => {
    bySource.set(connector.source, [...(bySource.get(connector.source) ?? []), connector]);
  });
  let minSeparation = Infinity;
  let worstPair = '';
  let wideFanMinSeparation = Infinity;
  let wideFans = 0;
  let widestFan = 0;
  bySource.forEach((siblings) => {
    const drawn = pathsOf(siblings);
    widestFan = Math.max(widestFan, drawn.length);
    const wide = drawn.length > CONNECTOR_ASSERTED_FAN;
    wideFans += wide ? 1 : 0;
    for (let i = 0; i < drawn.length; i += 1) {
      for (let j = i + 1; j < drawn.length; j += 1) {
        const a = beyondFanOut((drawn[i] as DrawnPath).points);
        const b = beyondFanOut((drawn[j] as DrawnPath).points);
        for (const point of a) {
          const distance = distanceToPolyline(point, b);
          if (wide) {
            wideFanMinSeparation = Math.min(wideFanMinSeparation, distance);
          } else if (distance < minSeparation) {
            minSeparation = distance;
            worstPair = `${siblings[0]?.source ?? ''}:${String(i)}/${String(j)}`;
          }
        }
      }
    }
  });
  const throughNode: string[] = [];
  const badgeOverNode: string[] = [];
  scene.connectors.forEach((connector) => {
    connector.paths.forEach((path) => {
      for (const box of scene.boxes) {
        if (box.id === connector.source || box.id === connector.target) {
          continue;
        }
        const crossed = path.points.some(
          (p) =>
            p.x > box.x + 0.5 && p.x < box.x + box.width - 0.5 && p.y > box.y + 0.5 && p.y < box.y + box.height - 0.5,
        );
        if (crossed) {
          throughNode.push(`${connector.id}->${box.id}`);
        }
      }
      if (path.badge !== null) {
        const badge = path.badge;
        for (const box of scene.boxes) {
          const overlaps =
            badge.x + BADGE_WIDTH / 2 > box.x &&
            badge.x - BADGE_WIDTH / 2 < box.x + box.width &&
            badge.y + BADGE_HEIGHT / 2 > box.y &&
            badge.y - BADGE_HEIGHT / 2 < box.y + box.height;
          if (overlaps) {
            badgeOverNode.push(`${connector.id}@${box.id}`);
          }
        }
      }
    });
  });
  return {
    minSeparation,
    worstPair,
    wideFanMinSeparation,
    wideFans,
    throughNode,
    badgeOverNode,
    connectors: scene.connectors.length,
    widestFan,
  };
}

const load = async (page: Page, query: string): Promise<Scene> => {
  await page.goto(`/e2e/host/canvas.html?${query}`);
  await page.waitForFunction(() => (window as unknown as { __canvas: CanvasHostState }).__canvas.done);
  return page.evaluate(readScene, CONNECTOR_SAMPLE_STEP);
};

const MODES = ['top-down', 'left-to-right'] as const;
const SEEDS = [7, 8] as const;

test.describe('connector rules C3, C4 and C7 on the rendered page', () => {
  for (const size of [50, 150]) {
    for (const seed of SEEDS) {
      for (const mode of MODES) {
        test(`${mode} ${String(size)} nodes seed ${String(seed)}: siblings apart, no connector through a node, no badge over a node`, async ({
          page,
        }, testInfo) => {
          const scene = await load(page, `mode=${mode}&size=${String(size)}&seed=${String(seed)}`);
          const result = measure(scene);
          console.info(`connector-measure ${mode} ${String(size)} seed ${String(seed)} ${JSON.stringify(result)}`);
          testInfo.annotations.push({ type: 'measurement', description: JSON.stringify(result) });
          expect(result.connectors).toBeGreaterThanOrEqual(size - 1);
          expect(result.throughNode).toEqual([]);
          expect(result.badgeOverNode).toEqual([]);
          expect(result.minSeparation, `worst pair ${result.worstPair}`).toBeGreaterThanOrEqual(
            CONNECTOR_MIN_SEPARATION,
          );
        });
      }
    }
  }
});

test.describe('connector measurements at 250 and 500 nodes', () => {
  for (const size of [250, 500]) {
    for (const mode of MODES) {
      test(`${mode} ${String(size)} nodes seed 7: measured and recorded`, async ({ page }, testInfo) => {
        const scene = await load(page, `mode=${mode}&size=${String(size)}&seed=7`);
        const result = measure(scene);
        console.info(`connector-measure ${mode} ${String(size)} ${JSON.stringify(result)}`);
        testInfo.annotations.push({ type: 'measurement', description: JSON.stringify(result) });
        expect(result.connectors).toBeGreaterThanOrEqual(size - 1);
      });
    }
  }
});

test.describe('legend fixture', () => {
  for (const mode of MODES) {
    test(`${mode}: every mass, age and size value is drawn and the parallel pair is separate`, async ({
      page,
    }, testInfo) => {
      const scene = await load(page, `mode=${mode}&fixture=legend`);
      const result = measure(scene);
      expect(result.throughNode).toEqual([]);
      expect(result.badgeOverNode).toEqual([]);
      const drawn = await page.evaluate(() => ({
        colours: [
          ...new Set([...document.querySelectorAll('[data-connector] path')].map((p) => p.getAttribute('data-colour'))),
        ],
        dashes: [
          ...new Set([...document.querySelectorAll('[data-connector] path')].map((p) => p.getAttribute('data-dash'))),
        ],
        badges: [
          ...new Set([...document.querySelectorAll('[data-badge]')].map((b) => b.getAttribute('data-badge'))),
        ].sort(),
      }));
      expect(drawn.colours).toHaveLength(3);
      expect(drawn.dashes).toHaveLength(3);
      expect(drawn.badges).toEqual(['C', 'F', 'M', 'S']);
      const parallel = scene.connectors.find((connector) => connector.paths.length === 2);
      expect(parallel).toBeDefined();
      const [first, second] = parallel?.paths ?? [];
      const mid = (path: DrawnPath | undefined): ConnectorPoint =>
        path?.points[Math.floor((path.points.length - 1) / 2)] as ConnectorPoint;
      const gap = Math.hypot(mid(first).x - mid(second).x, mid(first).y - mid(second).y);
      expect(gap).toBeGreaterThanOrEqual(8);
      await testInfo.attach(`connectors-legend-${mode}`, { body: await page.screenshot(), contentType: 'image/png' });
    });
  }
});
