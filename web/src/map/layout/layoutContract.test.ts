import { describe, expect, it, vi } from 'vitest';
import { buildChainTree } from '../model/chainTree';
import { collapseChainTree } from '../model/chainOps';
import type { ChainConnection } from '../model/types';
import { createLayoutAdapter } from './layoutAdapter';
import { filterManualPositions } from './manualPositions';
import { createMemoryChannel } from './transport';
import { createWorkerHost } from './workerHost';
import { validateRequest } from './validateRequest';
import { createTidyTreeEngine } from './engines/tidyTree';
import { createRegistryAdapter } from './engines/registryAdapter';
import { TIDY_TREE_ENTRY } from './engines/engineRegistry';
import type { EngineRegistry } from './engines/engineRegistry';
import { createStubEngine } from './testing/stubEngine';
import type { LayoutEngine, LayoutRequest, LayoutRequestMessage, LayoutResponseMessage } from './types';

const conn = (id: number, createdAt: number, endA: number, endB: number): ChainConnection => ({
  id,
  createdAt,
  endA,
  endB,
});

const tree = buildChainTree(
  {
    systems: [1, 2, 3, 4].map((id) => ({ id })),
    connections: [conn(10, 1, 1, 2), conn(11, 2, 2, 3), conn(12, 3, 1, 4)],
  },
  1,
);

const base = (): LayoutRequest => ({ type: 'full', tree, mode: 'top-down', manualPositions: [] });

const connect = (engine: LayoutEngine) => {
  const channel = createMemoryChannel<LayoutRequestMessage, LayoutResponseMessage>();
  createWorkerHost(engine, channel.b);
  return createLayoutAdapter(channel.a);
};

describe('layout contract: collapse and root offset', () => {
  const collapsedTree = collapseChainTree(tree, new Set(['s:2']));

  it('reports collapsed state and the hidden count over the memory channel', async () => {
    const adapter = connect(createStubEngine());
    const nodes = await adapter.layout({
      ...base(),
      tree: collapsedTree,
      collapsedKeys: ['s:2'],
      rootOffset: 40,
    });
    const byKey = new Map(nodes.map((node) => [node.nodeKey, node]));
    expect(byKey.get('s:2')).toMatchObject({ collapsed: true, hiddenCount: null });
    expect(byKey.get('s:1')).toMatchObject({ collapsed: false, hiddenCount: null });
    const plusN = nodes.find((node) => node.nodeKey.startsWith('+:'));
    expect(plusN).toMatchObject({ collapsed: false, hiddenCount: 1 });
  });

  it('carries the same fields from the tidy-tree engine and sizes the +N node from options', async () => {
    const adapter = connect(createTidyTreeEngine());
    const nodes = await adapter.layout({ ...base(), tree: collapsedTree, collapsedKeys: ['s:2'] });
    expect(nodes.find((node) => node.nodeKey.startsWith('+:'))?.hiddenCount).toBe(1);
    expect(nodes.find((node) => node.nodeKey === 's:2')?.collapsed).toBe(true);
  });

  it('keeps requests without the new fields valid', () => {
    expect(() => validateRequest(base())).not.toThrow();
  });

  it.each([
    ['non-array collapsedKeys', { collapsedKeys: 'x' }],
    ['unknown collapsed key', { collapsedKeys: ['s:99'] }],
    ['non-finite rootOffset', { rootOffset: Number.NaN }],
    ['string rootOffset', { rootOffset: '1' }],
  ])('rejects %s as malformed-request', (_label, extra) => {
    expect(() => validateRequest({ ...base(), ...extra })).toThrowError(
      expect.objectContaining({ code: 'malformed-request' }) as Error,
    );
  });

  it('rejects a response node missing the new fields as engine-failure', async () => {
    const engine: LayoutEngine = {
      layout: () => [{ nodeKey: 's:1', x: 0, y: 0, source: 'auto', alias: false }] as never,
    };
    await expect(connect(engine).layout(base())).rejects.toMatchObject({ code: 'engine-failure' });
  });
});

