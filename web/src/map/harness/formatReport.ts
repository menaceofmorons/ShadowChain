import type { HarnessReport } from './metricsHarness';
import type { TimingStats } from './stats';

const fixed = (value: number): string => value.toFixed(2);

const statsRow = (name: string, stats: TimingStats): readonly string[] => [
  name,
  String(stats.count),
  fixed(stats.median),
  fixed(stats.p95),
  fixed(stats.max),
];

export function formatReport(report: HarnessReport): string {
  const rows: readonly (readonly string[])[] = [
    ['metric', 'count', 'median', 'p95', 'max'],
    statsRow('nodes moved per addition', report.nodesMovedPerAddition),
    statsRow('full layout time (ms)', report.fullLayoutMs),
    statsRow('incremental layout time (ms)', report.incrementalLayoutMs),
    statsRow('addition layout time (ms)', report.additionLayoutMs),
    statsRow('removal layout time (ms)', report.removalLayoutMs),
  ];
  const widths = (rows[0] ?? []).map((_, column) => Math.max(...rows.map((row) => (row[column] ?? '').length)));
  const table = rows.map((row) =>
    row
      .map((cell, column) => cell.padEnd(widths[column] ?? 0))
      .join('  ')
      .trimEnd(),
  );
  return [
    `engine: ${report.label}  mode: ${report.mode}  nodes: ${String(report.nodeCount)}  churn steps: ${String(report.churnSteps)}`,
    ...table,
    `engine code size: ${String(report.codeSize.bytes)} bytes, ${String(report.codeSize.nonBlankLines)} non-blank lines`,
  ].join('\n');
}
