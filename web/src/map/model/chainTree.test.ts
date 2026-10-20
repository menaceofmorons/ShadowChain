import { describe, expect, it } from 'vitest';
import { buildChainTree } from './chainTree';
import { aliasKey, parseNodeKey, serialiseNodeKey, systemKey, unknownEndKey } from './nodeKey';
import type { ChainConnection, ChainNode } from './types';

const conn = (id: number, createdAt: number, endA: number, endB: number | null): ChainConnection => ({
  id,
  createdAt,
  endA,
  endB,
});

const build = (systemIds: number[], connections: ChainConnection[], root = systemIds[0] as number) =>
  buildChainTree({ systems: systemIds.map((id) => ({ id })), connections }, root);

const shape = (node: ChainNode): unknown => [node.keyString, node.children.map(shape)];

describe('buildChainTree', () => {
  it('builds a linear chain', () => {
    const tree = build([1, 2, 3], [conn(10, 1, 1, 2), conn(11, 2, 2, 3)]);
    expect(shape(tree.root)).toEqual(['s:1', [['s:2', [['s:3', []]]]]]);
    expect(tree.nodes.map((n) => n.keyString)).toEqual(['s:1', 's:2', 's:3']);
  });

  it('branches and orders children by creation time then id', () => {
    const tree = build([1, 2, 3, 4], [conn(12, 5, 1, 4), conn(10, 5, 1, 2), conn(11, 3, 3, 1)]);
    expect(tree.root.children.map((n) => n.keyString)).toEqual(['s:3', 's:2', 's:4']);
  });

  it('keeps a loop as primary plus an alias leaf keyed by its attaching connection', () => {
    const tree = build([1, 2, 3], [conn(10, 1, 1, 2), conn(11, 2, 2, 3), conn(12, 3, 3, 1)]);
    expect(shape(tree.root)).toEqual([
      's:1',
      [
        ['s:2', [['a:3:11', []]]],
        ['s:3', []],
      ],
    ]);
    const alias = (tree.root.children[0] as ChainNode).children[0] as ChainNode;
    expect(alias.kind).toBe('alias');
    expect(alias.children).toEqual([]);
  });

  it('gives a tie in distance to the older connection', () => {
    const connections = [conn(10, 1, 1, 2), conn(11, 2, 1, 3), conn(13, 4, 3, 4), conn(12, 3, 2, 4)];
    const tree = build([1, 2, 3, 4], connections);
    const two = tree.root.children[0] as ChainNode;
    const three = tree.root.children[1] as ChainNode;
    expect(shape(two)).toEqual(['s:2', [['s:4', []]]]);
    expect(shape(three)).toEqual(['s:3', [['a:4:13', []]]]);
  });

  it('promotes the next occurrence to primary when the primary connection is removed', () => {
    const all = [conn(10, 1, 1, 2), conn(11, 2, 1, 3), conn(12, 3, 2, 4), conn(13, 4, 3, 4)];
    expect(shape(build([1, 2, 3, 4], all).root)).toEqual([
      's:1',
      [
        ['s:2', [['s:4', []]]],
        ['s:3', [['a:4:13', []]]],
      ],
    ]);
    const without = all.filter((c) => c.id !== 12);
    expect(shape(build([1, 2, 3, 4], without).root)).toEqual([
      's:1',
      [
        ['s:2', []],
        ['s:3', [['s:4', []]]],
      ],
    ]);
  });

  it('adds parallel connections as edges without nodes; the first is the tree edge', () => {
    const tree = build([1, 2], [conn(12, 3, 2, 1), conn(10, 1, 1, 2), conn(11, 2, 1, 2)]);
    expect(tree.nodes).toHaveLength(2);
    expect(tree.root.children[0]?.parentEdge).toEqual({
      connectionId: 10,
      parallelConnectionIds: [11, 12],
    });
  });

  it('makes an alias with parallel connections one node keyed by the first connection', () => {
    const tree = build([1, 2, 3], [conn(10, 1, 1, 2), conn(11, 2, 1, 3), conn(12, 3, 2, 3), conn(13, 4, 3, 2)]);
    const two = tree.root.children[0] as ChainNode;
    expect(two.children).toHaveLength(1);
    expect(two.children[0]?.parentEdge).toEqual({ connectionId: 12, parallelConnectionIds: [13] });
    expect(tree.nodes.map((n) => n.keyString)).toEqual(['s:1', 's:2', 'a:3:12', 's:3']);
  });

  it('keys an unknown far end by connection id', () => {
    const tree = build([1, 2], [conn(10, 1, 1, 2), conn(20, 2, 2, null), conn(21, 3, 1, null)]);
    const unknowns = tree.nodes.filter((n) => n.kind === 'unknownEnd');
    expect(unknowns.map((n) => n.keyString)).toEqual(['u:20', 'u:21']);
    expect(unknowns.every((n) => n.systemId === null && n.children.length === 0)).toBe(true);
  });

  it('appends new connections after existing siblings', () => {
    const before = [conn(10, 1, 1, 2), conn(11, 2, 1, 3)];
    const after = [...before, conn(12, 3, 1, 4)];
    const kids = (c: ChainConnection[]) => build([1, 2, 3, 4], c).root.children.map((n) => n.keyString);
    expect(kids(before)).toEqual(['s:2', 's:3']);
    expect(kids(after)).toEqual(['s:2', 's:3', 's:4']);
  });

  it('produces identical trees and keys for the same input regardless of input order', () => {
    const connections = [conn(10, 1, 1, 2), conn(11, 2, 2, 3), conn(12, 3, 3, 1), conn(13, 4, 2, null)];
    const a = build([1, 2, 3], connections);
    const b = build([1, 2, 3], [...connections].reverse());
    expect(a).toEqual(b);
  });

  it('contains no layout, position or style fields', () => {
    const tree = build([1, 2], [conn(10, 1, 1, 2)]);
    expect(Object.keys(tree.root).sort()).toEqual(
      ['children', 'key', 'keyString', 'kind', 'parentEdge', 'systemId'].sort(),
    );
  });

  it('rejects a root that is not in the graph', () => {
    expect(() => build([1], [], 9)).toThrow();
  });
});

describe('node keys', () => {
  it.each([systemKey(5), aliasKey(5, 9), unknownEndKey(9)])('round-trips %j', (key) => {
    expect(parseNodeKey(serialiseNodeKey(key))).toEqual(key);
  });

  it('never reuses a system id string for an unknown end', () => {
    expect(serialiseNodeKey(unknownEndKey(5))).not.toBe(serialiseNodeKey(systemKey(5)));
  });

  it.each(['', 's:', 'x:1', 'a:1', 'u:-1'])('rejects %j', (text) => {
    expect(() => parseNodeKey(text)).toThrow();
  });
});
