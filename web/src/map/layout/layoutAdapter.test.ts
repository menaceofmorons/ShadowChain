import { describe, expect, it } from 'vitest';
import { buildChainTree } from '../model/chainTree';
import type { ChainConnection } from '../model/types';
import { createLayoutAdapter } from './layoutAdapter';
import { createMemoryChannel } from './transport';
import { createWorkerHost } from './workerHost';
import { createStubEngine } from './testing/stubEngine';
import { LayoutError } from './types';
import type {
  LayoutEngine,
  LayoutRequest,
  LayoutRequestMessage,
  LayoutResponseMessage,
  PlacedNode,
} from './types';

const conn = (id: number, createdAt: number, endA: number, endB: number): ChainConnection => ({
  id,
  createdAt,
  endA,
  endB,
});

const treeOf = (systemIds: number[], connections: ChainConnection[]) =>
  buildChainTree({ systems: systemIds.map((id) => ({ id })), connections }, 1);

const tree = treeOf([1, 2, 3], [conn(10, 1, 1, 2), conn(11, 2, 1, 3)]);

const fullRequest = (manual: LayoutRequest['manualPositions'] = []): LayoutRequest => ({
  type: 'full',
  tree,
  mode: 'top-down',
  manualPositions: manual,
});

function connect(engine: LayoutEngine) {
  const channel = createMemoryChannel<LayoutRequestMessage, LayoutResponseMessage>();
  createWorkerHost(engine, channel.b);
  return createLayoutAdapter(channel.a);
}

const byKey = (nodes: readonly PlacedNode[]) => new Map(nodes.map((n) => [n.nodeKey, n]));

describe('layout adapter', () => {
  it('round-trips a full request for every mode', async () => {
    const adapter = connect(createStubEngine());
    for (const mode of ['top-down', 'left-to-right', 'radial'] as const) {
      const nodes = await adapter.layout({ ...fullRequest(), mode });
      expect(nodes.map((n) => n.nodeKey).sort()).toEqual(['s:1', 's:2', 's:3']);
      expect(nodes.every((n) => n.source === 'auto' && !n.alias)).toBe(true);
    }
  });

  it('round-trips an incremental request keeping placed nodes and dropping removed ones', async () => {
    const adapter = connect(createStubEngine());
    const previous = await adapter.layout(fullRequest());
    const moved = previous.map((n) => (n.nodeKey === 's:2' ? { ...n, x: 999 } : n));
    const nodes = await adapter.layout({
      type: 'incremental',
      tree: treeOf([1, 2], [conn(10, 1, 1, 2)]),
      mode: 'top-down',
      manualPositions: [],
      previous: moved,
      addedNodeKeys: [],
      removedNodeKeys: ['s:3'],
    });
    expect(nodes.map((n) => n.nodeKey).sort()).toEqual(['s:1', 's:2']);
    expect(byKey(nodes).get('s:2')?.x).toBe(999);
  });

  it('places added nodes in an incremental request', async () => {
    const adapter = connect(createStubEngine());
    const previous = (await adapter.layout(fullRequest())).filter((n) => n.nodeKey !== 's:3');
    const nodes = await adapter.layout({
      type: 'incremental',
      tree,
      mode: 'top-down',
      manualPositions: [],
      previous,
      addedNodeKeys: ['s:3'],
      removedNodeKeys: [],
    });
    expect(byKey(nodes).has('s:3')).toBe(true);
  });

  it('resolves concurrent requests to their own responses', async () => {
    const adapter = connect(createStubEngine());
    const [a, b] = await Promise.all([
      adapter.layout({ ...fullRequest(), mode: 'top-down' }),
      adapter.layout({ ...fullRequest(), mode: 'left-to-right' }),
    ]);
    expect(byKey(a).get('s:2')).toMatchObject({ x: 0, y: 100 });
    expect(byKey(b).get('s:2')).toMatchObject({ x: 100, y: 0 });
  });

  it('echoes manual positions with source manual', async () => {
    const adapter = connect(createStubEngine());
    const nodes = await adapter.layout(fullRequest([{ nodeKey: 's:3', x: 5, y: 6 }]));
    expect(byKey(nodes).get('s:3')).toMatchObject({ x: 5, y: 6, source: 'manual' });
    expect(byKey(nodes).get('s:2')?.source).toBe('auto');
  });

  it('swaps the engine with no consumer change', async () => {
    const consume = (engine: LayoutEngine) => connect(engine).layout(fullRequest());
    const first = await consume(createStubEngine());
    const second = await consume(createStubEngine({ offset: 7 }));
    expect(byKey(first).get('s:1')).toMatchObject({ x: 0, y: 0 });
    expect(byKey(second).get('s:1')).toMatchObject({ x: 7, y: 7 });
  });

  it('flags alias nodes', async () => {
    const loop = treeOf([1, 2, 3], [conn(10, 1, 1, 2), conn(11, 2, 1, 3), conn(12, 3, 2, 3)]);
    const nodes = await connect(createStubEngine()).layout({ ...fullRequest(), tree: loop });
    expect(nodes.filter((n) => n.alias)).toHaveLength(1);
  });

  it('rejects malformed requests with a typed error', async () => {
    const adapter = connect(createStubEngine());
    const badMode = { ...fullRequest(), mode: 'spiral' } as unknown as LayoutRequest;
    await expect(adapter.layout(badMode)).rejects.toBeInstanceOf(LayoutError);
    await expect(adapter.layout(badMode)).rejects.toMatchObject({ code: 'malformed-request' });
    const noType = { tree } as unknown as LayoutRequest;
    await expect(adapter.layout(noType)).rejects.toMatchObject({ code: 'malformed-request' });
    const badIncremental = { ...fullRequest(), type: 'incremental' } as unknown as LayoutRequest;
    await expect(adapter.layout(badIncremental)).rejects.toMatchObject({ code: 'malformed-request' });
  });

  it('reports engine failures as typed errors', async () => {
    const adapter = connect({
      layout: () => {
        throw new Error('boom');
      },
    });
    await expect(adapter.layout(fullRequest())).rejects.toMatchObject({
      code: 'engine-failure',
      message: 'boom',
    });
  });

  it('rejects all pending requests when the endpoint reports an error', async () => {
    let fail: (reason: string) => void = () => undefined;
    const adapter = createLayoutAdapter({
      post: () => undefined,
      onMessage: () => undefined,
      onError: (handler) => {
        fail = handler;
      },
    });
    const first = adapter.layout(fullRequest());
    const second = adapter.layout(fullRequest());
    fail('worker crashed');
    await expect(first).rejects.toMatchObject({ code: 'engine-failure', message: 'worker crashed' });
    await expect(second).rejects.toMatchObject({ code: 'engine-failure', message: 'worker crashed' });
  });
});
