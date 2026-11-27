import { expect, test, type Page } from '@playwright/test';
import { DEFAULT_ENGINE_OPTIONS, nodeSizeForKind } from '../src/map/layout/engineOptions';
import { LAYOUT_MODES } from '../src/map/layout/types';
import { scaledLimit, scaledTimeout } from '../src/map/layout/testing/loadMultiplier';
import { buildChainTree } from '../src/map/model/chainTree';
import type { ChainNode } from '../src/map/model/types';
import { generateChain, SYNTHETIC_ROOT_SYSTEM_ID } from '../src/map/synthetic';
import type { HostPlacement } from './host/canvas';

const SEED = 7;
const NODE_COUNT = 150;
const GROUP_SIZE = 3;
const MOVE_PX = 40;
const POSITION_EPSILON = 0.01;
const MAX_RENDERS_PER_ELEMENT = 3;
const PAINT_LIMIT_150_MS = scaledLimit(1000);
const CHURN_RUNS = [
  { size: 250, operations: 12 },
  { size: 500, operations: 8 },
] as const;
const CHURN_TIMEOUT_MS = scaledTimeout(120_000);

interface Measured {
  nodes: Record<string, number>;
  edges: Record<string, number>;
  ms: number;
}

const hostUrl = (query: string): string => `/e2e/host/canvas.html?${query}`;

async function open(page: Page, query: string): Promise<void> {
  await page.goto(hostUrl(query));
  await page.waitForFunction(() => window.__canvas.done);
  expect(await page.evaluate(() => window.__canvas.error)).toBeNull();
}

const placed = async (page: Page): Promise<Map<string, HostPlacement>> =>
  new Map((await page.evaluate(() => window.__canvas.placed)).map((p) => [p.key, p]));

const treeRoot = (nodeCount: number): ChainNode =>
  buildChainTree(generateChain({ nodeCount, seed: SEED }), SYNTHETIC_ROOT_SYSTEM_ID).root;

const allNodes = (node: ChainNode): ChainNode[] => [node, ...node.children.flatMap(allNodes)];

const plainPrimaries = (root: ChainNode): ChainNode[] =>
  allNodes(root).filter((node) => node !== root && node.kind === 'primary');

const settle = (page: Page): Promise<void> =>
  page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));

async function measure(page: Page, run: () => Promise<void>, sceneChanges = true): Promise<Measured> {
  const version = await page.evaluate(() => {
    window.__canvasRenders.reset();
    return window.__canvas.sceneVersion;
  });
  const start = Date.now();
  await run();
  if (sceneChanges) {
    await page.waitForFunction((before) => window.__canvas.sceneVersion > before, version);
  }
  await settle(page);
  const ms = Date.now() - start;
  return await page.evaluate((elapsed) => {
    const probe = window.__canvasRenders;
    return { nodes: probe.counts(), edges: probe.edgeCounts(), ms: elapsed };
  }, ms);
}

const changedKeys = (before: Map<string, HostPlacement>, after: Map<string, HostPlacement>): Set<string> => {
  const changed = new Set<string>();
  after.forEach((now, key) => {
    const was = before.get(key);
    if (was === undefined || Math.abs(was.x - now.x) > POSITION_EPSILON || Math.abs(was.y - now.y) > POSITION_EPSILON) {
      changed.add(key);
    }
  });
  return changed;
};

const edgeSignatures = async (page: Page): Promise<Map<string, string>> =>
  new Map(
    await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>('[data-connector]')].map((element): [string, string] => [
        `${element.dataset.source ?? ''}>${element.dataset.target ?? ''}`,
        [...element.querySelectorAll<SVGPathElement>('path')]
          .map((path) => `${path.dataset.colour ?? ''}/${path.dataset.width ?? ''}/${path.dataset.dash ?? ''}`)
          .join('|'),
      ]),
    ),
  );

const changedEdges = (before: Map<string, string>, after: Map<string, string>): Set<string> =>
  new Set([...after].filter(([edge, signature]) => before.get(edge) !== signature).map(([edge]) => edge));

const drawnEdgeCount = (page: Page): Promise<number> => page.locator('[data-connector]').count();

const touchesChanged = (edge: string, changed: ReadonlySet<string>): boolean =>
  edge.split('>').some((end) => changed.has(end));

