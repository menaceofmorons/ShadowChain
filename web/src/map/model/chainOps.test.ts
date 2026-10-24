import { describe, expect, it } from 'vitest';
import { applyChurn, generateChain, generateChurnScript } from '../synthetic';
import { collapseChainTree, disconnectedSystemIds, removeConnectionFromTree, removeConnections } from './chainOps';
import { buildChainTree } from './chainTree';
import { collapsedKey, parseNodeKey, serialiseNodeKey, systemKey } from './nodeKey';
import type { ChainConnection, ChainGraph, ChainNode, ChainTree } from './types';

const conn = (id: number, createdAt: number, endA: number, endB: number | null): ChainConnection => ({
  id,
  createdAt,
  endA,
  endB,
});

const graphOf = (systemIds: number[], connections: ChainConnection[]): ChainGraph => ({
  systems: systemIds.map((id) => ({ id })),
  connections,
});

const shape = (node: ChainNode): unknown => [node.keyString, node.children.map(shape)];
const keys = (tree: ChainTree): string[] => tree.nodes.map((n) => n.keyString);

describe('removal', () => {
  it('drops a single path and every descendant reachable only through it', () => {
    const graph = graphOf([1, 2, 3, 4], [conn(10, 1, 1, 2), conn(11, 2, 2, 3), conn(12, 3, 3, 4)]);
    expect(keys(removeConnectionFromTree(graph, 1, [11]))).toEqual(['s:1', 's:2']);
  });

  it('keeps a node reachable through another connection and re-parents it', () => {
    const graph = graphOf([1, 2, 3, 4], [conn(10, 1, 1, 2), conn(11, 2, 2, 3), conn(12, 3, 1, 4), conn(13, 4, 4, 3)]);
    expect(shape(buildChainTree(graph, 1).root)).toEqual([
      's:1',
      [
        ['s:2', [['s:3', []]]],
        ['s:4', [['a:3:13', []]]],
      ],
    ]);
    const after = removeConnectionFromTree(graph, 1, [11]);
    expect(shape(after.root)).toEqual([
      's:1',
      [
        ['s:2', []],
        ['s:4', [['s:3', []]]],
      ],
    ]);
  });

  it('promotes an alias to primary when the primary connection is removed', () => {
    const graph = graphOf([1, 2, 3, 4], [conn(10, 1, 1, 2), conn(11, 2, 1, 3), conn(12, 3, 2, 4), conn(13, 4, 3, 4)]);
    const after = removeConnectionFromTree(graph, 1, [12]);
    const four = after.nodes.find((n) => n.systemId === 4);
    expect(four?.kind).toBe('primary');
    expect(four?.keyString).toBe('s:4');
    expect(four?.parentEdge?.connectionId).toBe(13);
    expect(after.nodes.filter((n) => n.kind === 'alias')).toEqual([]);
  });

  it('removes a whole chain of descendants', () => {
    const graph = graphOf(
      [1, 2, 3, 4, 5],
      [conn(10, 1, 1, 2), conn(11, 2, 2, 3), conn(12, 3, 3, 4), conn(13, 4, 4, 5)],
    );
    expect(keys(removeConnectionFromTree(graph, 1, [10]))).toEqual(['s:1']);
  });

  it('handles a root-adjacent removal that leaves only the root', () => {
    const graph = graphOf([1, 2], [conn(10, 1, 1, 2)]);
    expect(keys(removeConnectionFromTree(graph, 1, [10]))).toEqual(['s:1']);
  });

  it('keeps the node when a parallel connection remains', () => {
    const graph = graphOf([1, 2], [conn(10, 1, 1, 2), conn(11, 2, 1, 2)]);
    const after = removeConnectionFromTree(graph, 1, [10]);
    expect(keys(after)).toEqual(['s:1', 's:2']);
    expect(after.root.children[0]?.parentEdge?.connectionId).toBe(11);
  });

  it('removes an unknown-end leaf with its connection', () => {
    const graph = graphOf([1], [conn(10, 1, 1, null)]);
    expect(keys(buildChainTree(graph, 1))).toEqual(['s:1', 'u:10']);
    expect(keys(removeConnectionFromTree(graph, 1, [10]))).toEqual(['s:1']);
  });

  it('does not mutate the input graph', () => {
    const graph = graphOf([1, 2], [conn(10, 1, 1, 2)]);
    removeConnections(graph, [10]);
    expect(graph.connections).toHaveLength(1);
  });
});

describe('disconnection (systems not reachable from the root are not in the tree)', () => {
  it('excludes unreachable systems without throwing and reports them', () => {
    const graph = graphOf([1, 2, 3, 4], [conn(10, 1, 1, 2), conn(11, 3, 3, 4)]);
    const tree = buildChainTree(graph, 1);
    expect(keys(tree)).toEqual(['s:1', 's:2']);
    expect(disconnectedSystemIds(graph, tree)).toEqual([3, 4]);
  });

  it('treats a system cut off by removal as disconnected', () => {
    const graph = graphOf([1, 2, 3], [conn(10, 1, 1, 2), conn(11, 2, 2, 3)]);
    const after = removeConnections(graph, [10]);
    const tree = buildChainTree(after, 1);
    expect(disconnectedSystemIds(after, tree)).toEqual([2, 3]);
  });

  it('keeps tree and disconnected set a partition of all systems under churn', () => {
    for (const seed of [1, 2, 3, 7]) {
      const graph = generateChain({ nodeCount: 150, seed });
      const churned = applyChurn(graph, generateChurnScript(graph, { seed, operationCount: 60, addRatio: 0.3 }));
      const tree = buildChainTree(churned, 1);
      const inTree = tree.nodes.filter((n) => n.kind === 'primary').map((n) => n.systemId as number);
      const out = disconnectedSystemIds(churned, tree);
      expect(new Set(inTree).size).toBe(inTree.length);
      expect([...inTree, ...out].sort((a, b) => a - b)).toEqual(churned.systems.map((s) => s.id));
    }
  });
});

