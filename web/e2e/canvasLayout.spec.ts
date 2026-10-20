import { expect, test } from '@playwright/test';
import type { CanvasHostState } from './host/canvas';
import { LAYOUT_MODES } from '../src/map/layout/types';

const NODE_COUNT = 150;

const EXPECTED_ENGINE = { 'top-down': 'tidy-tree', 'left-to-right': 'tidy-tree', radial: 'elkjs' } as const;

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
  }
});
