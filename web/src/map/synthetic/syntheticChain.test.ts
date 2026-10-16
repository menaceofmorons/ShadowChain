import { describe, expect, it } from 'vitest';
import { buildChainTree } from '../model/chainTree';
import { applyChurn, generateChain, generateChurnScript, SYNTHETIC_NODE_COUNTS, SYNTHETIC_ROOT_SYSTEM_ID } from './index';

describe.each(SYNTHETIC_NODE_COUNTS)('generateChain(%i)', (nodeCount) => {
  const graph = generateChain({ nodeCount, seed: 7 });

  it('has the exact node count and builds a tree', () => {
    expect(graph.systems).toHaveLength(nodeCount);
    const tree = buildChainTree(graph, SYNTHETIC_ROOT_SYSTEM_ID);
    const systemsInTree = new Set(tree.nodes.filter((n) => n.systemId !== null).map((n) => n.systemId));
    expect(systemsInTree.size).toBe(nodeCount);
  });

  it('contains loops, parallel edges and unknown far ends', () => {
    const pairs = new Map<string, number>();
    let unknown = 0;
    for (const c of graph.connections) {
      if (c.endB === null) {
        unknown += 1;
        continue;
      }
      const key = [c.endA, c.endB].sort((a, b) => a - b).join('-');
      pairs.set(key, (pairs.get(key) ?? 0) + 1);
    }
    expect(unknown).toBeGreaterThan(0);
    expect([...pairs.values()].some((n) => n > 1)).toBe(true);
    expect(pairs.size).toBeGreaterThan(nodeCount - 1);
    const tree = buildChainTree(graph, SYNTHETIC_ROOT_SYSTEM_ID);
    expect(tree.nodes.some((n) => n.kind === 'alias')).toBe(true);
    expect(tree.nodes.some((n) => n.kind === 'unknownEnd')).toBe(true);
  });

  it('is deterministic per seed and differs across seeds', () => {
    expect(JSON.stringify(generateChain({ nodeCount, seed: 7 }))).toBe(JSON.stringify(graph));
    expect(JSON.stringify(generateChain({ nodeCount, seed: 8 }))).not.toBe(JSON.stringify(graph));
  });

  it('replays churn keeping endpoints valid with adds and removes', () => {
    const script = generateChurnScript(graph, { seed: 3, operationCount: 200 });
    expect(JSON.stringify(generateChurnScript(graph, { seed: 3, operationCount: 200 }))).toBe(JSON.stringify(script));
    expect(JSON.stringify(generateChurnScript(graph, { seed: 4, operationCount: 200 }))).not.toBe(JSON.stringify(script));
    expect(script.some((o) => o.kind === 'add')).toBe(true);
    expect(script.some((o) => o.kind === 'remove')).toBe(true);
    const result = applyChurn(graph, script);
    const ids = new Set(result.systems.map((s) => s.id));
    const connectionIds = result.connections.map((c) => c.id);
    expect(new Set(connectionIds).size).toBe(connectionIds.length);
    for (const c of result.connections) {
      expect(ids.has(c.endA)).toBe(true);
      expect(c.endB === null || ids.has(c.endB)).toBe(true);
    }
    expect(() => buildChainTree(result, SYNTHETIC_ROOT_SYSTEM_ID)).not.toThrow();
  });
});

describe('generateChain validation', () => {
  it('rejects tiny node counts', () => {
    expect(() => generateChain({ nodeCount: 2, seed: 1 })).toThrow();
  });
});