describe('filterManualPositions', () => {
  it.each([
    ['all present', ['s:1', 's:2'], ['s:1', 's:2']],
    ['one stale', ['s:1', 's:99'], ['s:1']],
    ['all stale', ['s:98', 's:99'], []],
    ['empty', [], []],
  ])('%s', (_label, input, expected) => {
    const positions = input.map((nodeKey) => ({ nodeKey, x: 1, y: 2 }));
    expect(filterManualPositions(tree, positions).map((p) => p.nodeKey)).toEqual(expected);
  });

  it('makes a stale-position request pass strict validation', () => {
    const positions = [
      { nodeKey: 's:1', x: 1, y: 2 },
      { nodeKey: 's:99', x: 3, y: 4 },
    ];
    expect(() => validateRequest({ ...base(), manualPositions: positions })).toThrowError(
      expect.objectContaining({ code: 'malformed-request' }) as Error,
    );
    expect(() => validateRequest({ ...base(), manualPositions: filterManualPositions(tree, positions) })).not.toThrow();
  });
});

describe('reachability validation', () => {
  const orphaned = () => {
    const orphan = { keyString: 's:9', children: [], parentEdge: {} };
    return { ...base(), tree: { ...tree, nodes: [...tree.nodes, orphan] } };
  };

  it('rejects nodes not reachable from the root', () => {
    expect(() => validateRequest(orphaned())).toThrowError(
      expect.objectContaining({ code: 'malformed-request' }) as Error,
    );
  });

  it('rejects over the channel as malformed-request', async () => {
    await expect(connect(createStubEngine()).layout(orphaned() as unknown as LayoutRequest)).rejects.toMatchObject({
      code: 'malformed-request',
    });
  });

  it('accepts a fully connected tree and a collapsed tree', () => {
    expect(() => validateRequest(base())).not.toThrow();
    expect(() => validateRequest({ ...base(), tree: collapseChainTree(tree, new Set(['s:2'])) })).not.toThrow();
  });
});

describe('registry adapter worker recovery', () => {
  const fakeWorker = () => {
    const listeners = new Map<string, (event: Event) => void>();
    const posted: LayoutRequestMessage[] = [];
    const terminate = vi.fn();
    const worker = {
      postMessage: (message: LayoutRequestMessage) => {
        posted.push(message);
      },
      addEventListener: (type: string, listener: (event: Event) => void) => {
        listeners.set(type, listener);
      },
      terminate,
    } as unknown as Worker;
    return {
      worker,
      terminate,
      posted,
      crash: () => listeners.get('error')?.(new Event('error')),
      answer: (id: number) => {
        listeners.get('message')?.({ data: { id, ok: true, nodes: [] } } as unknown as Event);
      },
    };
  };

  it('rejects the in-flight request, then recreates the worker for the next request', async () => {
    const workers = [fakeWorker(), fakeWorker()];
    let created = 0;
    const createWorker = vi.fn(() => (workers[created++] as ReturnType<typeof fakeWorker>).worker);
    const registry: EngineRegistry = {
      'top-down': { ...TIDY_TREE_ENTRY, createWorker },
      'left-to-right': { ...TIDY_TREE_ENTRY, createWorker },
      radial: { ...TIDY_TREE_ENTRY, createWorker },
    };
    const adapter = createRegistryAdapter(registry);

    const inFlight = adapter.layout(base());
    workers[0]?.crash();
    await expect(inFlight).rejects.toMatchObject({ code: 'engine-failure' });
    expect(workers[0]?.terminate).toHaveBeenCalled();

    const next = adapter.layout(base());
    expect(createWorker).toHaveBeenCalledTimes(2);
    workers[1]?.answer(workers[1].posted[0]?.id ?? 0);
    await expect(next).resolves.toEqual([]);
    adapter.dispose();
  });

  it('does not recreate the worker without an error', async () => {
    const only = fakeWorker();
    const createWorker = vi.fn(() => only.worker);
    const entry = { ...TIDY_TREE_ENTRY, createWorker };
    const adapter = createRegistryAdapter({ 'top-down': entry, 'left-to-right': entry, radial: entry });
    const first = adapter.layout(base());
    only.answer(only.posted[0]?.id ?? 0);
    await first;
    const second = adapter.layout(base());
    only.answer(only.posted[1]?.id ?? 0);
    await second;
    expect(createWorker).toHaveBeenCalledTimes(1);
    adapter.dispose();
  });
});
