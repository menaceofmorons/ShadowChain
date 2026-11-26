import { expect, test, type Page } from '@playwright/test';
import { wanderer98 } from '../src/map/fixtures/wanderer';
import { LAYOUT_MODES, type LayoutMode } from '../src/map/layout/types';
import { buildChainTree } from '../src/map/model/chainTree';
import type { ChainNode } from '../src/map/model/types';
import { generateChain, SYNTHETIC_ROOT_SYSTEM_ID } from '../src/map/synthetic';
import type { HostPlacement } from './host/canvas';

const SIZES = [50, 150] as const;
const SEED = 7;
const DRAG_PX = 40;
const TOLERANCE = 1.5;
const GROUP_SIZE = 3;
const KEY_SETTLE_MS = 100;

interface Point {
  x: number;
  y: number;
}

const hostUrl = (query: string): string => `/e2e/host/canvas.html?${query}`;

async function open(page: Page, query: string): Promise<void> {
  await page.goto(hostUrl(query));
  await page.waitForFunction(() => window.__canvas.done);
  expect(await page.evaluate(() => window.__canvas.error)).toBeNull();
}

const sceneVersion = (page: Page): Promise<number> => page.evaluate(() => window.__canvas.sceneVersion);

const afterScene = async (page: Page, before: number): Promise<void> => {
  await page.waitForFunction((version) => window.__canvas.sceneVersion > version, before);
};

const placedByKey = async (page: Page): Promise<Map<string, HostPlacement>> =>
  new Map((await page.evaluate(() => window.__canvas.placed)).map((p) => [p.key, p]));

const batches = (page: Page) => page.evaluate(() => window.__canvas.batches);

const gestures = (page: Page) => page.evaluate(() => window.__canvas.gestures);

const rootOffset = (page: Page): Promise<number> => page.evaluate(() => window.__canvas.rootOffset);

const treeRoot = (nodeCount: number): ChainNode =>
  buildChainTree(generateChain({ nodeCount, seed: SEED }), SYNTHETIC_ROOT_SYSTEM_ID).root;

const descendantsOf = (node: ChainNode): ChainNode[] =>
  node.children.flatMap((child) => [child, ...descendantsOf(child)]);

const allNodes = (root: ChainNode): ChainNode[] => [root, ...descendantsOf(root)];

const withChildren = (root: ChainNode): ChainNode[] =>
  allNodes(root).filter((node) => node !== root && node.kind === 'primary' && node.children.length > 0);

const plainPrimaries = (root: ChainNode): ChainNode[] =>
  allNodes(root).filter((node) => node !== root && node.kind === 'primary');

async function viewportScale(page: Page): Promise<number> {
  return await page.evaluate(() => {
    const transform = document.querySelector<HTMLElement>('.react-flow__viewport')?.style.transform ?? '';
    return Number(/scale\(([\d.]+)\)/.exec(transform)?.[1] ?? 1);
  });
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

async function flowOrigin(page: Page, id: string): Promise<string> {
  return await page.evaluate(
    (key) => document.querySelector<HTMLElement>(`.react-flow__node[data-id="${key}"]`)?.style.transform ?? '',
    id,
  );
}

async function mostCentral(page: Page, ids: readonly string[], count: number): Promise<string[]> {
  return await page.evaluate(
    ({ keys, wanted }) => {
      const pane = document.querySelector('.react-flow')?.getBoundingClientRect() as DOMRect;
      const cx = pane.x + pane.width / 2;
      const cy = pane.y + pane.height / 2;
      return keys
        .flatMap((key) => {
          const element = document.querySelector(`.react-flow__node[data-id="${key}"]`);
          if (element === null) {
            return [];
          }
          const rect = element.getBoundingClientRect();
          return [{ key, distance: Math.hypot(rect.x + rect.width / 2 - cx, rect.y + rect.height / 2 - cy) }];
        })
        .sort((a, b) => a.distance - b.distance)
        .slice(0, wanted)
        .map((entry) => entry.key);
    },
    { keys: [...ids], wanted: count },
  );
}

async function towardCentre(page: Page, from: Point): Promise<Point> {
  return await page.evaluate(
    ({ x, y, length }) => {
      const pane = document.querySelector('.react-flow')?.getBoundingClientRect() as DOMRect;
      const dx = pane.x + pane.width / 2 - x;
      const dy = pane.y + pane.height / 2 - y;
      const norm = Math.hypot(dx, dy);
      return norm < 1 ? { x: length, y: 0 } : { x: (dx / norm) * length, y: (dy / norm) * length };
    },
    { ...from, length: DRAG_PX },
  );
}

async function dragFrom(page: Page, from: Point, by: Point): Promise<void> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + by.x / 2, from.y + by.y / 2, { steps: 5 });
  await page.mouse.move(from.x + by.x, from.y + by.y, { steps: 5 });
  await page.mouse.up();
}

