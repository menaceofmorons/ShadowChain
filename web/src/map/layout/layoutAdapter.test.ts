import { describe, expect, it, vi } from 'vitest';
import { buildChainTree } from '../model/chainTree';
import type { ChainConnection } from '../model/types';
import { createLayoutAdapter } from './layoutAdapter';
import { createMemoryChannel, endpointFromWorker } from './transport';
import type { Endpoint, WorkerLike } from './transport';
import { validateRequest } from './validateRequest';
import { createWorkerHost } from './workerHost';
import { createStubEngine } from './testing/stubEngine';
import { LayoutError } from './types';
import type { LayoutEngine, LayoutRequest, LayoutRequestMessage, LayoutResponseMessage, PlacedNode } from './types';

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

function fakeEndpoint() {
  let onMessage: (message: LayoutResponseMessage) => void = () => undefined;
  let onError: (reason: string) => void = () => undefined;
  let onMessageError: (reason: string) => void = () => undefined;
  const posted: LayoutRequestMessage[] = [];
  const endpoint: Endpoint<LayoutRequestMessage, LayoutResponseMessage> = {
    post: (message) => {
      posted.push(message);
    },
    onMessage: (handler) => {
      onMessage = handler;
    },
    onError: (handler) => {
      onError = handler;
    },
    onMessageError: (handler) => {
      onMessageError = handler;
    },
  };
  return {
    endpoint,
    posted,
    respond: (message: LayoutResponseMessage) => {
      onMessage(message);
    },
    fail: (reason: string) => {
      onError(reason);
    },
    messageError: (reason: string) => {
      onMessageError(reason);
    },
  };
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
    const fake = fakeEndpoint();
    const adapter = createLayoutAdapter(fake.endpoint);
    const first = adapter.layout(fullRequest());
    const second = adapter.layout(fullRequest());
    fake.fail('worker crashed');
    await expect(first).rejects.toMatchObject({ code: 'engine-failure', message: 'worker crashed' });
    await expect(second).rejects.toMatchObject({ code: 'engine-failure', message: 'worker crashed' });
  });

  it('rejects every later call immediately after a fatal error', async () => {
    const fake = fakeEndpoint();
    const adapter = createLayoutAdapter(fake.endpoint);
    fake.fail('worker crashed');
    await expect(adapter.layout(fullRequest())).rejects.toMatchObject({ code: 'engine-failure' });
    await expect(adapter.layout(fullRequest())).rejects.toMatchObject({ code: 'engine-failure' });
    expect(fake.posted).toHaveLength(0);
  });

  it('rejects pending requests on messageerror but stays usable', async () => {
    const fake = fakeEndpoint();
    const adapter = createLayoutAdapter(fake.endpoint);
    const first = adapter.layout(fullRequest());
    fake.messageError('bad clone');
    await expect(first).rejects.toMatchObject({ code: 'engine-failure', message: 'bad clone' });
    const second = adapter.layout(fullRequest());
    fake.respond({ id: 2, ok: true, nodes: [] });
    await expect(second).resolves.toEqual([]);
  });

  it('rejects only its own request when a response reports an engine failure', async () => {
    const fake = fakeEndpoint();
    const adapter = createLayoutAdapter(fake.endpoint);
    const first = adapter.layout(fullRequest());
    const second = adapter.layout(fullRequest());
    fake.respond({ id: 1, ok: false, error: { code: 'engine-failure', message: 'nope' } });
    fake.respond({ id: 2, ok: true, nodes: [] });
    await expect(first).rejects.toMatchObject({ code: 'engine-failure', message: 'nope' });
    await expect(second).resolves.toEqual([]);
  });

  it('times out a request with a LayoutError and ignores a late response', async () => {
    vi.useFakeTimers();
    try {
      const fake = fakeEndpoint();
      const adapter = createLayoutAdapter(fake.endpoint, { timeoutMs: 50 });
      const result = adapter.layout(fullRequest());
      const assertion = expect(result).rejects.toMatchObject({ code: 'engine-failure' });
      await vi.advanceTimersByTimeAsync(50);
      await assertion;
      fake.respond({ id: 1, ok: true, nodes: [] });
      const next = adapter.layout(fullRequest());
      fake.respond({ id: 2, ok: true, nodes: [] });
      await expect(next).resolves.toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not time out a request that is answered in time', async () => {
    vi.useFakeTimers();
    try {
      const fake = fakeEndpoint();
      const adapter = createLayoutAdapter(fake.endpoint, { timeoutMs: 50 });
      const result = adapter.layout(fullRequest());
      fake.respond({ id: 1, ok: true, nodes: [] });
      await expect(result).resolves.toEqual([]);
      await vi.advanceTimersByTimeAsync(100);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ['not an object', 'nope'],
    ['ok without nodes', { id: 1, ok: true }],
    ['non-finite x', { id: 1, ok: true, nodes: [{ nodeKey: 'a', x: Infinity, y: 0, source: 'auto', alias: false }] }],
    ['numeric nodeKey', { id: 1, ok: true, nodes: [{ nodeKey: 1, x: 0, y: 0, source: 'auto', alias: false }] }],
    ['bad source', { id: 1, ok: true, nodes: [{ nodeKey: 'a', x: 0, y: 0, source: 'x', alias: false }] }],
    ['missing alias', { id: 1, ok: true, nodes: [{ nodeKey: 'a', x: 0, y: 0, source: 'auto' }] }],
    ['failure without error', { id: 1, ok: false }],
  ])('rejects an invalid response (%s) with engine-failure', async (label, response) => {
    const fake = fakeEndpoint();
    const adapter = createLayoutAdapter(fake.endpoint);
    const result = adapter.layout(fullRequest());
    fake.respond(response as unknown as LayoutResponseMessage);
    if (label === 'not an object') {
      fake.respond({ id: 1, ok: true, nodes: [] });
      await expect(result).resolves.toEqual([]);
    } else {
      await expect(result).rejects.toMatchObject({ code: 'engine-failure' });
    }
  });

  it('ignores a response envelope with no usable id', async () => {
    const fake = fakeEndpoint();
    const adapter = createLayoutAdapter(fake.endpoint);
    const result = adapter.layout(fullRequest());
    fake.respond({ ok: true, nodes: [] } as unknown as LayoutResponseMessage);
    fake.respond({ id: 1, ok: true, nodes: [] });
    await expect(result).resolves.toEqual([]);
  });
});

