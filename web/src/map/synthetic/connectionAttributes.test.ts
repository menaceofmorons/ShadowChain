import { describe, expect, it } from 'vitest';
import { generateChain, generateChurnScript } from './index';

const hashText = (text: string): string => {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) h = Math.imul(h ^ text.charCodeAt(i), 16777619) >>> 0;
  return h.toString(16);
};

const SHAPE_FINGERPRINTS: Record<string, readonly [string, string]> = {
  '7,50': ['f35dfe5', 'd5de5c3d'],
  '7,150': ['5ec888f3', '90dd2574'],
  '7,250': ['c9d746dd', 'de8ac279'],
  '7,500': ['bac5ef2f', '5b93590'],
  '8,50': ['ad16521', 'a68676a6'],
  '8,150': ['32b7bc4d', '2d2c9ce2'],
  '8,250': ['2a55dd00', '97e45867'],
  '8,500': ['f1481c38', 'ced518ac'],
};

describe('connection attributes', () => {
  it.each(Object.entries(SHAPE_FINGERPRINTS))('keeps the graph and churn shape for seed,size %s', (key, expected) => {
    const [seed, nodeCount] = key.split(',').map(Number) as [number, number];
    const graph = generateChain({ nodeCount, seed });
    const shape = graph.connections.map((c) => `${c.id}:${c.createdAt}:${c.endA}:${c.endB}`).join('|');
    const operations = generateChurnScript(graph, { seed, operationCount: 40 });
    const churnShape = operations
      .map((o) =>
        o.kind === 'add'
          ? `a${o.connection.id}:${o.connection.createdAt}:${o.connection.endA}:${o.connection.endB}`
          : `r${o.connectionId}`,
      )
      .join('|');
    expect([hashText(shape), hashText(churnShape)]).toEqual(expected);
  });

  it('is deterministic per seed and differs between seeds', () => {
    const a = generateChain({ nodeCount: 150, seed: 7 });
    expect(generateChain({ nodeCount: 150, seed: 7 })).toEqual(a);
    const attrs = (g: typeof a): string => g.connections.map((c) => `${c.massStatus}${c.lifeStage}${c.size}`).join();
    expect(attrs(generateChain({ nodeCount: 150, seed: 8 }))).not.toBe(attrs(a));
  });

  it('assigns every value at 150 nodes', () => {
    const { connections } = generateChain({ nodeCount: 150, seed: 7 });
    expect(new Set(connections.map((c) => c.massStatus))).toEqual(new Set(['fresh', 'reduced', 'critical']));
    expect(new Set(connections.map((c) => c.lifeStage))).toEqual(new Set([1, 2, 3, 4]));
    expect(new Set(connections.map((c) => c.size))).toEqual(
      new Set(['small', 'medium', 'large', 'freighter', 'capital', 'unknown']),
    );
  });

  it('gives churn additions attributes deterministically', () => {
    const graph = generateChain({ nodeCount: 150, seed: 7 });
    const run = (): ReturnType<typeof generateChurnScript> =>
      generateChurnScript(graph, { seed: 7, operationCount: 60 });
    expect(run()).toEqual(run());
    const added = run().flatMap((o) => (o.kind === 'add' ? [o.connection] : []));
    expect(added.length).toBeGreaterThan(0);
    for (const c of added) {
      expect(c.massStatus).toBeDefined();
      expect(c.lifeStage).toBeDefined();
      expect(c.size).toBeDefined();
    }
  });
});
