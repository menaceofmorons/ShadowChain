import { expect, test, type Page } from '@playwright/test';
import { LAYOUT_MODES, type LayoutMode } from '../src/map/layout/types';
import { buildChainTree } from '../src/map/model/chainTree';
import type { ChainNode } from '../src/map/model/types';
import { generateChain, SYNTHETIC_ROOT_SYSTEM_ID } from '../src/map/synthetic';
import type { HostPlacement } from './host/canvas';

const SIZES = [50, 150] as const;
const SEED = 7;
const DRAG_PX = 40;
const TOLERANCE = 1.5;
const SCREEN_SLACK_PX = 8;
const OVERLAP_EPSILON = 0.01;
const DROP_MARGIN_PX = 6;
const SESSION_TIMEOUT_MS = 180_000;

interface Point {
  x: number;
  y: number;
}

interface StoreState {
  manual: { key: string; x: number | null; y: number | null }[];
  collapsed: string[];
  rootOffset: number;
}

const hostUrl = (query: string): string => `/e2e/host/canvas.html?${query}`;

async function open(page: Page, query: string): Promise<void> {
  await page.goto(hostUrl(query));
  await page.waitForFunction(() => window.__canvas.done);
  expect(await page.evaluate(() => window.__canvas.error)).toBeNull();
}

const placedByKey = async (page: Page): Promise<Map<string, HostPlacement>> =>
  new Map((await page.evaluate(() => window.__canvas.placed)).map((p) => [p.key, p]));

const batchCount = (page: Page): Promise<number> => page.evaluate(() => window.__canvas.batches.length);

const drawnIds = (page: Page): Promise<string[]> =>
  page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('.react-flow__node')].map((element) => element.dataset.id ?? '').sort(),
  );

const nextFrames = (page: Page): Promise<void> =>
  page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            resolve();
          });
        });
      }),
  );

async function settle(page: Page): Promise<void> {
  await page.waitForFunction(
    () => document.querySelectorAll('.react-flow__node').length === window.__canvas.placed.length,
  );
  await nextFrames(page);
}

const sceneVersion = (page: Page): Promise<number> => page.evaluate(() => window.__canvas.sceneVersion);

const afterScene = async (page: Page, before: number): Promise<void> => {
  await page.waitForFunction((version) => window.__canvas.sceneVersion > version, before);
  await settle(page);
};

async function overlappingPairs(page: Page): Promise<string[]> {
  return await page.evaluate((epsilon) => {
    const boxes = [...document.querySelectorAll<HTMLElement>('.react-flow__node')].map((element) => ({
      id: element.dataset.id ?? '',
      rect: element.getBoundingClientRect(),
    }));
    const pairs: string[] = [];
    for (let i = 0; i < boxes.length; i += 1) {
      for (let j = i + 1; j < boxes.length; j += 1) {
        const a = (boxes[i] as (typeof boxes)[number]).rect;
        const b = (boxes[j] as (typeof boxes)[number]).rect;
        if (
          a.x < b.right - epsilon &&
          b.x < a.right - epsilon &&
          a.y < b.bottom - epsilon &&
          b.y < a.bottom - epsilon
        ) {
          pairs.push(`${(boxes[i] as (typeof boxes)[number]).id}|${(boxes[j] as (typeof boxes)[number]).id}`);
        }
      }
    }
    return pairs;
  }, OVERLAP_EPSILON);
}

async function storeState(page: Page): Promise<StoreState> {
  return await page.evaluate(() => {
    const snapshot = window.__canvasOps.storeSnapshot();
    return {
      manual: snapshot.rows
        .filter((row) => row.source === 'manual')
        .map((row) => ({ key: row.nodeKey, x: row.x, y: row.y }))
        .sort((a, b) => (a.key < b.key ? -1 : 1)),
      collapsed: snapshot.rows
        .filter((row) => row.collapsed)
        .map((row) => row.nodeKey)
        .sort(),
      rootOffset: snapshot.tab.rootOffset,
    };
  });
}

async function expectStore(
  page: Page,
  expected: { manual: readonly string[]; collapsed: readonly string[]; rootOffset?: number },
): Promise<void> {
  const state = await storeState(page);
  expect(state.manual.map((row) => row.key)).toEqual([...expected.manual].sort());
  expect(state.collapsed).toEqual([...expected.collapsed].sort());
  if (expected.rootOffset !== undefined) {
    expect(state.rootOffset).toBe(expected.rootOffset);
  }
  const placed = await placedByKey(page);
  for (const row of state.manual) {
    const drawn = placed.get(row.key) as HostPlacement;
    expect(drawn.source, row.key).toBe('manual');
    expect(Math.abs((row.x ?? NaN) - drawn.x), `${row.key} x`).toBeLessThan(0.01);
    expect(Math.abs((row.y ?? NaN) - drawn.y), `${row.key} y`).toBeLessThan(0.01);
  }
  expect([...placed.values()].filter((p) => p.source === 'manual').map((p) => p.key)).toEqual(
    state.manual.map((row) => row.key),
  );
}

