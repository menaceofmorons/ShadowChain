import type { HarnessReport } from './metricsHarness';
import type { TimingStats } from './stats';

export class HarnessAssertionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HarnessAssertionError';
  }
}

export const assertNoMovementOnAddition = (report: HarnessReport): void => {
  const offending = report.nodesMovedPerAddition.perAddition
    .map((moved, index) => ({ moved, index }))
    .filter(({ moved }) => moved > 0);
  if (offending.length > 0) {
    const detail = offending.map(({ index, moved }) => `addition ${String(index)} moved ${String(moved)}`).join('; ');
    throw new HarnessAssertionError(`placed nodes moved on addition: ${detail}`);
  }
};

export const assertMovedPerAdditionAtMost = (report: HarnessReport, bound: number): void => {
  const worst = report.nodesMovedPerAddition.max;
  if (worst > bound) {
    throw new HarnessAssertionError(`nodes moved per addition peaked at ${String(worst)}, bound is ${String(bound)}`);
  }
};

export type TimingStatistic = 'median' | 'p95' | 'max';

export const assertWithinTimeBudget = (
  stats: TimingStats,
  budgetMs: number,
  statistic: TimingStatistic = 'p95',
): void => {
  if (stats.count === 0) {
    throw new HarnessAssertionError('no timing samples to check against the budget');
  }
  if (stats[statistic] > budgetMs) {
    throw new HarnessAssertionError(
      `${statistic} ${String(stats[statistic])} ms exceeds budget ${String(budgetMs)} ms`,
    );
  }
};
