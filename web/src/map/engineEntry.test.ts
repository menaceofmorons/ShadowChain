import { describe, expect, it } from 'vitest';
import * as mapEntry from './index';
import {
  BAKEOFF_CANDIDATES,
  buildChainTree,
  createElkEngine,
  createLayoutAdapter,
  createMemoryChannel,
  createRoutedEngine,
  createTidyTreeEngine,
  createWorkerHost,
  DEFAULT_ENGINE_REGISTRY,
  engineEntryForMode,
  generateChain,
  generateChurnScript,
  LAYOUT_MODES,
  measureStability,
  nodesOverlap,
  registeredEngineIds,
  runHarness,
  SYNTHETIC_ROOT_SYSTEM_ID,
  type LayoutEngine,
  type LayoutMode,
  type LayoutRequestMessage,
  type LayoutResponseMessage,
  type PlacedNode,
} from './index';

const SEED = 7;
const CHAIN_SIZE = 150;
const graph = generateChain({ nodeCount: CHAIN_SIZE, seed: SEED });
const tree = buildChainTree(graph, SYNTHETIC_ROOT_SYSTEM_ID);

function viaWorkerBoundary(engine: LayoutEngine): LayoutEngine {
  const { a, b } = createMemoryChannel<LayoutRequestMessage, LayoutResponseMessage>();
  createWorkerHost(engine, b);
  const adapter = createLayoutAdapter(a);
  return { layout: (request) => adapter.layout(request) };
}

const fullLayout = async (engine: LayoutEngine, mode: LayoutMode): Promise<readonly PlacedNode[]> =>
  engine.layout({ type: 'full', tree, mode, manualPositions: [] });

function countOverlaps(placed: readonly PlacedNode[]): number {
  let overlaps = 0;
  for (let i = 0; i < placed.length; i += 1) {
    for (let j = i + 1; j < placed.length; j += 1) {
      const a = placed[i];
      const b = placed[j];
      if (a !== undefined && b !== undefined && !a.alias && !b.alias && nodesOverlap(a, b)) {
        overlaps += 1;
      }
    }
  }
  return overlaps;
}

describe('map entry point exposes what WS-1.3 consumes', () => {
  it('exports the registry, engine entry points and bake-off runner', () => {
    const names = Object.keys(mapEntry);
    for (const expected of [
      'DEFAULT_ENGINE_REGISTRY',
      'TIDY_TREE_ENTRY',
      'ELK_ENTRY',
      'engineEntryForMode',
      'registeredEngineIds',
      'createRoutedEngine',
      'createRegistryAdapter',
      'createTidyTreeEngine',
      'createElkEngine',
      'BAKEOFF_CANDIDATES',
      'measureStability',
      'measureWanderer553',
      'runStability',
      'formatBakeoffReport',
    ]) {
      expect(names).toContain(expected);
    }
  });

  it('keeps test-only engines and the test stub out', () => {
    const names = Object.keys(mapEntry);
    for (const hidden of ['createShiftingEngine', 'createDelayedEngine', 'createStubEngine']) {
      expect(names).not.toContain(hidden);
    }
  });

  it('routes every mode through a registry entry', () => {
    expect(LAYOUT_MODES.map((mode) => engineEntryForMode(mode).id)).toEqual(['tidy-tree', 'tidy-tree', 'elkjs']);
    expect(registeredEngineIds()).toEqual(['tidy-tree', 'elkjs']);
    expect(DEFAULT_ENGINE_REGISTRY['top-down'].id).toBe('tidy-tree');
  });
});

describe('150-node chain through the entry point, registry and worker boundary', () => {
  it.each(LAYOUT_MODES)('places every node without overlap and deterministically in %s', async (mode) => {
    const first = await fullLayout(viaWorkerBoundary(createRoutedEngine()), mode);
    const second = await fullLayout(viaWorkerBoundary(createRoutedEngine()), mode);
    expect(first).toHaveLength(tree.nodes.length);
    expect(new Set(first.map((node) => node.nodeKey)).size).toBe(tree.nodes.length);
    expect(countOverlaps(first)).toBe(0);
    expect(second).toEqual(first);
  });

  it.each(['top-down', 'left-to-right'] as const)(
    'moves no placed node per addition under churn through the registry in %s',
    async (mode) => {
      const churn = generateChurnScript(graph, { seed: SEED + 1, operationCount: 40 });
      const report = await runHarness({
        label: `registry-${mode}`,
        engine: viaWorkerBoundary(createRoutedEngine()),
        graph,
        rootSystemId: SYNTHETIC_ROOT_SYSTEM_ID,
        churn,
        engineSources: [],
        mode,
      });
      expect(report.nodesMovedPerAddition.count).toBeGreaterThan(0);
      expect(report.nodesMovedPerAddition.max).toBe(0);
    },
  );

  it('uses the same engines the bake-off measured', async () => {
    expect(BAKEOFF_CANDIDATES.map((candidate) => candidate.name)).toEqual(['tidy-tree', 'elkjs']);
    expect(createTidyTreeEngine()).toBeDefined();
    expect(createElkEngine()).toBeDefined();
    const [tidy] = BAKEOFF_CANDIDATES;
    expect(tidy).toBeDefined();
    if (tidy !== undefined) {
      const row = await measureStability(tidy, 'top-down', CHAIN_SIZE);
      expect(row.deterministic).toBe(true);
      expect(row.moved.max).toBe(0);
    }
  });
});