function expectWithinChanged(
  measured: Measured,
  changed: ReadonlySet<string>,
  after: Map<string, HostPlacement>,
  changedEdgeKeys: ReadonlySet<string> = new Set(),
): void {
  expect(Object.keys(measured.nodes).filter((key) => after.has(key) && !changed.has(key))).toEqual([]);
  expect(
    Object.keys(measured.edges).filter((edge) => !touchesChanged(edge, changed) && !changedEdgeKeys.has(edge)),
  ).toEqual([]);
  [...Object.values(measured.nodes), ...Object.values(measured.edges)].forEach((count) => {
    expect(count).toBeLessThanOrEqual(MAX_RENDERS_PER_ELEMENT);
  });
}

const sizeOfKey = (key: string): { width: number; height: number } => {
  const kind = key.startsWith('a:') ? 'alias' : key.startsWith('+:') ? 'collapsed' : 'primary';
  return nodeSizeForKind(kind, DEFAULT_ENGINE_OPTIONS);
};

function overlaps(positions: Map<string, HostPlacement>): string[] {
  const boxes = [...positions.values()].map((p) => ({ key: p.key, x: p.x, y: p.y, ...sizeOfKey(p.key) }));
  const found: string[] = [];
  boxes.forEach((a, i) => {
    boxes.slice(i + 1).forEach((b) => {
      if (a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height) {
        found.push(`${a.key} x ${b.key}`);
      }
    });
  });
  return found;
}

function report(name: string, measured: Measured): void {
  const nodes = String(Object.keys(measured.nodes).length);
  const edges = String(Object.keys(measured.edges).length);
  console.info(`MEASURED ${name}: nodes rendered ${nodes}, edges rendered ${edges}, ${String(measured.ms)} ms`);
}

