import { readFileSync } from 'node:fs';
import { cpus, platform, release, totalmem } from 'node:os';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';
import { build } from 'vite';
import { measureCodeSize } from '../src/map/harness/codeSize';
import { BAKEOFF_CANDIDATES } from '../src/map/bakeoff/candidates';
import { DEFAULT_STABILITY_OPTIONS, runStability } from '../src/map/bakeoff/bakeoffRunner';
import { formatBakeoffReport } from '../src/map/bakeoff/formatBakeoffReport';
import { BAKEOFF_SIZES, SPEED_SIZES } from '../src/map/bakeoff/types';
import type { BakeoffData, CodeSizeRow, SpeedRow } from '../src/map/bakeoff/types';
import { CANDIDATE_SOURCES, CANDIDATE_WORKER_ENTRIES } from './host/candidates';
import type { CandidateName } from './host/candidates';
import type { HostResult, HostState } from './host/host';

const WARMUP_FULL_RUNS = 3;
const FULL_RUNS = 10;
const CHURN_STEPS = 80;
const SPEED_SEED = 7;

async function runHost(page: Page, query: string): Promise<HostResult> {
  const problems: string[] = [];
  page.on('pageerror', (error) => {
    problems.push(error.message);
  });
  await page.goto(`/e2e/host/host.html?${query}`);
  await page.waitForFunction(() => (window as unknown as { __harness: HostState }).__harness.done, undefined, {
    timeout: 240_000,
  });
  const state = await page.evaluate(() => (window as unknown as { __harness: HostState }).__harness);
  expect(problems).toEqual([]);
  expect(state.error).toBeNull();
  if (state.result === null) {
    throw new Error('host produced no result');
  }
  return state.result;
}

async function measureSpeed(browser: Browser): Promise<readonly SpeedRow[]> {
  const rows: SpeedRow[] = [];
  for (const candidate of BAKEOFF_CANDIDATES) {
    for (const mode of candidate.modes) {
      for (const size of SPEED_SIZES) {
        const context = await browser.newContext();
        const page = await context.newPage();
        const query = `engine=${candidate.name}&mode=${mode}&size=${String(size)}&seed=${String(SPEED_SEED)}&churn=${String(CHURN_STEPS)}&repeats=${String(FULL_RUNS)}&warmup=${String(WARMUP_FULL_RUNS)}`;
        const { report } = await runHost(page, query);
        rows.push({
          candidate: candidate.name,
          mode,
          size,
          full: report.fullLayoutMs,
          incremental: report.additionLayoutMs,
        });
        await context.close();
      }
    }
  }
  return rows;
}

async function workerBundleBytes(entry: string): Promise<number> {
  const result = await build({
    configFile: false,
    logLevel: 'silent',
    build: {
      write: false,
      minify: true,
      lib: { entry: resolve(entry), formats: ['es'], fileName: 'worker' },
    },
  });
  const outputs = (Array.isArray(result) ? result : [result]) as readonly {
    output: readonly { type: string; code?: string }[];
  }[];
  return outputs
    .flatMap((bundle) => bundle.output)
    .reduce((total, item) => total + (item.type === 'chunk' ? Buffer.byteLength(item.code ?? '') : 0), 0);
}

async function measureCodeSizes(): Promise<readonly CodeSizeRow[]> {
  const rows: CodeSizeRow[] = [];
  for (const candidate of BAKEOFF_CANDIDATES) {
    const name = candidate.name as CandidateName;
    const files = CANDIDATE_SOURCES[name].map((path) => ({ path, text: readFileSync(resolve(path), 'utf8') }));
    const size = measureCodeSize(files);
    rows.push({
      candidate: name,
      bytes: size.bytes,
      nonBlankLines: size.nonBlankLines,
      workerBundleBytes: await workerBundleBytes(CANDIDATE_WORKER_ENTRIES[name]),
    });
  }
  return rows;
}

const describeMachine = (browserVersion: string): string => {
  const cpu = cpus();
  return `${cpu[0]?.model.trim() ?? 'unknown cpu'} x${String(cpu.length)} logical, ${String(Math.round(totalmem() / 2 ** 30))} GiB RAM, ${platform()} ${release()}, node ${process.version}, Chromium ${browserVersion}`;
};

test.describe('layout bake-off', () => {
  test('measures both candidates in all modes and sizes and prints the report', async ({ browser }) => {
    test.setTimeout(1_800_000);
    const { stability, wanderer } = await runStability(BAKEOFF_CANDIDATES, BAKEOFF_SIZES);
    const speed = await measureSpeed(browser);
    const codeSize = await measureCodeSizes();
    const data: BakeoffData = {
      machine: describeMachine(browser.version()),
      runCounts: {
        warmupFullRuns: WARMUP_FULL_RUNS,
        fullRuns: FULL_RUNS,
        incrementalRuns: Math.min(...speed.map((row) => row.incremental.count)),
        stabilityChurnSteps: DEFAULT_STABILITY_OPTIONS.churnSteps,
        stabilitySeed: DEFAULT_STABILITY_OPTIONS.seed,
      },
      stability,
      wanderer,
      speed,
      codeSize,
    };
    const report = formatBakeoffReport(data);
    console.log(`\n${report}\n`);
    await test.info().attach('bakeoff-report.txt', { body: report, contentType: 'text/plain' });

    expect(stability).toHaveLength(
      BAKEOFF_CANDIDATES.reduce((sum, c) => sum + c.modes.length, 0) * BAKEOFF_SIZES.length,
    );
    expect(speed).toHaveLength(BAKEOFF_CANDIDATES.reduce((sum, c) => sum + c.modes.length, 0) * SPEED_SIZES.length);
    expect(speed.every((row) => row.full.count === FULL_RUNS && row.incremental.count > 0)).toBe(true);
    expect(codeSize.every((row) => row.bytes > 0 && row.workerBundleBytes > 0)).toBe(true);
  });
});
