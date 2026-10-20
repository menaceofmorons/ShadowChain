import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { HostResult, HostState } from './host/host';
import { DELAY_MS } from './host/engines';

async function runHost(page: Page, query: string): Promise<HostResult> {
  const problems: string[] = [];
  page.on('pageerror', (error) => {
    problems.push(error.message);
  });
  await page.goto(`/e2e/host/host.html?${query}`);
  await page.waitForFunction(() => (window as unknown as { __harness: HostState }).__harness.done);
  const state = await page.evaluate(() => (window as unknown as { __harness: HostState }).__harness);
  expect(problems).toEqual([]);
  expect(state.error).toBeNull();
  if (state.result === null) {
    throw new Error('host produced no result');
  }
  return state.result;
}

test.describe('layout through a real worker', () => {
  test('stable engine places every node and never moves one on addition', async ({ page }) => {
    const { report, finalPlaced } = await runHost(page, 'engine=stable&size=150&seed=7&churn=30&repeats=3');
    expect(finalPlaced.length).toBeGreaterThan(100);
    expect(new Set(finalPlaced.map((node) => node.nodeKey)).size).toBe(finalPlaced.length);
    expect(report.nodesMovedPerAddition.count).toBeGreaterThan(0);
    expect(report.nodesMovedPerAddition.max).toBe(0);
    expect(report.fullLayoutMs.count).toBe(3);
    expect(report.additionLayoutMs.count + report.removalLayoutMs.count).toBe(30);
    expect(report.fullLayoutMs.median).toBeGreaterThan(0);
  });

  test('shifting engine is seen moving nodes on addition', async ({ page }) => {
    const { report } = await runHost(page, 'engine=shifting&size=50&seed=7&churn=10&repeats=2');
    expect(report.nodesMovedPerAddition.max).toBeGreaterThan(0);
  });

  test('delayed engine is seen exceeding the timing floor', async ({ page }) => {
    const { report } = await runHost(page, `engine=delayed&size=50&seed=7&churn=6&repeats=2&mode=left-to-right`);
    expect(report.incrementalLayoutMs.median).toBeGreaterThanOrEqual(DELAY_MS);
    expect(report.fullLayoutMs.median).toBeGreaterThanOrEqual(DELAY_MS);
  });
});
