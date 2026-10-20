export interface TimingStats {
  readonly count: number;
  readonly median: number;
  readonly p95: number;
  readonly max: number;
}

const nearestRank = (sorted: readonly number[], fraction: number): number => {
  const rank = Math.max(1, Math.ceil(fraction * sorted.length));
  return sorted[rank - 1] as number;
};

export const summarise = (samples: readonly number[]): TimingStats => {
  if (samples.length === 0) {
    return { count: 0, median: 0, p95: 0, max: 0 };
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 1
      ? (sorted[middle] as number)
      : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
  return { count: sorted.length, median, p95: nearestRank(sorted, 0.95), max: sorted[sorted.length - 1] as number };
};