async function dragNode(page: Page, id: string, modifier?: 'Alt'): Promise<Point> {
  const from = await nodeCentre(page, id);
  const by = await towardCentre(page, from);
  if (modifier !== undefined) {
    await page.keyboard.down(modifier);
  }
  await dragFrom(page, from, by);
  if (modifier !== undefined) {
    await page.keyboard.up(modifier);
  }
  return by;
}

async function clickWith(page: Page, id: string, key?: 'Control' | 'Meta'): Promise<void> {
  const at = await nodeCentre(page, id);
  if (key !== undefined) {
    await page.keyboard.down(key);
    await page.waitForTimeout(KEY_SETTLE_MS);
  }
  await page.mouse.click(at.x, at.y);
  if (key !== undefined) {
    await page.keyboard.up(key);
  }
}

const selectedIds = (page: Page): Promise<string[]> =>
  page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('.react-flow__node')]
      .filter((element) => element.querySelector('[data-selected="true"]') !== null)
      .map((element) => element.dataset.id ?? '')
      .sort(),
  );

const sameDelta = (
  before: Map<string, HostPlacement>,
  after: Map<string, HostPlacement>,
  keys: readonly string[],
  delta: Point,
): void => {
  for (const key of keys) {
    const a = before.get(key) as HostPlacement;
    const b = after.get(key) as HostPlacement;
    expect(Math.abs(b.x - a.x - delta.x), `${key} x`).toBeLessThan(TOLERANCE);
    expect(Math.abs(b.y - a.y - delta.y), `${key} y`).toBeLessThan(TOLERANCE);
  }
};

const SCREEN_SLACK_PX = 8;

const realDelta = (
  before: Map<string, HostPlacement>,
  after: Map<string, HostPlacement>,
  key: string,
  by: Point,
  scale: number,
): Point => {
  const a = before.get(key) as HostPlacement;
  const b = after.get(key) as HostPlacement;
  const delta = { x: b.x - a.x, y: b.y - a.y };
  expect(Math.abs(delta.x - by.x / scale) * scale, `${key} x`).toBeLessThan(SCREEN_SLACK_PX);
  expect(Math.abs(delta.y - by.y / scale) * scale, `${key} y`).toBeLessThan(SCREEN_SLACK_PX);
  expect(Math.hypot(delta.x, delta.y)).toBeGreaterThan(0);
  return delta;
};

const manualKeys = (placed: Map<string, HostPlacement>): string[] =>
  [...placed.values()]
    .filter((p) => p.source === 'manual')
    .map((p) => p.key)
    .sort();

async function expectOneBatch(page: Page, rows: readonly string[]): Promise<void> {
  await expect.poll(async () => (await batches(page)).length).toBe(1);
  const [batch] = await batches(page);
  expect((batch?.positions ?? []).map((row) => row.nodeKey).sort()).toEqual([...rows].sort());
  expect((batch?.positions ?? []).every((row) => row.source === 'manual')).toBe(true);
}