describe('request validation', () => {
  const nodeOf = (key: string, children: unknown[] = [], parentEdge: unknown = {}) => ({
    keyString: key,
    children,
    parentEdge,
  });
  const placed = (key: string) => ({ nodeKey: key, x: 0, y: 0, source: 'auto', alias: false });
  const good = () => {
    const child = nodeOf('b');
    const root = nodeOf('a', [child], null);
    return { root, nodes: [root, child] };
  };
  const full = (tree: unknown, manualPositions: unknown[] = []) => ({
    type: 'full',
    mode: 'top-down',
    tree,
    manualPositions,
  });
  const incremental = (extra: Record<string, unknown>) => ({
    ...full(good()),
    type: 'incremental',
    previous: [placed('a')],
    addedNodeKeys: ['b'],
    removedNodeKeys: [],
    ...extra,
  });

  it('accepts a consistent request', () => {
    expect(() => validateRequest(full(good()))).not.toThrow();
    expect(() => validateRequest(incremental({}))).not.toThrow();
  });

  it.each<[string, () => unknown]>([
    [
      'duplicate node keys',
      () => {
        const t = good();
        return full({ root: t.root, nodes: [...t.nodes, nodeOf('b')] });
      },
    ],
    [
      'child not in nodes',
      () => {
        const root = nodeOf('a', [nodeOf('z')], null);
        return full({ root, nodes: [root] });
      },
    ],
    [
      'root not in nodes',
      () => {
        const t = good();
        return full({ root: nodeOf('q', [], null), nodes: t.nodes });
      },
    ],
    [
      'two roots',
      () => {
        const a = nodeOf('a', [], null);
        const b = nodeOf('b', [], null);
        return full({ root: a, nodes: [a, b] });
      },
    ],
    ['node without keyString', () => full({ root: { children: [] }, nodes: [{ children: [] }] })],
    ['manual position for unknown node', () => full(good(), [{ nodeKey: 'zz', x: 0, y: 0 }])],
    [
      'duplicate manual positions',
      () =>
        full(good(), [
          { nodeKey: 'a', x: 0, y: 0 },
          { nodeKey: 'a', x: 1, y: 1 },
        ]),
    ],
    ['duplicate previous keys', () => incremental({ previous: [placed('a'), placed('a')] })],
    ['added node not in tree', () => incremental({ addedNodeKeys: ['nope'] })],
    ['added node already placed', () => incremental({ previous: [placed('a'), placed('b')] })],
    ['removed node still in tree', () => incremental({ removedNodeKeys: ['a'] })],
    ['duplicate added keys', () => incremental({ addedNodeKeys: ['b', 'b'] })],
  ])('rejects %s as malformed-request', (_label, make) => {
    expect(() => validateRequest(make())).toThrowError(expect.objectContaining({ code: 'malformed-request' }));
  });

  it('maps an inconsistent tree to malformed-request through the adapter', async () => {
    const adapter = connect(createStubEngine());
    const root = nodeOf('a', [nodeOf('z')], null);
    const bad = full({ root, nodes: [root] }) as unknown as LayoutRequest;
    await expect(adapter.layout(bad)).rejects.toMatchObject({ code: 'malformed-request' });
  });
});

