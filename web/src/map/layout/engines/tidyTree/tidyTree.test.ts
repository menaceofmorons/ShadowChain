import { describe, expect, it } from 'vitest';
import {
  assertMovedPerAdditionAtMost,
  assertNoMovementOnAddition,
  assertWithinTimeBudget,
  runHarness,
} from '../../../harness';
import { buildChainTree } from '../../../model/chainTree';
import type { ChainGraph } from '../../../model/types';
import {
  generateChain,
  generateChurnScript,
  SYNTHETIC_NODE_COUNTS,
  SYNTHETIC_ROOT_SYSTEM_ID,
} from '../../../synthetic';
import { DEFAULT_ENGINE_OPTIONS } from '../../engineOptions';
import type { EngineOptions } from '../../engineOptions';
import { createLayoutAdapter } from '../../layoutAdapter';
import { createMemoryChannel } from '../../transport';
import { LayoutError } from '../../types';
import type { LayoutMode, LayoutRequestMessage, LayoutResponseMessage, PlacedNode } from '../../types';
import { bindEngineToWorker } from '../../workerBootstrap';
import { createTidyTreeEngine } from './tidyTreeEngine';

const SQUARE: Partial<EngineOptions> = { nodeWidth: 80, nodeHeight: 80, aliasWidth: 40, aliasHeight: 40 };

const treeOf = (graph: ChainGraph) => buildChainTree(graph, SYNTHETIC_ROOT_SYSTEM_ID);

const fullRequest = (graph: ChainGraph, mode: LayoutMode = 'top-down', manualPositions: PlacedNodeLike[] = []) => ({
  type: 'full' as const,
  tree: treeOf(graph),
  mode,
  manualPositions,
});

type PlacedNodeLike = { nodeKey: string; x: number; y: number };

const sizeOf = (node: PlacedNode, options: EngineOptions) =>
  node.alias ? { w: options.aliasWidth, h: options.aliasHeight } : { w: options.nodeWidth, h: options.nodeHeight };

const countOverlaps = (nodes: readonly PlacedNode[], options: EngineOptions = DEFAULT_ENGINE_OPTIONS): number => {
  let overlaps = 0;
  for (let i = 0; i < nodes.length; i += 1) {
    for (let j = i + 1; j < nodes.length; j += 1) {
      const a = nodes[i] as PlacedNode;
      const b = nodes[j] as PlacedNode;
      const sa = sizeOf(a, options);
      const sb = sizeOf(b, options);
      if (a.x < b.x + sb.w && b.x < a.x + sa.w && a.y < b.y + sb.h && b.y < a.y + sa.h) {
        overlaps += 1;
      }
    }
  }
  return overlaps;
};

const byKey = (nodes: readonly PlacedNode[]) => new Map(nodes.map((node) => [node.nodeKey, node]));

describe('tidy-tree determinism and overlap', () => {
  const engine = createTidyTreeEngine();

  it.each([...SYNTHETIC_NODE_COUNTS])('is deterministic and overlap-free at %i nodes', async (nodeCount) => {
    const graph = generateChain({ nodeCount, seed: 11 });
    for (const mode of ['top-down', 'left-to-right'] as const) {
      const request = fullRequest(graph, mode);
      const first = await engine.layout(request);
      const second = await createTidyTreeEngine().layout(request);
      expect(second).toEqual(first);
      expect(first).toHaveLength(request.tree.nodes.length);
      expect(countOverlaps(first)).toBe(0);
    }
  });

  it('places the root first and children below their parent in tree order', async () => {
    const graph: ChainGraph = {
      systems: [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }],
      connections: [
        { id: 1, createdAt: 1, endA: 1, endB: 2 },
        { id: 2, createdAt: 2, endA: 1, endB: 3 },
        { id: 3, createdAt: 3, endA: 3, endB: 4 },
      ],
    };
    const placed = byKey(await engine.layout(fullRequest(graph)));
    const [one, two, three, four] = ['s:1', 's:2', 's:3', 's:4'].map((key) => placed.get(key) as PlacedNode);
    expect((two as PlacedNode).x).toBeLessThan((three as PlacedNode).x);
    expect((two as PlacedNode).y).toBeGreaterThan((one as PlacedNode).y);
    expect((four as PlacedNode).y).toBeGreaterThan((three as PlacedNode).y);
    expect((one as PlacedNode).x + DEFAULT_ENGINE_OPTIONS.nodeWidth / 2).toBeCloseTo(
      ((two as PlacedNode).x + (three as PlacedNode).x + DEFAULT_ENGINE_OPTIONS.nodeWidth) / 2,
    );
  });
});