async function nodeCentre(page: Page, id: string): Promise<Point> {
  return await page.evaluate((key) => {
    const element = document.querySelector(`.react-flow__node[data-id="${key}"]`);
    if (element === null) {
      throw new Error(`no drawn node ${key}`);
    }
    const rect = element.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  }, id);
}

async function viewportScale(page: Page): Promise<number> {
  return await page.evaluate(() => {
    const transform = document.querySelector<HTMLElement>('.react-flow__viewport')?.style.transform ?? '';
    return Number(/scale\(([\d.]+)\)/.exec(transform)?.[1] ?? 1);
  });
}

async function mostCentral(page: Page, ids: readonly string[]): Promise<string> {
  return await page.evaluate((keys) => {
    const pane = document.querySelector('.react-flow')?.getBoundingClientRect() as DOMRect;
    const cx = pane.x + pane.width / 2;
    const cy = pane.y + pane.height / 2;
    const ranked = keys
      .flatMap((key) => {
        const element = document.querySelector(`.react-flow__node[data-id="${key}"]`);
        if (element === null) {
          return [];
        }
        const rect = element.getBoundingClientRect();
        return [{ key, distance: Math.hypot(rect.x + rect.width / 2 - cx, rect.y + rect.height / 2 - cy) }];
      })
      .sort((a, b) => a.distance - b.distance);
    if (ranked[0] === undefined) {
      throw new Error('no drawn candidate');
    }
    return ranked[0].key;
  }, ids as string[]);
}

async function dragFrom(page: Page, from: Point, by: Point): Promise<void> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + by.x / 2, from.y + by.y / 2, { steps: 5 });
  await page.mouse.move(from.x + by.x, from.y + by.y, { steps: 5 });
  await page.mouse.up();
}

async function freeDirection(page: Page, id: string): Promise<Point> {
  return await page.evaluate(
    ({ key, length, margin }) => {
      const pane = document.querySelector('.react-flow')?.getBoundingClientRect() as DOMRect;
      const own = (
        document.querySelector(`.react-flow__node[data-id="${key}"]`) as HTMLElement
      ).getBoundingClientRect();
      const others = [...document.querySelectorAll<HTMLElement>('.react-flow__node')]
        .filter((element) => element.dataset.id !== key)
        .map((element) => element.getBoundingClientRect());
      const toCentre = { x: pane.x + pane.width / 2 - own.x, y: pane.y + pane.height / 2 - own.y };
      const candidates = [0, 1, 2, 3, 4, 5, 6, 7].map((step) => {
        const angle = (step * Math.PI) / 4;
        const dx = Math.cos(angle) * length;
        const dy = Math.sin(angle) * length;
        return { dx, dy, score: dx * toCentre.x + dy * toCentre.y };
      });
      candidates.sort((a, b) => b.score - a.score);
      const free = candidates.find(({ dx, dy }) => {
        const x = own.x + dx;
        const y = own.y + dy;
        const inside =
          x > pane.x + 40 && y > pane.y + 40 && x + own.width < pane.right - 40 && y + own.height < pane.bottom - 40;
        return (
          inside &&
          others.every(
            (r) =>
              !(
                x < r.right + margin &&
                r.x < x + own.width + margin &&
                y < r.bottom + margin &&
                r.y < y + own.height + margin
              ),
          )
        );
      });
      if (free === undefined) {
        throw new Error(`no free drop for ${key}`);
      }
      return { x: free.dx, y: free.dy };
    },
    { key: id, length: DRAG_PX, margin: DROP_MARGIN_PX },
  );
}

async function realDrag(page: Page, id: string): Promise<void> {
  const version = await sceneVersion(page);
  const from = await nodeCentre(page, id);
  const by = await freeDirection(page, id);
  const before = (await placedByKey(page)).get(id) as HostPlacement;
  const scale = await viewportScale(page);
  await dragFrom(page, from, by);
  await afterScene(page, version);
  const after = (await placedByKey(page)).get(id) as HostPlacement;
  expect(Math.hypot(after.x - before.x, after.y - before.y), `${id} moved`).toBeGreaterThan(0);
  expect(Math.abs(after.x - before.x - by.x / scale) * scale, `${id} x`).toBeLessThan(SCREEN_SLACK_PX);
  expect(Math.abs(after.y - before.y - by.y / scale) * scale, `${id} y`).toBeLessThan(SCREEN_SLACK_PX);
}

