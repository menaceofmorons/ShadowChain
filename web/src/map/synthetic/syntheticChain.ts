import type { ChainConnection, ChainGraph } from '../model/types';
import { createPrng } from './prng';

export const SYNTHETIC_NODE_COUNTS = [50, 150, 250, 500] as const;

export const SYNTHETIC_ROOT_SYSTEM_ID = 1;

export interface SyntheticChainOptions {
  readonly nodeCount: number;
  readonly seed: number;
  readonly loopRatio?: number;
  readonly parallelRatio?: number;
  readonly unknownEndRatio?: number;
}

export const generateChain = (options: SyntheticChainOptions): ChainGraph => {
  const { nodeCount, seed, loopRatio = 0.08, parallelRatio = 0.05, unknownEndRatio = 0.1 } = options;
  if (!Number.isInteger(nodeCount) || nodeCount < 3) {
    throw new Error('nodeCount must be an integer of at least 3');
  }
  const rng = createPrng(seed);
  const systems = Array.from({ length: nodeCount }, (_, i) => ({ id: i + 1 }));
  const connections: ChainConnection[] = [];
  let nextId = 1;
  let clock = 1;
  const add = (endA: number, endB: number | null): void => {
    connections.push({ id: nextId++, createdAt: clock++, endA, endB });
  };
  const extra = (ratio: number): number => Math.max(1, Math.round(nodeCount * ratio));

  for (let system = 2; system <= nodeCount; system += 1) {
    add(1 + rng.int(system - 1), system);
  }
  const treeCount = connections.length;

  for (let i = 0, n = extra(loopRatio); i < n; i += 1) {
    const a = 1 + rng.int(nodeCount);
    let b = 1 + rng.int(nodeCount);
    if (b === a) b = (a % nodeCount) + 1;
    add(a, b);
  }
  for (let i = 0, n = extra(parallelRatio); i < n; i += 1) {
    const base = connections[rng.int(treeCount)] as ChainConnection;
    add(base.endA, base.endB);
  }
  for (let i = 0, n = extra(unknownEndRatio); i < n; i += 1) {
    add(1 + rng.int(nodeCount), null);
  }
  return { systems, connections };
};

export const generateAllSizes = (seed: number): readonly ChainGraph[] =>
  SYNTHETIC_NODE_COUNTS.map((nodeCount) => generateChain({ nodeCount, seed }));
