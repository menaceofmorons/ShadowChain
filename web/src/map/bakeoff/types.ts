import type { LayoutEngine, LayoutMode } from '../layout/types';
import type { TimingStats } from '../harness/stats';

export interface BakeoffCandidate {
  readonly name: string;
  readonly createEngine: () => LayoutEngine;
  readonly modes: readonly LayoutMode[];
}

export interface StabilityRow {
  readonly candidate: string;
  readonly mode: LayoutMode;
  readonly size: number;
  readonly churnSteps: number;
  readonly moved: TimingStats;
  readonly deterministic: boolean;
}

export interface WandererRow {
  readonly candidate: string;
  readonly mode: LayoutMode;
  readonly newNodeOverlaps: boolean;
  readonly placedNodesMoved: number;
  readonly pass: boolean;
}

export interface SpeedRow {
  readonly candidate: string;
  readonly mode: LayoutMode;
  readonly size: number;
  readonly full: TimingStats;
  readonly incremental: TimingStats;
}

export interface CodeSizeRow {
  readonly candidate: string;
  readonly bytes: number;
  readonly nonBlankLines: number;
  readonly workerBundleBytes: number;
}

export interface RunCounts {
  readonly warmupFullRuns: number;
  readonly fullRuns: number;
  readonly incrementalRuns: number;
  readonly stabilityChurnSteps: number;
  readonly stabilitySeed: number;
}

export interface BakeoffData {
  readonly machine: string;
  readonly runCounts: RunCounts;
  readonly stability: readonly StabilityRow[];
  readonly wanderer: readonly WandererRow[];
  readonly speed: readonly SpeedRow[];
  readonly codeSize: readonly CodeSizeRow[];
}

export const BAKEOFF_SIZES = [50, 150, 250, 500] as const;
export const SPEED_SIZES = [150, 250, 500] as const;
export const TARGET_SIZE = 150;
export const FULL_TARGET_MS = 100;
export const INCREMENTAL_TARGET_MS = 10;
