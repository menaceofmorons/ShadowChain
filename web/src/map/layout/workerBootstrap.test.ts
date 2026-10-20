import { describe, expect, it } from 'vitest';
import { buildChainTree } from '../model/chainTree';
import { DEFAULT_ENGINE_OPTIONS, resolveEngineOptions } from './engineOptions';
import { createLayoutAdapter } from './layoutAdapter';
import { createMemoryChannel } from './transport';
import { createStubEngine } from './testing/stubEngine';
import type { LayoutRequestMessage, LayoutResponseMessage } from './types';
import { bindEngineToWorker } from './workerBootstrap';

describe('worker bootstrap', () => {
  it('binds an engine to an endpoint and round-trips a request', async () => {
    const channel = createMemoryChannel<LayoutRequestMessage, LayoutResponseMessage>();
    bindEngineToWorker(createStubEngine(), channel.b);
    const adapter = createLayoutAdapter(channel.a);
    const tree = buildChainTree(
      { systems: [{ id: 1 }, { id: 2 }], connections: [{ id: 10, createdAt: 1, endA: 1, endB: 2 }] },
      1,
    );
    const nodes = await adapter.layout({ type: 'full', tree, mode: 'top-down', manualPositions: [] });
    expect(nodes.map((n) => n.nodeKey).sort()).toEqual(['s:1', 's:2']);
  });
});

describe('engine options', () => {
  it('defaults the node size to the 160x48 Wanderer fixtures', () => {
    expect(DEFAULT_ENGINE_OPTIONS).toMatchObject({ nodeWidth: 160, nodeHeight: 48 });
  });

  it('merges overrides over the defaults', () => {
    expect(resolveEngineOptions({ siblingSpacing: 5 })).toEqual({ ...DEFAULT_ENGINE_OPTIONS, siblingSpacing: 5 });
    expect(resolveEngineOptions()).toEqual(DEFAULT_ENGINE_OPTIONS);
  });
});
