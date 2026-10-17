import type { ChainConnection, ChainGraph } from '../model/types';
import { createPrng } from './prng';

export type ChurnOperation =
  | { readonly kind: 'add'; readonly connection: ChainConnection }
  | { readonly kind: 'remove'; readonly connectionId: number };

export interface ChurnOptions {
  readonly seed: number;
  readonly operationCount: number;
  readonly addRatio?: number;
}

export const generateChurnScript = (graph: ChainGraph, options: ChurnOptions): readonly ChurnOperation[] => {
  const { seed, operationCount, addRatio = 0.5 } = options;
  const rng = createPrng(seed);
  const live = graph.connections.map((c) => c.id);
  let nextId = graph.connections.reduce((max, c) => Math.max(max, c.id), 0) + 1;
  let clock = graph.connections.reduce((max, c) => Math.max(max, c.createdAt), 0) + 1;
  const operations: ChurnOperation[] = [];
  const pickSystem = (): number => graph.systems[rng.int(graph.systems.length)]?.id as number;
  const pickOtherSystem = (excluded: number): number => {
    const index = graph.systems.findIndex((s) => s.id === excluded);
    const offset = 1 + rng.int(Math.max(1, graph.systems.length - 1));
    return graph.systems[(index + offset) % graph.systems.length]?.id as number;
  };

  for (let i = 0; i < operationCount; i += 1) {
    const mustAdd = live.length === 0 || i === 0;
    const mustRemove = !mustAdd && i === 1;
    if (mustAdd || (!mustRemove && rng.chance(addRatio))) {
      const endA = pickSystem();
      const endB = rng.chance(0.15) ? null : pickOtherSystem(endA);
      const connection: ChainConnection = { id: nextId++, createdAt: clock++, endA, endB };
      live.push(connection.id);
      operations.push({ kind: 'add', connection });
    } else {
      const [removed] = live.splice(rng.int(live.length), 1);
      operations.push({ kind: 'remove', connectionId: removed as number });
    }
  }
  return operations;
};

export const applyChurn = (graph: ChainGraph, operations: readonly ChurnOperation[]): ChainGraph => {
  let connections = [...graph.connections];
  for (const operation of operations) {
    connections =
      operation.kind === 'add'
        ? [...connections, operation.connection]
        : connections.filter((c) => c.id !== operation.connectionId);
  }
  return { systems: graph.systems, connections };
};