for (const mode of LAYOUT_MODES) {
  test.describe(`render counts at ${String(NODE_COUNT)} nodes, ${mode}`, () => {
    const query = `mode=${mode}&size=${String(NODE_COUNT)}&seed=${String(SEED)}`;
    const root = treeRoot(NODE_COUNT);
    const parents = plainPrimaries(root).filter((node) => node.children.length > 0);
    const leaves = plainPrimaries(root).filter((node) => node.children.length === 0);
    const parentKey = (parents[Math.floor(parents.length / 2)] as ChainNode).keyString;
    const leafKey = (leaves[Math.floor(leaves.length / 2)] as ChainNode).keyString;
    const groupKeys = leaves.slice(0, GROUP_SIZE).map((node) => node.keyString);

    test('node move re-renders only the moved and carried nodes and their edges', async ({ page }) => {
      await open(page, query);
      const before = await placed(page);
      const measured = await measure(page, () =>
        page.evaluate(
          ([key, by]) => window.__canvasOps.moveNode(key as string, by as number, by as number),
          [parentKey, MOVE_PX],
        ),
      );
      const after = await placed(page);
      const changed = changedKeys(before, after);
      expect(changed.has(parentKey)).toBe(true);
      expectWithinChanged(measured, changed, after);
      report(`${mode} node move (${String(changed.size)} moved)`, measured);
      expect(measured.ms).toBeLessThan(PAINT_LIMIT_150_MS);
    });

    test('group move re-renders only the moved and carried nodes and their edges', async ({ page }) => {
      await open(page, query);
      const before = await placed(page);
      const measured = await measure(page, () =>
        page.evaluate(
          ([keys, by]) => window.__canvasOps.moveGroup(keys as string[], by as number, by as number),
          [groupKeys, MOVE_PX],
        ),
      );
      const after = await placed(page);
      const changed = changedKeys(before, after);
      groupKeys.forEach((key) => {
        expect(changed.has(key)).toBe(true);
      });
      expectWithinChanged(measured, changed, after);
      report(`${mode} group move (${String(changed.size)} moved)`, measured);
      expect(measured.ms).toBeLessThan(PAINT_LIMIT_150_MS);
    });

    test('selection re-renders only nodes whose highlight changed and no edge', async ({ page }) => {
      await open(page, query);
      const centre = await page.evaluate((key) => {
        const rect = document.querySelector(`.react-flow__node[data-id="${key}"]`)?.getBoundingClientRect();
        return rect === undefined ? null : { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      }, leafKey);
      expect(centre).not.toBeNull();
      const measured = await measure(
        page,
        async () => {
          await page.mouse.click(centre?.x ?? 0, centre?.y ?? 0);
        },
        false,
      );
      const systemId = leafKey.split(':')[1] ?? '';
      const group = new RegExp(`^[sa]:${systemId}(:|$)`);
      expect(Object.keys(measured.nodes).filter((key) => !group.test(key))).toEqual([]);
      expect(Object.keys(measured.nodes)).toContain(leafKey);
      expect(Object.keys(measured.edges)).toEqual([]);
      report(`${mode} selection`, measured);
    });

    test('collapse and expand re-render only nodes whose position, visibility or flags changed', async ({ page }) => {
      await open(page, query);
      for (const collapsed of [true, false]) {
        const before = await placed(page);
        const measured = await measure(page, () =>
          page.evaluate(
            ([key, flag]) => window.__canvasOps.setCollapsed(key as string, flag as boolean),
            [parentKey, collapsed],
          ),
        );
        const after = await placed(page);
        const changed = changedKeys(before, after);
        expectWithinChanged(measured, changed, after);
        report(`${mode} ${collapsed ? 'collapse' : 'expand'} (${String(changed.size)} changed)`, measured);
        expect(measured.ms).toBeLessThan(PAINT_LIMIT_150_MS);
      }
    });

    test('add then remove re-render only nodes whose position or visibility changed', async ({ page }) => {
      await open(page, query);
      for (const step of ['addLeaf', 'removeLast'] as const) {
        const before = await placed(page);
        const measured = await measure(page, () => page.evaluate((op) => window.__canvasOps[op](), step));
        const after = await placed(page);
        const changed = changedKeys(before, after);
        expectWithinChanged(measured, changed, after);
        expect(overlaps(after)).toEqual([]);
        report(`${mode} ${step} (${String(changed.size)} changed)`, measured);
        expect(measured.ms).toBeLessThan(PAINT_LIMIT_150_MS);
      }
    });

    test('a field update on one node re-renders only that node and no edge', async ({ page }) => {
      await open(page, query);
      const measured = await measure(page, () =>
        page.evaluate(
          ([key, label]) => {
            window.__canvasOps.fieldUpdate(key as string, label as string);
          },
          [leafKey, 'updated'],
        ),
      );
      expect(Object.keys(measured.nodes)).toEqual([leafKey]);
      expect(measured.nodes[leafKey]).toBe(1);
      expect(Object.keys(measured.edges)).toEqual([]);
      report(`${mode} field update`, measured);
    });

    test('render-only-visible-elements stays off: every node and edge is drawn', async ({ page }) => {
      await open(page, query);
      const expected = await page.evaluate(() => window.__canvas.expectedNodeCount);
      expect(await page.locator('.react-flow__node').count()).toBe(expected);
      expect(await drawnEdgeCount(page)).toBe(expected - 1);
    });
  });
}

for (const mode of LAYOUT_MODES) {
  for (const run of CHURN_RUNS) {
    test(`churn at ${String(run.size)} nodes, ${mode}: no overlap, bounded renders`, async ({ page }) => {
      test.setTimeout(CHURN_TIMEOUT_MS);
      await open(page, `mode=${mode}&size=${String(run.size)}&seed=${String(SEED)}&churn=${String(run.operations)}`);
      expect(overlaps(await placed(page))).toEqual([]);
      for (let step = 1; step <= run.operations; step += 1) {
        const before = await placed(page);
        const edgesBefore = await edgeSignatures(page);
        const measured = await measure(page, () =>
          page.evaluate(() => window.__canvasOps.churnStep()).then(() => undefined),
        );
        const after = await placed(page);
        const changed = changedKeys(before, after);
        expect(overlaps(after), `${mode} ${String(run.size)} step ${String(step)}`).toEqual([]);
        expectWithinChanged(measured, changed, after, changedEdges(edgesBefore, await edgeSignatures(page)));
        report(`${mode} churn ${String(run.size)} step ${String(step)} (${String(changed.size)} changed)`, measured);
      }
    });
  }
}
