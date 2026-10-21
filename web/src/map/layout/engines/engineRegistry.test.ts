import { describe, expect, it, vi } from 'vitest';
import { LAYOUT_MODES } from '../types';
import type { LayoutEngine, LayoutMode, PlacedNode } from '../types';
import { buildChainTree } from '../../model/chainTree';
import { generateChain, SYNTHETIC_ROOT_SYSTEM_ID } from '../../synthetic';
import { DEFAULT_ENGINE_OPTIONS } from '../engineOptions';
import { createRegistryAdapter } from './registryAdapter';
import {
  DEFAULT_ENGINE_REGISTRY,
  ELK_ENTRY,
  TIDY_TREE_ENTRY,
  createRoutedEngine,
  engineEntryForMode,
  registeredEngineIds,
} from './engineRegistry';
import type { EngineEntry, EngineRegistry } from './engineRegistry';

const tree = buildChainTree(generateChain({ nodeCount: 40, seed: 7 }), SYNTHETIC_ROOT_SYSTEM_ID);

const consumerRun = async (registry: EngineRegistry, mode: LayoutMode): Promise<readonly PlacedNode[]> =>
  createRoutedEngine(registry).layout({ type: 'full', tree, mode, manualPositions: [] });

const sizeOf = (node: PlacedNode) =>
  node.alias
    ? { w: DEFAULT_ENGINE_OPTIONS.aliasWidth, h: DEFAULT_ENGINE_OPTIONS.aliasHeight }
    : { w: DEFAULT_ENGINE_OPTIONS.nodeWidth, h: DEFAULT_ENGINE_OPTIONS.nodeHeight };

const overlappingPairs = (nodes: readonly PlacedNode[]): string[] => {
  const found: string[] = [];
  for (let i = 0; i < nodes.length; i += 1) {
    const a = nodes[i] as PlacedNode;
    const sa = sizeOf(a);
    for (let j = i + 1; j < nodes.length; j += 1) {
      const b = nodes[j] as PlacedNode;
      const sb = sizeOf(b);
      if (a.x < b.x + sb.w && b.x < a.x + sa.w && a.y < b.y + sb.h && b.y < a.y + sa.h) {
        found.push(`${a.nodeKey}/${b.nodeKey}`);
      }
    }
  }
  return found;
};

const withMode =(mode: LayoutMode, entry: EngineEntry): EngineRegistry => ({
  ...DEFAULT_ENGINE_REGISTRY,
  [mode]: entry,
});

describe('engine registry routing', () => {
  it('routes top-down and left-to-right to tidy-tree and radial to elkjs', () => {
    expect(engineEntryForMode('top-down').id).toBe('tidy-tree');
    expect(engineEntryForMode('left-to-right').id).toBe('tidy-tree');
    expect(engineEntryForMode('radial').id).toBe('elkjs');
  });

  it('has an entry with a worker factory for every mode', () => {
    for (const mode of LAYOUT_MODES) {
      expect(typeof DEFAULT_ENGINE_REGISTRY[mode].createWorker).toBe('function');
    }
    expect(registeredEngineIds()).toEqual(['tidy-tree', 'elkjs']);
  });

  it('keeps radial on elkjs whatever the other modes use', () => {
    const swapped = { ...DEFAULT_ENGINE_REGISTRY, 'top-down': ELK_ENTRY, 'left-to-right': ELK_ENTRY };
    expect(engineEntryForMode('radial', swapped).id).toBe('elkjs');
  });

  it('asks each entry only for the modes it serves and builds an engine once', async () => {
    const stub: LayoutEngine = { layout: () => [] };
    const createStub = vi.fn(() => Promise.resolve(stub));
    const createOther = vi.fn(() => Promise.resolve(stub));
    const registry: EngineRegistry = {
      'top-down': { ...TIDY_TREE_ENTRY, createEngine: createStub },
      'left-to-right': { ...TIDY_TREE_ENTRY, createEngine: createStub },
      radial: { ...ELK_ENTRY, createEngine: createOther },
    };
    const engine = createRoutedEngine(registry);
    await engine.layout({ type: 'full', tree, mode: 'top-down', manualPositions: [] });
    await engine.layout({ type: 'full', tree, mode: 'left-to-right', manualPositions: [] });
    expect(createStub).toHaveBeenCalledTimes(1);
    expect(createOther).not.toHaveBeenCalled();
    await engine.layout({ type: 'full', tree, mode: 'radial', manualPositions: [] });
    expect(createOther).toHaveBeenCalledTimes(1);
  });

  it('retries after a failed engine creation instead of caching the rejection', async () => {
    const stub: LayoutEngine = { layout: () => [] };
    const create = vi
      .fn<() => Promise<LayoutEngine>>()
      .mockRejectedValueOnce(new Error('chunk load failed'))
      .mockResolvedValue(stub);
    const engine = createRoutedEngine(withMode('top-down', { ...TIDY_TREE_ENTRY, createEngine: create }));
    await expect(engine.layout({ type: 'full', tree, mode: 'top-down', manualPositions: [] })).rejects.toThrow(
      'chunk load failed',
    );
    await expect(engine.layout({ type: 'full', tree, mode: 'top-down', manualPositions: [] })).resolves.toEqual([]);
    expect(create).toHaveBeenCalledTimes(2);
  });
});

describe('registry adapter failure paths', () => {
  it('rejects instead of throwing when the worker factory throws', async () => {
    const createWorker = vi.fn((): Worker => {
      throw new Error('worker unavailable');
    });
    const adapter = createRegistryAdapter(withMode('top-down', { ...TIDY_TREE_ENTRY, createWorker }));
    const pending = adapter.layout({ type: 'full', tree, mode: 'top-down', manualPositions: [] });
    await expect(pending).rejects.toThrow();
    adapter.dispose();
  });

  it('rejects instead of throwing for an unknown mode', async () => {
    const adapter = createRegistryAdapter();
    const pending = adapter.layout({ type: 'full', tree, mode: 'nope' as LayoutMode, manualPositions: [] });
    await expect(pending).rejects.toThrow();
    adapter.dispose();
  });
});

describe('engine swap proof', () => {
  for (const mode of ['top-down', 'left-to-right'] as const) {
    it(`runs the same consumer code on either engine for ${mode} by changing only the registry entry`, async () => {
      for (const entry of [TIDY_TREE_ENTRY, ELK_ENTRY]) {
        const placed = await consumerRun(withMode(mode, entry), mode);
        expect(placed).toHaveLength(tree.nodes.length);
        expect(new Set(placed.map((node) => node.nodeKey)).size).toBe(tree.nodes.length);
        expect(overlappingPairs(placed)).toEqual([]);
      }
    }, 60_000);
  }

  it('lays out radial through the registry on elkjs', async () => {
    const placed = await consumerRun(DEFAULT_ENGINE_REGISTRY, 'radial');
    expect(placed).toHaveLength(tree.nodes.length);
  }, 60_000);
});
