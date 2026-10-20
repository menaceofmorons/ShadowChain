import type { TimingStats } from '../harness/stats';
import { FULL_TARGET_MS, INCREMENTAL_TARGET_MS, TARGET_SIZE } from './types';
import type { BakeoffData, SpeedRow } from './types';

const fixed = (value: number): string => value.toFixed(2);

const table = (rows: readonly (readonly string[])[]): string => {
  const widths = (rows[0] ?? []).map((_, column) => Math.max(...rows.map((row) => (row[column] ?? '').length)));
  return rows
    .map((row) =>
      row
        .map((cell, column) => cell.padEnd(widths[column] ?? 0))
        .join('  ')
        .trimEnd(),
    )
    .join('\n');
};

const unique = <T>(values: readonly T[]): readonly T[] => [...new Set(values)];

const movedCell = (moved: TimingStats): string => `${fixed(moved.median)}/${fixed(moved.p95)}/${String(moved.max)}`;

const speedCell = (stats: TimingStats): string => `${fixed(stats.median)}/${fixed(stats.p95)}`;

export const meetsFullTarget = (row: SpeedRow): boolean => row.full.p95 < FULL_TARGET_MS;

export const meetsIncrementalTarget = (row: SpeedRow): boolean => row.incremental.p95 < INCREMENTAL_TARGET_MS;

function sideBySide<Row extends { readonly candidate: string }>(
  title: string,
  header: readonly string[],
  rows: readonly Row[],
  keyOf: (row: Row) => readonly string[],
  cellOf: (row: Row) => string,
  candidates: readonly string[],
): string {
  const keys = unique(rows.map((row) => keyOf(row).join('\u0000')));
  const body = keys.map((key) => {
    const parts = key.split('\u0000');
    const cells = candidates.map((candidate) => {
      const match = rows.find((row) => row.candidate === candidate && keyOf(row).join('\u0000') === key);
      return match === undefined ? 'n/a' : cellOf(match);
    });
    return [...parts, ...cells];
  });
  return [title, table([[...header, ...candidates], ...body])].join('\n');
}

export function formatBakeoffReport(data: BakeoffData): string {
  const candidates = unique([
    ...data.stability.map((row) => row.candidate),
    ...data.speed.map((row) => row.candidate),
    ...data.codeSize.map((row) => row.candidate),
  ]);
  const counts = data.runCounts;
  const sections: string[] = [
    `layout bake-off report`,
    `machine: ${data.machine}`,
    `run counts: stability churn ${String(counts.stabilityChurnSteps)} steps (seed ${String(counts.stabilitySeed)}); speed warm-up ${String(counts.warmupFullRuns)} full, measured ${String(counts.fullRuns)} full and ${String(counts.incrementalRuns)} incremental per cell`,
    sideBySide(
      'stability: nodes moved per addition, median/p95/max',
      ['mode', 'nodes'],
      data.stability,
      (row) => [row.mode, String(row.size)],
      (row) => movedCell(row.moved),
      candidates,
    ),
    sideBySide(
      'stability: deterministic across repeats',
      ['mode', 'nodes'],
      data.stability,
      (row) => [row.mode, String(row.size)],
      (row) => (row.deterministic ? 'yes' : 'NO'),
      candidates,
    ),
    sideBySide(
      'Wanderer #553 outcome (new node overlaps no neighbour, no placed node moves; data point only)',
      ['mode'],
      data.wanderer,
      (row) => [row.mode],
      (row) =>
        `${row.pass ? 'pass' : 'fail'} (overlap ${row.newNodeOverlaps ? 'yes' : 'no'}, moved ${String(row.placedNodesMoved)})`,
      candidates,
    ),
    sideBySide(
      'speed in Chromium worker: full layout ms, median/p95',
      ['mode', 'nodes'],
      data.speed,
      (row) => [row.mode, String(row.size)],
      (row) => speedCell(row.full),
      candidates,
    ),
    sideBySide(
      'speed in Chromium worker: incremental placement ms, median/p95',
      ['mode', 'nodes'],
      data.speed,
      (row) => [row.mode, String(row.size)],
      (row) => speedCell(row.incremental),
      candidates,
    ),
    `targets at ${String(TARGET_SIZE)} nodes (p95): full under ${String(FULL_TARGET_MS)} ms, incremental under ${String(INCREMENTAL_TARGET_MS)} ms`,
    table([
      ['candidate', 'mode', 'full', 'incremental'],
      ...data.speed
        .filter((row) => row.size === TARGET_SIZE)
        .map((row) => [
          row.candidate,
          row.mode,
          meetsFullTarget(row) ? 'met' : 'NOT met',
          meetsIncrementalTarget(row) ? 'met' : 'NOT met',
        ]),
    ]),
    'code size (engine sources only; shared contract and options excluded)',
    table([
      ['candidate', 'bytes', 'non-blank lines', 'worker bundle bytes (minified)'],
      ...data.codeSize.map((row) => [
        row.candidate,
        String(row.bytes),
        String(row.nonBlankLines),
        String(row.workerBundleBytes),
      ]),
    ]),
  ];
  return sections.join('\n\n');
}
