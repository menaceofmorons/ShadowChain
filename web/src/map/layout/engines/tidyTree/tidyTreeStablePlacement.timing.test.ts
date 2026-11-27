import { describe, expect, it } from 'vitest';
import { buildChainTree } from '../../../model/chainTree';
import type { ChainGraph, ChainTree } from '../../../model/types';
import { generateChain, generateChurnScript, SYNTHETIC_ROOT_SYSTEM_ID } from '../../../synthetic';
import type { ChurnOperation } from '../../../synthetic';
import { filterManualPositions } from '../../manualPositions';
import type { LayoutMode, ManualPosition, PlacedNode } from '../../types';
import { createTidyTreeEngine } from './tidyTreeEngine';

const INCREMENTAL_P95_BUDGET_MS = 10;

const engine = createTidyTreeEngine();

const treeOf = (graph: ChainGraph): ChainTree => buildChainTree(graph, SYNTHETIC_ROOT_SYSTEM_ID);

interface World {
  graph: ChainGraph;
  tree: ChainTree;
  placed: readonly PlacedNode[];
  manual: readonly ManualPosition[];
}

const startWorld = async (nodeCount: number, mode: LayoutMode, seed: number): Promise<World> => {
  const graph = generateChain({ nodeCount, seed });
  const tree = treeOf(graph);
  const free = await engine.layout({ type: 'full', tree, mode, manualPositions: [] });
  const manual = free
    .filter((node, index) => index % 9 === 4 && node.nodeKey !== tree.root.keyString)
    .map((node) => ({ nodeKey: node.nodeKey, x: node.x, y: node.y }));
  const placed = await engine.layout({ type: 'full', tree, mode, manualPositions: manual });
  return { graph, tree, placed, manual };
};

const applyOperation = (graph: ChainGraph, operation: ChurnOperation): ChainGraph => ({
  systems: graph.systems,
  connections:
    operation.kind === 'add'
      ? [...graph.connections, operation.connection]
      : graph.connections.filter((c) => c.id !== operation.connectionId),
});

const advance = async (
  world: World,
  operation: ChurnOperation,
  mode: LayoutMode,
): Promise<{ world: World; elapsedMs: number }> => {
  const graph = applyOperation(world.graph, operation);
  const tree = treeOf(graph);
  const known = new Set(world.tree.nodes.map((n) => n.keyString));
  const present = new Set(tree.nodes.map((n) => n.keyString));
  const manual = filterManualPositions(tree, world.manual);
  const start = performance.now();
  const placed = await engine.layout({
    type: 'incremental',
    tree,
    mode,
    manualPositions: manual,
    previous: world.placed,
    addedNodeKeys: [...present].filter((key) => !known.has(key)),
    removedNodeKeys: [...known].filter((key) => !present.has(key)),
  });
  const elapsedMs = performance.now() - start;
  return { world: { graph, tree, placed, manual }, elapsedMs };
};

describe('tidy-tree incremental placement time', () => {
  it('places an addition or removal in under 10 ms at p95 at 150 nodes', async () => {
    const mode = 'top-down';
    let world = await startWorld(150, mode, 3);
    const script = generateChurnScript(world.graph, { seed: 5, operationCount: 100 });
    const durations: number[] = [];
    for (const operation of script) {
      const step = await advance(world, operation, mode);
      durations.push(step.elapsedMs);
      world = step.world;
    }
    const sorted = [...durations].sort((a, b) => a - b);
    const p95 = sorted[Math.ceil(sorted.length * 0.95) - 1] as number;
    expect(p95).toBeLessThan(INCREMENTAL_P95_BUDGET_MS);
  });
});