describe('tidy-tree left-to-right', () => {
  it('equals top-down transposed when node sizes are square', async () => {
    const engine = createTidyTreeEngine(SQUARE);
    const graph = generateChain({ nodeCount: 150, seed: 5 });
    const down = await engine.layout(fullRequest(graph, 'top-down'));
    const across = byKey(await engine.layout(fullRequest(graph, 'left-to-right')));
    for (const node of down) {
      const other = across.get(node.nodeKey) as PlacedNode;
      expect(other.x).toBe(node.y);
      expect(other.y).toBe(node.x);
    }
  });
});

describe('tidy-tree nodes', () => {
  const graph: ChainGraph = {
    systems: [{ id: 1 }, { id: 2 }, { id: 3 }],
    connections: [
      { id: 1, createdAt: 1, endA: 1, endB: 2 },
      { id: 2, createdAt: 2, endA: 1, endB: 3 },
      { id: 3, createdAt: 3, endA: 2, endB: 3 },
      { id: 4, createdAt: 4, endA: 3, endB: null },
    ],
  };

  it('echoes manual positions and marks everything else auto', async () => {
    const engine = createTidyTreeEngine();
    const placed = byKey(await engine.layout(fullRequest(graph, 'top-down', [{ nodeKey: 's:2', x: 900, y: -40 }])));
    expect(placed.get('s:2')).toMatchObject({ x: 900, y: -40, source: 'manual' });
    const others = [...placed.values()].filter((node) => node.nodeKey !== 's:2');
    expect(others.length).toBeGreaterThan(0);
    expect(others.every((node) => node.source === 'auto')).toBe(true);
  });

  it('lays alias nodes out as leaves with the alias size', async () => {
    const request = fullRequest(graph);
    const aliasKeys = request.tree.nodes.filter((node) => node.kind === 'alias').map((node) => node.keyString);
    expect(aliasKeys.length).toBeGreaterThan(0);
    const placed = byKey(await createTidyTreeEngine().layout(request));
    for (const key of aliasKeys) {
      expect(placed.get(key)?.alias).toBe(true);
    }
    const options = { ...DEFAULT_ENGINE_OPTIONS, aliasWidth: 20, aliasHeight: 10, nodeWidth: 100, nodeHeight: 50 };
    const resized = byKey(
      await createTidyTreeEngine({ aliasWidth: 20, aliasHeight: 10, nodeWidth: 100, nodeHeight: 50 }).layout(request),
    );
    expect(countOverlaps([...resized.values()], options)).toBe(0);
    const root = resized.get('s:1') as PlacedNode;
    const alias = resized.get(aliasKeys[0] as string) as PlacedNode;
    expect(alias.y).toBeGreaterThan(root.y);
  });

  it('rejects a radial request as malformed', () => {
    expect(() => createTidyTreeEngine().layout(fullRequest(graph, 'radial'))).toThrow(LayoutError);
    try {
      createTidyTreeEngine().layout(fullRequest(graph, 'radial'));
    } catch (error) {
      expect((error as LayoutError).code).toBe('malformed-request');
    }
  });
});