describe('collapse', () => {
  const graph = graphOf(
    [1, 2, 3, 4, 5],
    [
      conn(10, 1, 1, 2),
      conn(11, 2, 1, 3),
      conn(12, 3, 2, 4),
      conn(13, 4, 3, 4),
      conn(14, 5, 4, 5),
      conn(15, 6, 3, null),
    ],
  );
  const full = buildChainTree(graph, 1);
  const hiddenOf = (tree: ChainTree): number | null | undefined =>
    tree.nodes.find((n) => n.kind === 'collapsed')?.hiddenCount;

  it('builds the expected fixture tree', () => {
    expect(shape(full.root)).toEqual([
      's:1',
      [
        ['s:2', [['s:4', [['s:5', []]]]]],
        [
          's:3',
          [
            ['a:4:13', []],
            ['u:15', []],
          ],
        ],
      ],
    ]);
  });

  it('replaces descendants with one +N leaf counting every hidden node', () => {
    const tree = collapseChainTree(full, new Set(['s:2']));
    expect(shape(tree.root)).toEqual([
      's:1',
      [
        ['s:2', [['+:s:2', []]]],
        [
          's:3',
          [
            ['a:4:13', []],
            ['u:15', []],
          ],
        ],
      ],
    ]);
    expect(hiddenOf(tree)).toBe(2);
  });

  it('counts primaries, aliases and unknown ends once each', () => {
    const tree = collapseChainTree(full, new Set(['s:1']));
    expect(shape(tree.root)).toEqual(['s:1', [['+:s:1', []]]]);
    expect(hiddenOf(tree)).toBe(6);
    const branch = collapseChainTree(full, new Set(['s:3']));
    expect(hiddenOf(branch)).toBe(2);
  });

  it('lets the outer collapse win for nested collapsed nodes', () => {
    const tree = collapseChainTree(full, new Set(['s:2', 's:4']));
    expect(tree.nodes.filter((n) => n.kind === 'collapsed')).toHaveLength(1);
    expect(hiddenOf(tree)).toBe(2);
  });

  it('collapses an inner node on its own', () => {
    const tree = collapseChainTree(full, new Set(['s:4']));
    expect(hiddenOf(tree)).toBe(1);
    expect(tree.nodes.some((n) => n.keyString === 's:5')).toBe(false);
    expect(tree.nodes.some((n) => n.keyString === 's:3')).toBe(true);
  });

  it('adds nothing when collapsing an alias or a leaf', () => {
    const tree = collapseChainTree(full, new Set(['a:4:13', 'u:15', 's:5']));
    expect(keys(tree)).toEqual(keys(full));
  });

  it('counts an alias whose primary is outside the collapsed subtree', () => {
    const loop = graphOf([1, 2, 3], [conn(10, 1, 1, 2), conn(11, 2, 1, 3), conn(12, 3, 2, 3)]);
    const tree = collapseChainTree(buildChainTree(loop, 1), new Set(['s:2']));
    expect(shape(tree.root)).toEqual([
      's:1',
      [
        ['s:2', [['+:s:2', []]]],
        ['s:3', []],
      ],
    ]);
    expect(tree.nodes.find((n) => n.kind === 'collapsed')?.hiddenCount).toBe(1);
  });

  it('keeps the full tree intact and the key stable', () => {
    const before = keys(full);
    const a = collapseChainTree(full, new Set(['s:2']));
    const b = collapseChainTree(full, new Set(['s:2']));
    expect(keys(full)).toEqual(before);
    expect(keys(a)).toEqual(keys(b));
  });

  it('returns the tree unchanged for an empty set', () => {
    expect(collapseChainTree(full, new Set())).toBe(full);
  });

  it('round-trips the +N key form', () => {
    const key = collapsedKey(systemKey(7));
    expect(serialiseNodeKey(key)).toBe('+:s:7');
    expect(parseNodeKey('+:s:7')).toEqual(key);
    expect(() => parseNodeKey('+:+:s:7')).toThrow();
  });

  it('keeps hidden counts consistent on generated chains', () => {
    const generated = buildChainTree(generateChain({ nodeCount: 150, seed: 5 }), 1);
    const target = generated.root.children[0] as ChainNode;
    const collapsed = collapseChainTree(generated, new Set([target.keyString]));
    const leaf = collapsed.nodes.find((n) => n.kind === 'collapsed');
    expect(generated.nodes.length - collapsed.nodes.length + 1).toBe(leaf?.hiddenCount ?? 1);
  });
});