describe('worker host envelope handling', () => {
  it('reports an envelope without a usable id and does not throw or answer', async () => {
    const channel = createMemoryChannel<LayoutRequestMessage, LayoutResponseMessage>();
    const reports: string[] = [];
    createWorkerHost(createStubEngine(), channel.b, {
      onInvalidEnvelope: (reason) => {
        reports.push(reason);
      },
    });
    const replies: unknown[] = [];
    channel.a.onMessage((m) => replies.push(m));
    channel.a.post({ request: fullRequest() } as unknown as LayoutRequestMessage);
    channel.a.post(null as unknown as LayoutRequestMessage);
    await Promise.resolve();
    await Promise.resolve();
    expect(reports).toHaveLength(2);
    expect(replies).toHaveLength(0);
  });

  it('tolerates a missing callback', async () => {
    const channel = createMemoryChannel<LayoutRequestMessage, LayoutResponseMessage>();
    createWorkerHost(createStubEngine(), channel.b);
    channel.a.post({ id: 'x' } as unknown as LayoutRequestMessage);
    await Promise.resolve();
    await Promise.resolve();
    expect(true).toBe(true);
  });
});

describe('endpointFromWorker', () => {
  it('routes error to onError and messageerror to onMessageError', () => {
    const listeners = new Map<string, (event: Event) => void>();
    const worker: WorkerLike = {
      postMessage: () => undefined,
      addEventListener: (type: string, listener: (event: never) => void) => {
        listeners.set(type, listener as (event: Event) => void);
      },
    };
    const endpoint = endpointFromWorker<unknown, unknown>(worker);
    const errors: string[] = [];
    const messageErrors: string[] = [];
    endpoint.onError((r) => errors.push(r));
    endpoint.onMessageError((r) => messageErrors.push(r));
    listeners.get('error')?.(new Event('error'));
    expect(errors).toEqual(['worker error']);
    expect(messageErrors).toEqual([]);
    listeners.get('messageerror')?.(new Event('messageerror'));
    expect(messageErrors).toHaveLength(1);
  });

  it('wires adapter fatal handling through a fake worker', async () => {
    const listeners = new Map<string, (event: Event) => void>();
    const worker: WorkerLike = {
      postMessage: () => undefined,
      addEventListener: (type: string, listener: (event: never) => void) => {
        listeners.set(type, listener as (event: Event) => void);
      },
    };
    const adapter = createLayoutAdapter(endpointFromWorker(worker));
    const pending = adapter.layout(fullRequest());
    listeners.get('error')?.(new Event('error'));
    await expect(pending).rejects.toMatchObject({ code: 'engine-failure' });
    await expect(adapter.layout(fullRequest())).rejects.toMatchObject({ code: 'engine-failure' });
  });
});
