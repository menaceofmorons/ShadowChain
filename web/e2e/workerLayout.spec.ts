import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { HostResult, HostState } from './host/host';
import { DEFAULT_ENGINE_OPTIONS } from '../src/map/layout/engineOptions';
import { LAYOUT_MODES } from '../src/map/layout/types';
import type { LayoutMode, PlacedNode } from '../src/map/layout/types';

const FULL_TARGET_MS = 100;
const INCREMENTAL_TARGET_MS = 10;
const NODE_COUNT = 150;

async function runHost(page: Page, mode: LayoutMode): Promise<HostResult> {
  const problems: string[] = [];
  page.on('pageerror', (error) => {
    problems.push(error.message);
  });
  await page.goto(
    `/e2e/host/host.html?engine=registry&mode=${mode}&size=${String(NODE_COUNT)}&seed=7&churn=30&repeats=3&warmup=3`,
  );
  await page.waitForFunction(() => (window as unknown as { __harness: HostState }).__harness.done);
  const state = await page.evaluate(() => (window as unknown as { __harness: HostState }).__harness);
  expect(problems).toEqual([]);
  expect(state.error).toBeNull();
  if (state.result === null) {
    throw new Error('host produced no result');
  }
  return state.result;
}

const sizeOf = (node: PlacedNode): { width: number; height: number } => {
  if (node.alias) {
    return { width: DEFAULT_ENGINE_OPTIONS.aliasWidth, height: DEFAULT_ENGINE_OPTIONS.aliasHeight };
  }
  if (node.hiddenCount !== null) {
    return { width: DEFAULT_ENGINE_OPTIONS.collapsedWidth, height: DEFAULT_ENGINE_OPTIONS.collapsedHeight };
  }
  return { width: DEFAULT_ENGINE_OPTIONS.nodeWidth, height: DEFAULT_ENGINE_OPTIONS.nodeHeight };
};

const overlappingPairs = (nodes: readonly PlacedNode[]): string[] => {
  const pairs: string[] = [];
  for (let i = 0; i < nodes.length; i += 1) {
    for (let j = i + 1; j < nodes.length; j += 1) {
      const a = nodes[i];
      const b = nodes[j];
      if (a === undefined || b === undefined) {
        continue;
      }
      const sa = sizeOf(a);
      const sb = sizeOf(b);
      if (a.x < b.x + sb.width && b.x < a.x + sa.width && a.y < b.y + sb.height && b.y < a.y + sa.height) {
        pairs.push(`${a.nodeKey}|${b.nodeKey}`);
      }
    }
  }
  return pairs;
};

const byKey = (nodes: readonly PlacedNode[]): readonly PlacedNode[] =>
  [...nodes].sort((a, b) => (a.nodeKey < b.nodeKey ? -1 : a.nodeKey > b.nodeKey ? 1 : 0));

test.describe('registry engines in a real worker', () => {
  for (const mode of LAYOUT_MODES) {
    test(`${mode}: 150-node chain has no overlap, repeats identically and records timings`, async ({ page }) => {
      const first = await runHost(page, mode);
      const second = await runHost(page, mode);

      expect(first.finalPlaced.length).toBeGreaterThan(100);
      expect(overlappingPairs(first.finalPlaced)).toEqual([]);

      const leaves = first.collapsedPlaced.filter((node) => node.hiddenCount !== null);
      expect(leaves).toHaveLength(1);
      expect(leaves[0]?.hiddenCount).toBe(first.collapsedHiddenTotal);
      expect(first.collapsedPlaced.filter((node) => node.collapsed)).toHaveLength(1);
      expect(overlappingPairs(first.collapsedPlaced)).toEqual([]);
      expect(byKey(second.collapsedPlaced)).toEqual(byKey(first.collapsedPlaced));
      expect(byKey(second.finalPlaced)).toEqual(byKey(first.finalPlaced));

      const { fullLayoutMs, additionLayoutMs } = first.report;
      console.info(
        `${mode} ${String(NODE_COUNT)} nodes: full median/p95 ${fullLayoutMs.median.toFixed(2)}/${fullLayoutMs.p95.toFixed(2)} ms (target ${String(FULL_TARGET_MS)}), incremental addition median/p95 ${additionLayoutMs.median.toFixed(2)}/${additionLayoutMs.p95.toFixed(2)} ms (target ${String(INCREMENTAL_TARGET_MS)})`,
      );
      test.info().annotations.push({
        type: 'timing',
        description: `full p95 ${fullLayoutMs.p95.toFixed(2)} ms; addition p95 ${additionLayoutMs.p95.toFixed(2)} ms`,
      });
      expect(fullLayoutMs.count).toBe(3);
      expect(fullLayoutMs.p95).toBeLessThan(FULL_TARGET_MS);
      if (mode === 'radial') {
        expect(additionLayoutMs.median).toBeLessThan(INCREMENTAL_TARGET_MS);
        expect(additionLayoutMs.p95).toBeLessThan(FULL_TARGET_MS);
      } else {
        expect(additionLayoutMs.p95).toBeLessThan(INCREMENTAL_TARGET_MS);
        expect(first.report.nodesMovedPerAddition.max).toBe(0);
      }
    });
  }
});