for (const nodeCount of SIZES) {
  for (const mode of LAYOUT_MODES) {
    test.describe(`${mode}, ${String(nodeCount)} nodes`, () => {
      const query = `mode=${mode}&size=${String(nodeCount)}&seed=${String(SEED)}`;
      const root = treeRoot(nodeCount);

      test('plain drag: only the dragged node becomes manual, in one batch, and its subtree follows', async ({
        page,
      }) => {
        await open(page, query);
        const target = (
          await mostCentral(
            page,
            withChildren(root).map((n) => n.keyString),
            1,
          )
        )[0] as string;
        const node = withChildren(root).find((n) => n.keyString === target) as ChainNode;
        const before = await placedByKey(page);
        const version = await sceneVersion(page);
        const by = await dragNode(page, target);
        await afterScene(page, version);
        const scale = await viewportScale(page);
        const after = await placedByKey(page);
        expect(manualKeys(after)).toEqual([target]);
        const delta = realDelta(before, after, target, by, scale);
        if (mode !== 'radial') {
          sameDelta(
            before,
            after,
            descendantsOf(node).map((d) => d.keyString),
            delta,
          );
        }
        expect(await gestures(page)).toEqual(['drag-node']);
        await expectOneBatch(page, [target]);
      });

      test('Alt drag: the node moves alone; it and its direct children become manual', async ({ page }) => {
        await open(page, query);
        const target = (
          await mostCentral(
            page,
            withChildren(root).map((n) => n.keyString),
            1,
          )
        )[0] as string;
        const node = withChildren(root).find((n) => n.keyString === target) as ChainNode;
        const children = node.children.filter((child) => child.kind !== 'collapsed').map((c) => c.keyString);
        const before = await placedByKey(page);
        const version = await sceneVersion(page);
        const by = await dragNode(page, target, 'Alt');
        await afterScene(page, version);
        const scale = await viewportScale(page);
        const after = await placedByKey(page);
        expect(manualKeys(after)).toEqual([target, ...children].sort());
        realDelta(before, after, target, by, scale);
        sameDelta(before, after, children, { x: 0, y: 0 });
        expect(await gestures(page)).toEqual(['drag-node-alone']);
        await expectOneBatch(page, [target, ...children]);
      });

      test('Shift rubber band selects exactly the nodes it touches and moves nothing', async ({ page }) => {
        await open(page, query);
        const pane = await page.evaluate(() => {
          const rect = document.querySelector('.react-flow')?.getBoundingClientRect() as DOMRect;
          return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
        });
        const from = { x: pane.x + 3, y: pane.y + 3 };
        const to = { x: pane.x + pane.width / 2, y: pane.y + pane.height / 2 };
        await page.keyboard.down('Shift');
        await page.mouse.move(from.x, from.y);
        await page.mouse.down();
        await page.mouse.move(to.x / 2, to.y / 2, { steps: 5 });
        await page.mouse.move(to.x, to.y, { steps: 5 });
        await page.waitForTimeout(KEY_SETTLE_MS);
        await page.mouse.up();
        await page.keyboard.up('Shift');
        const expected = await page.evaluate(
          ({ a, b }) =>
            [...document.querySelectorAll<HTMLElement>('.react-flow__node')]
              .filter((element) => {
                const r = element.getBoundingClientRect();
                return r.x < b.x && r.right > a.x && r.y < b.y && r.bottom > a.y;
              })
              .map((element) => element.dataset.id ?? '')
              .sort(),
          { a: from, b: to },
        );
        expect(expected.length).toBeGreaterThan(0);
        expect(await selectedIds(page)).toEqual(expected);
        expect(await gestures(page)).toEqual([]);
        expect(manualKeys(await placedByKey(page))).toEqual([]);
      });

      test('Ctrl and Cmd click toggle selection; a group drag is one gesture and one batch', async ({ page }) => {
        await open(page, query);
        const group = await mostCentral(
          page,
          plainPrimaries(root).map((n) => n.keyString),
          GROUP_SIZE,
        );
        await clickWith(page, group[0] as string);
        await clickWith(page, group[1] as string, 'Control');
        await clickWith(page, group[2] as string, 'Meta');
        expect(await selectedIds(page)).toEqual([...group].sort());
        await clickWith(page, group[2] as string, 'Control');
        expect(await selectedIds(page)).toEqual([group[0], group[1]].sort());
        await clickWith(page, group[2] as string, 'Control');
        expect(await selectedIds(page)).toEqual([...group].sort());

        const before = await placedByKey(page);
        const version = await sceneVersion(page);
        const by = await dragNode(page, group[0] as string);
        await afterScene(page, version);
        const scale = await viewportScale(page);
        const after = await placedByKey(page);
        expect(manualKeys(after)).toEqual([...group].sort());
        sameDelta(before, after, group, realDelta(before, after, group[0] as string, by, scale));
        expect(await gestures(page)).toEqual(['drag-group']);
        await expectOneBatch(page, group);
      });

      test('context menu: Collapse, click +N to expand, Reset position', async ({ page }) => {
        await open(page, query);
        const [target, other] = await mostCentral(
          page,
          withChildren(root).map((n) => n.keyString),
          2,
        );
        const before = await placedByKey(page);
        const at = await nodeCentre(page, target as string);
        await page.mouse.click(at.x, at.y, { button: 'right' });
        await page.locator('[data-menu-item="collapse"]').click();
        const marker = `+:${target as string}`;
        await expect(page.locator(`.react-flow__node[data-id="${marker}"] [data-kind="collapsed"]`)).toHaveCount(1);
        expect((await placedByKey(page)).has(marker)).toBe(true);

        const markerAt = await nodeCentre(page, marker);
        await page.mouse.click(markerAt.x, markerAt.y);
        await expect(page.locator('[data-kind="collapsed"]')).toHaveCount(0);
        expect((await placedByKey(page)).has(marker)).toBe(false);

        const version = await sceneVersion(page);
        await dragNode(page, other as string);
        await afterScene(page, version);
        expect(manualKeys(await placedByKey(page))).toEqual([other]);
        const resetAt = await nodeCentre(page, other as string);
        await page.mouse.click(resetAt.x, resetAt.y, { button: 'right' });
        await page.locator('[data-menu-item="reset"]').click();
        await expect.poll(async () => manualKeys(await placedByKey(page))).toEqual([]);
        const restored = (await placedByKey(page)).get(other as string) as HostPlacement;
        const original = before.get(other as string) as HostPlacement;
        expect(Math.abs(restored.x - original.x)).toBeLessThan(TOLERANCE);
        expect(Math.abs(restored.y - original.y)).toBeLessThan(TOLERANCE);
      });

      test('Tidy clears manual positions and keeps collapse state and the root offset', async ({ page }) => {
        await open(page, query);
        const [collapsed] = await mostCentral(
          page,
          withChildren(root).map((n) => n.keyString),
          1,
        );
        const hidden = new Set(
          descendantsOf(withChildren(root).find((n) => n.keyString === collapsed) as ChainNode).map((n) => n.keyString),
        );
        const [moved] = await mostCentral(
          page,
          plainPrimaries(root)
            .map((n) => n.keyString)
            .filter((key) => key !== collapsed && !hidden.has(key)),
          1,
        );
        const at = await nodeCentre(page, collapsed as string);
        await page.mouse.click(at.x, at.y, { button: 'right' });
        await page.locator('[data-menu-item="collapse"]').click();
        await expect(page.locator('[data-kind="collapsed"]')).toHaveCount(1);
        if (mode !== 'radial') {
          const version = await sceneVersion(page);
          await dragNode(page, root.keyString);
          await afterScene(page, version);
        }
        const offset = await rootOffset(page);
        const version = await sceneVersion(page);
        await dragNode(page, moved as string);
        await afterScene(page, version);
        expect(manualKeys(await placedByKey(page))).toEqual([moved]);
        const tidyVersion = await sceneVersion(page);
        await page.getByTestId('tidy').click();
        await afterScene(page, tidyVersion);
        expect(manualKeys(await placedByKey(page))).toEqual([]);
        await expect(page.locator('[data-kind="collapsed"]')).toHaveCount(1);
        expect(await rootOffset(page)).toBe(offset);
      });

      if (mode === 'radial') {
        test('the root cannot be dragged', async ({ page }) => {
          await open(page, query);
          const before = await nodeCentre(page, root.keyString);
          const placed = await placedByKey(page);
          const origin = await flowOrigin(page, root.keyString);
          await dragFrom(page, before, { x: DRAG_PX, y: DRAG_PX });
          expect(await flowOrigin(page, root.keyString)).toEqual(origin);
          expect(await gestures(page)).toEqual([]);
          expect(await placedByKey(page)).toEqual(placed);
          expect(await rootOffset(page)).toBe(0);
        });
      } else {
        test('the root moves across the chain axis only, the whole chain follows and it is stored as the offset', async ({
          page,
        }) => {
          await open(page, query);
          const before = await placedByKey(page);
          const version = await sceneVersion(page);
          const from = await nodeCentre(page, root.keyString);
          await dragFrom(page, from, { x: DRAG_PX, y: DRAG_PX });
          await afterScene(page, version);
          const scale = await viewportScale(page);
          const after = await placedByKey(page);
          const across = (mode === 'top-down' ? 'x' : 'y') as 'x' | 'y';
          const along = across === 'x' ? 'y' : 'x';
          const expected = await rootOffset(page);
          expect(await gestures(page)).toEqual(['move-root']);
          expect(Math.abs(expected - DRAG_PX / scale) * scale).toBeLessThan(SCREEN_SLACK_PX);
          for (const [key, start] of before) {
            const moved = after.get(key) as HostPlacement;
            expect(Math.abs(moved[across] - start[across] - expected), `${key} across`).toBeLessThan(TOLERANCE);
            expect(Math.abs(moved[along] - start[along]), `${key} along`).toBeLessThan(TOLERANCE);
          }
          expect(manualKeys(after)).toEqual([]);
          await expect.poll(async () => (await batches(page)).length).toBe(1);
          const [batch] = await batches(page);
          expect(batch?.positions).toEqual([]);
          expect(batch?.rootOffset).toBe(await rootOffset(page));
        });
      }
    });
  }
}