async function menuChoice(page: Page, id: string, item: 'collapse' | 'expand' | 'reset'): Promise<void> {
  const version = await sceneVersion(page);
  const at = await nodeCentre(page, id);
  await page.mouse.click(at.x, at.y, { button: 'right' });
  await page.locator(`[data-menu-item="${item}"]`).click();
  await afterScene(page, version);
}

const descendantsOf = (node: ChainNode): ChainNode[] =>
  node.children.flatMap((child) => [child, ...descendantsOf(child)]);

const allNodes = (root: ChainNode): ChainNode[] => [root, ...descendantsOf(root)];

const pathTo = (root: ChainNode, target: ChainNode): ChainNode[] => {
  if (root === target) {
    return [root];
  }
  for (const child of root.children) {
    const path = pathTo(child, target);
    if (path.length > 0) {
      return [root, ...path];
    }
  }
  return [];
};

const sorted = (keys: Iterable<string>): string[] => [...keys].sort();

async function expectNoOverlap(page: Page, step: string): Promise<void> {
  expect(await overlappingPairs(page), `${step}: overlapping drawn nodes`).toEqual([]);
}

for (const nodeCount of SIZES) {
  for (const mode of LAYOUT_MODES) {
    test(`terminal session, ${mode}, ${String(nodeCount)} nodes: open, add, remove, drag, collapse, expand, Reset, Tidy`, async ({
      page,
    }) => {
      test.setTimeout(SESSION_TIMEOUT_MS);
      const treeMode = (m: LayoutMode): boolean => m !== 'radial';
      const root = buildChainTree(generateChain({ nodeCount, seed: SEED }), SYNTHETIC_ROOT_SYSTEM_ID).root;
      const everyKey = allNodes(root).map((node) => node.keyString);
      const primaries = allNodes(root).filter((node) => node !== root && node.kind === 'primary');
      const parents = primaries.filter((node) => node.children.length > 0);
      let batchesBefore = 0;

      const expectBatches = async (step: string, written: boolean): Promise<void> => {
        await page.getByTestId('flush').click();
        const now = await batchCount(page);
        expect(now - batchesBefore, `${step}: batches written`).toBe(written ? 1 : 0);
        batchesBefore = now;
      };

      await test.step('open', async () => {
        await open(page, `mode=${mode}&size=${String(nodeCount)}&seed=${String(SEED)}`);
        await settle(page);
        expect(await drawnIds(page)).toEqual(sorted(everyKey));
        await expectNoOverlap(page, 'open');
        await expectStore(page, { manual: [], collapsed: [], rootOffset: 0 });
        await expectBatches('open', false);
      });

      const collapseKey = await mostCentral(
        page,
        parents.map((node) => node.keyString),
      );
      const collapseTarget = parents.find((node) => node.keyString === collapseKey) as ChainNode;
      const hiddenByCollapse = new Set(descendantsOf(collapseTarget).map((node) => node.keyString));
      const onCollapsePath = new Set(pathTo(root, collapseTarget).map((node) => node.keyString));
      const dragKey = await mostCentral(
        page,
        primaries
          .filter(
            (node) =>
              node.children.length === 0 &&
              !hiddenByCollapse.has(node.keyString) &&
              !onCollapsePath.has(node.keyString),
          )
          .map((node) => node.keyString),
      );
      const marker = `+:${collapseKey}`;
      const visibleWhenCollapsed = sorted([...everyKey.filter((key) => !hiddenByCollapse.has(key)), marker]);
      const atStart = await placedByKey(page);

      let addedKey = '';
      await test.step('add', async () => {
        const version = await sceneVersion(page);
        await page.evaluate(() => window.__canvasOps.addLeaf());
        await afterScene(page, version);
        const placed = await placedByKey(page);
        const added = [...placed.keys()].filter((key) => !atStart.has(key));
        expect(added).toHaveLength(1);
        addedKey = added[0] as string;
        expect(await drawnIds(page)).toEqual(sorted(placed.keys()));
        await expectNoOverlap(page, 'add');
        if (treeMode(mode)) {
          for (const [key, start] of atStart) {
            expect(placed.get(key), `${key} stays`).toEqual(start);
          }
        }
        await expectStore(page, { manual: [], collapsed: [], rootOffset: 0 });
        await expectBatches('add', false);
      });

      await test.step('remove', async () => {
        const version = await sceneVersion(page);
        await page.evaluate(() => window.__canvasOps.removeLast());
        await afterScene(page, version);
        const placed = await placedByKey(page);
        expect(placed.has(addedKey)).toBe(false);
        expect(await drawnIds(page)).toEqual(sorted(everyKey));
        await expectNoOverlap(page, 'remove');
        if (treeMode(mode)) {
          for (const [key, start] of atStart) {
            expect(placed.get(key), `${key} stays`).toEqual(start);
          }
        }
        await expectStore(page, { manual: [], collapsed: [], rootOffset: 0 });
        await expectBatches('remove', false);
      });

      const beforeDrag = await placedByKey(page);

      await test.step('drag', async () => {
        await realDrag(page, dragKey);
        await expectNoOverlap(page, 'drag');
        expect(await drawnIds(page)).toEqual(sorted(everyKey));
        await expectStore(page, { manual: [dragKey], collapsed: [], rootOffset: 0 });
        await expectBatches('drag', true);
        const [batch] = await page.evaluate(() => window.__canvas.batches.slice(-1));
        expect(batch?.positions.map((row) => row.nodeKey)).toEqual([dragKey]);
      });

      await test.step('collapse', async () => {
        await menuChoice(page, collapseKey, 'collapse');
        expect(await drawnIds(page)).toEqual(visibleWhenCollapsed);
        await expectNoOverlap(page, 'collapse');
        await expectStore(page, { manual: [dragKey], collapsed: [collapseKey], rootOffset: 0 });
        await expectBatches('collapse', true);
      });

      await test.step('expand', async () => {
        const version = await sceneVersion(page);
        const at = await nodeCentre(page, marker);
        await page.mouse.click(at.x, at.y);
        await afterScene(page, version);
        expect(await drawnIds(page)).toEqual(sorted(everyKey));
        await expectNoOverlap(page, 'expand');
        await expectStore(page, { manual: [dragKey], collapsed: [], rootOffset: 0 });
        await expectBatches('expand', true);
      });

      await test.step('reset position', async () => {
        await menuChoice(page, dragKey, 'reset');
        await expectNoOverlap(page, 'reset');
        await expectStore(page, { manual: [], collapsed: [], rootOffset: 0 });
        const placed = await placedByKey(page);
        const original = beforeDrag.get(dragKey) as HostPlacement;
        const restored = placed.get(dragKey) as HostPlacement;
        expect(restored.source).toBe('auto');
        if (treeMode(mode)) {
          expect(Math.abs(restored.x - original.x)).toBeLessThan(TOLERANCE);
          expect(Math.abs(restored.y - original.y)).toBeLessThan(TOLERANCE);
        }
        await expectBatches('reset', true);
      });

      let offset = 0;
      await test.step('root drag', async () => {
        if (!treeMode(mode)) {
          const before = await placedByKey(page);
          const from = await nodeCentre(page, root.keyString);
          await dragFrom(page, from, { x: DRAG_PX, y: DRAG_PX });
          await nextFrames(page);
          expect(await placedByKey(page)).toEqual(before);
          await expectStore(page, { manual: [], collapsed: [], rootOffset: 0 });
          await expectBatches('root drag', false);
          return;
        }
        const version = await sceneVersion(page);
        const from = await nodeCentre(page, root.keyString);
        await dragFrom(page, from, { x: DRAG_PX, y: DRAG_PX });
        await afterScene(page, version);
        offset = (await storeState(page)).rootOffset;
        expect(offset).not.toBe(0);
        await expectNoOverlap(page, 'root drag');
        await expectStore(page, { manual: [], collapsed: [], rootOffset: offset });
        await expectBatches('root drag', true);
      });

      await test.step('drag and collapse again, then Tidy', async () => {
        await realDrag(page, dragKey);
        await expectBatches('drag again', true);
        await menuChoice(page, collapseKey, 'collapse');
        await expectNoOverlap(page, 'drag and collapse');
        await expectStore(page, { manual: [dragKey], collapsed: [collapseKey], rootOffset: offset });
        await expectBatches('collapse again', true);

        const version = await sceneVersion(page);
        await page.getByTestId('tidy').click();
        await afterScene(page, version);
        expect(await drawnIds(page)).toEqual(visibleWhenCollapsed);
        await expectNoOverlap(page, 'tidy');
        await expectStore(page, { manual: [], collapsed: [collapseKey], rootOffset: offset });
        await expectBatches('tidy', true);
      });

      await test.step('expand from the +N menu', async () => {
        await menuChoice(page, marker, 'expand');
        expect(await drawnIds(page)).toEqual(sorted(everyKey));
        await expectNoOverlap(page, 'expand from menu');
        await expectStore(page, { manual: [], collapsed: [], rootOffset: offset });
        await expectBatches('expand from menu', true);
      });
    });
  }
}