describe('tidy-tree incremental', () => {
  it('reuses previous positions and places added nodes without overlap', async () => {
    const engine = createTidyTreeEngine();
    let graph = generateChain({ nodeCount: 150, seed: 2 });
    let tree = treeOf(graph);
    let placed = await engine.layout({ type: 'full', tree, mode: 'top-down', manualPositions: [] });
    const script = generateChurnScript(graph, { seed: 9, operationCount: 40 });
    for (const operation of script) {
      graph =
        operation.kind === 'add'
          ? { ...graph, connections: [...graph.connections, operation.connection] }
          : { ...graph, connections: graph.connections.filter((c) => c.id !== operation.connectionId) };
      const next = treeOf(graph);
      const known = new Set(tree.nodes.map((node) => node.keyString));
      const present = new Set(next.nodes.map((node) => node.keyString));
      const addedNodeKeys = [...present].filter((key) => !known.has(key));
      const removedNodeKeys = [...known].filter((key) => !present.has(key));
      const result = await engine.layout({
        type: 'incremental',
        tree: next,
        mode: 'top-down',
        manualPositions: [],
        previous: placed,
        addedNodeKeys,
        removedNodeKeys,
      });
      const before = byKey(placed);
      for (const node of result) {
        const prior = before.get(node.nodeKey);
        if (prior !== undefined) {
          expect({ x: node.x, y: node.y }).toEqual({ x: prior.x, y: prior.y });
        }
      }
      expect(result).toHaveLength(next.nodes.length);
      expect(countOverlaps(result)).toBe(0);
      placed = result;
      tree = next;
    }
  });

  it('moves no placed node per addition through the harness', async () => {
    const graph = generateChain({ nodeCount: 150, seed: 6 });
    const churn = generateChurnScript(graph, { seed: 7, operationCount: 30 });
    const report = await runHarness({
      label: 'tidy',
      engine: createTidyTreeEngine(),
      graph,
      rootSystemId: SYNTHETIC_ROOT_SYSTEM_ID,
      churn,
      engineSources: [],
    });
    expect(report.nodesMovedPerAddition.count).toBeGreaterThan(0);
    expect(() => {
      assertNoMovementOnAddition(report);
    }).not.toThrow();
    expect(() => {
      assertMovedPerAdditionAtMost(report, 0);
    }).not.toThrow();
    expect(() => {
      assertWithinTimeBudget(report.fullLayoutMs, 1000);
    }).not.toThrow();
  });
});

describe('tidy-tree worker round trip', () => {
  it('serves layout requests over the memory channel', async () => {
    const channel = createMemoryChannel<LayoutRequestMessage, LayoutResponseMessage>();
    bindEngineToWorker(createTidyTreeEngine(), channel.b);
    const adapter = createLayoutAdapter(channel.a);
    const graph = generateChain({ nodeCount: 50, seed: 1 });
    const request = fullRequest(graph);
    const viaWorker = await adapter.layout(request);
    expect(viaWorker).toEqual(await createTidyTreeEngine().layout(request));
    await expect(adapter.layout({ ...request, mode: 'radial' })).rejects.toMatchObject({ code: 'malformed-request' });
  });
});

describe('tidy-tree worker entry imports', () => {
  const sources = import.meta.glob('./*.ts', { query: '?raw', import: 'default', eager: true }) as Record<
    string,
    string
  >;

  it('imports only from map/layout and map/model', () => {
    const entry = sources['./tidyTreeWorker.ts'] as string;
    const engine = sources['./tidyTreeEngine.ts'] as string;
    const specifiers = [entry, engine].flatMap((source) =>
      [...source.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1] as string),
    );
    expect(specifiers.length).toBeGreaterThan(0);
    for (const specifier of specifiers) {
      expect(specifier).toMatch(/^(\.\/|\.\.\/\.\.\/|\.\.\/\.\.\/\.\.\/model\/)/);
    }
  });
});