const FIXTURE_QUERY = (fixture: string, mode: LayoutMode): string => `mode=${mode}&fixture=${fixture}`;

for (const mode of LAYOUT_MODES) {
  test(`Wanderer #98 on the real canvas, ${mode}: one batch with every dragged node, never reverted`, async ({
    page,
  }) => {
    await open(page, FIXTURE_QUERY('wanderer98', mode));
    const keys = wanderer98.movedNodeKeys;
    await clickWith(page, keys[0] as string);
    for (const key of keys.slice(1)) {
      await clickWith(page, key, 'Control');
    }
    expect(await selectedIds(page)).toEqual([...keys].sort());
    const before = await placedByKey(page);
    const version = await sceneVersion(page);
    const by = await dragNode(page, keys[0] as string);
    await afterScene(page, version);
    const scale = await viewportScale(page);
    const dragged = await placedByKey(page);
    sameDelta(before, dragged, keys, realDelta(before, dragged, keys[0] as string, by, scale));
    await expectOneBatch(page, keys);
    const [batch] = await batches(page);
    for (const key of keys) {
      const placed = dragged.get(key) as HostPlacement;
      const row = batch?.positions.find((candidate) => candidate.nodeKey === key);
      expect(row).toMatchObject({ source: 'manual' });
      expect(Math.abs((row?.x ?? NaN) - placed.x)).toBeLessThan(0.01);
      expect(Math.abs((row?.y ?? NaN) - placed.y)).toBeLessThan(0.01);
    }

    await page.getByTestId('stale-update').click();
    const addVersion = await sceneVersion(page);
    await page.getByTestId('add-connection').click();
    await afterScene(page, addVersion);
    const final = await placedByKey(page);
    for (const key of keys) {
      expect(final.get(key)).toEqual(dragged.get(key));
      expect(final.get(key)?.source).toBe('manual');
    }
  });

  test(`Wanderer #553 on the real canvas, ${mode}: the new node overlaps no neighbour`, async ({ page }) => {
    await open(page, FIXTURE_QUERY('wanderer553', mode));
    const before = await placedByKey(page);
    const version = await sceneVersion(page);
    await page.getByTestId('add-connection').click();
    await afterScene(page, version);
    const after = await placedByKey(page);
    expect(after.has('s:5')).toBe(true);
    await expect(page.locator('.react-flow__node[data-id="s:5"]')).toHaveCount(1);
    const overlapping = await page.evaluate(() => {
      const boxes = [...document.querySelectorAll<HTMLElement>('.react-flow__node')].map((element) => ({
        id: element.dataset.id ?? '',
        rect: element.getBoundingClientRect(),
      }));
      const fresh = boxes.find((box) => box.id === 's:5');
      return boxes
        .filter((box) => {
          const a = fresh?.rect as DOMRect;
          const b = box.rect;
          return box.id !== 's:5' && a.x < b.right && b.x < a.right && a.y < b.bottom && b.y < a.bottom;
        })
        .map((box) => box.id);
    });
    expect(overlapping).toEqual([]);
    if (mode !== 'radial') {
      for (const [key, start] of before) {
        expect(after.get(key), key).toEqual(start);
      }
    }
  });
}
