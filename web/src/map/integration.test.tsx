import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import packageJsonText from '../../package.json?raw';
import { createStubEngine } from './layout/testing/stubEngine';
import stubEngineSource from './layout/testing/stubEngine.ts?raw';
import * as mapEntry from './index';
import {
  buildChainTree,
  createLayoutAdapter,
  createMemoryChannel,
  createWorkerHost,
  formatReport,
  generateAllSizes,
  generateChain,
  generateChurnScript,
  newNodeOutcomeIsCorrect,
  parseNodeKey,
  ReactFlowCanvas,
  runHarness,
  SYNTHETIC_NODE_COUNTS,
  SYNTHETIC_ROOT_SYSTEM_ID,
  wanderer553,
  wanderer98,
  type CanvasEdge,
  type CanvasNode,
  type ChainGraph,
  type ChainNode,
  type LayoutEngine,
  type LayoutRequestMessage,
  type LayoutResponseMessage,
  type PlacedNode,
} from './index';

const SEED = 11;

function viaWorkerBoundary(engine: LayoutEngine): LayoutEngine {
  const { a, b } = createMemoryChannel<LayoutRequestMessage, LayoutResponseMessage>();
  createWorkerHost(engine, b);
  const adapter = createLayoutAdapter(a);
  return { layout: (request) => adapter.layout(request) as Promise<PlacedNode[]> };
}

function describeGraph(graph: ChainGraph): { loops: boolean; parallel: boolean; unknownEnds: number } {
  const pairs = new Set<string>();
  let resolved = 0;
  let unknownEnds = 0;
  for (const connection of graph.connections) {
    if (connection.endB === null) {
      unknownEnds += 1;
      continue;
    }
    resolved += 1;
    pairs.add([connection.endA, connection.endB].sort((x, y) => x - y).join('-'));
  }
  return {
    loops: pairs.size > graph.systems.length - 1,
    parallel: resolved > pairs.size,
    unknownEnds,
  };
}

function describeFixture(fixture: typeof wanderer553 | typeof wanderer98): Record<string, unknown> {
  return {
    issue: fixture.source.issueNumber,
    url: fixture.source.url,
    summary: fixture.source.summary,
    reconstructed: fixture.reconstruction.reconstructed,
    note: fixture.reconstruction.note,
    startPositions: fixture.startPositions,
    ...('step' in fixture ? { step: fixture.step, newNodeKey: fixture.newNodeKey } : { movedNodeKeys: fixture.movedNodeKeys, dragDelta: fixture.dragDelta }),
    expected: fixture.expected,
  };
}

describe('public entry point', () => {
  it('exposes the contract surface and not the test stub engine', () => {
    const names = Object.keys(mapEntry);
    for (const expected of [
      'buildChainTree',
      'serialiseNodeKey',
      'generateChain',
      'generateChurnScript',
      'applyChurn',
      'createLayoutAdapter',
      'createWorkerHost',
      'ReactFlowCanvas',
      'runHarness',
      'formatReport',
      'wanderer553',
      'wanderer98',
      'newNodeOverlapsAny',
    ]) {
      expect(names).toContain(expected);
    }
    expect(names).not.toContain('createStubEngine');
    expect(names.some((name) => /stub/i.test(name))).toBe(false);
  });
});

describe('toolchain pin', () => {
  it('pins Node to 24 in package engines', () => {
    const pkg = JSON.parse(packageJsonText) as { engines?: { node?: string } };
    expect(pkg.engines?.node).toBe('>=24 <25');
  });
});

describe('generators through the public entry', () => {
  it.each(SYNTHETIC_NODE_COUNTS)('%i nodes carry loops, parallel edges, unknown ends and valid node keys', (nodeCount) => {
    const graph = generateChain({ nodeCount, seed: SEED });
    expect(graph.systems).toHaveLength(nodeCount);
    const traits = describeGraph(graph);
    expect(traits.parallel).toBe(true);
    expect(traits.unknownEnds).toBeGreaterThan(0);
    expect(traits.loops).toBe(true);

    const tree = buildChainTree(graph, SYNTHETIC_ROOT_SYSTEM_ID);
    const kinds = new Set(tree.nodes.map((node) => node.kind));
    expect(kinds).toEqual(new Set(['primary', 'alias', 'unknownEnd']));
    const primaries = tree.nodes.filter((node) => node.kind === 'primary');
    expect(primaries).toHaveLength(nodeCount);
    expect(new Set(tree.nodes.map((node) => node.keyString)).size).toBe(tree.nodes.length);
    for (const node of tree.nodes) {
      expect(node.keyString).toMatch(/^(s:\d+|a:\d+:\d+|u:\d+)$/);
      expect(parseNodeKey(node.keyString)).toEqual(node.key);
    }
  });

  it('generates all four sizes deterministically per seed', () => {
    expect(JSON.stringify(generateAllSizes(SEED))).toBe(JSON.stringify(generateAllSizes(SEED)));
    expect(generateAllSizes(SEED).map((graph) => graph.systems.length)).toEqual([50, 150, 250, 500]);
  });
});

describe('harness end to end over the worker boundary', () => {
  it.each(SYNTHETIC_NODE_COUNTS)('generator, adapter, stub engine and report at %i nodes', async (nodeCount) => {
    const graph = generateChain({ nodeCount, seed: SEED });
    const churn = generateChurnScript(graph, { seed: SEED + 1, operationCount: 25 });
    const report = await runHarness({
      label: `integration-${nodeCount}`,
      engine: viaWorkerBoundary(createStubEngine()),
      graph,
      rootSystemId: SYNTHETIC_ROOT_SYSTEM_ID,
      churn,
      engineSources: [{ path: 'stubEngine.ts', text: stubEngineSource }],
    });
    expect(report.nodeCount).toBe(nodeCount);
    expect(report.churnSteps).toBe(25);
    expect(report.fullLayoutMs.count).toBe(1);
    expect(report.incrementalLayoutMs.count).toBe(25);
    expect(report.nodesMovedPerAddition.count).toBeGreaterThan(0);
    expect(report.codeSize.bytes).toBeGreaterThan(0);
    const text = formatReport(report);
    console.info(`
${text}
`);
    for (const label of ['nodes moved per addition', 'full layout time', 'incremental layout time', 'bytes', 'non-blank lines']) {
      expect(text).toContain(label);
    }
  });

  it('produces the same placements across the boundary as a direct call', async () => {
    const graph = generateChain({ nodeCount: 50, seed: SEED });
    const tree = buildChainTree(graph, SYNTHETIC_ROOT_SYSTEM_ID);
    const request = { type: 'full', tree, mode: 'top-down', manualPositions: [] } as const;
    const direct = await createStubEngine().layout(request);
    const remote = await viaWorkerBoundary(createStubEngine()).layout(request);
    expect(remote).toEqual(direct);
  });

  it('rejects a malformed request across the boundary', async () => {
    const engine = viaWorkerBoundary(createStubEngine());
    await expect(engine.layout({} as never)).rejects.toMatchObject({ code: 'malformed-request' });
  });
});

describe('Wanderer fixtures through the public entry', () => {
  it('carry source references and are marked reconstructed', () => {
    console.info(`
${JSON.stringify({ wanderer553: describeFixture(wanderer553), wanderer98: describeFixture(wanderer98) }, null, 2)}
`);
    for (const fixture of [wanderer553, wanderer98]) {
      expect(fixture.source.url).toMatch(/^https:\/\//);
      expect(fixture.source.issueNumber).toBeGreaterThan(0);
      expect(fixture.reconstruction.reconstructed).toBe(true);
    }
  });

  it('flag the reported overlap outcome and accept a separated one', () => {
    const target = wanderer553.startPositions.find((p) => p.nodeKey === 's:3');
    expect(target).toBeDefined();
    const key = wanderer553.newNodeKey;
    const overlapping = [...wanderer553.startPositions, { nodeKey: key, x: target?.x ?? 0, y: target?.y ?? 0 }];
    expect(newNodeOutcomeIsCorrect(wanderer553.startPositions, overlapping, key)).toBe(false);
    const separated = [...wanderer553.startPositions, { nodeKey: key, x: 5000, y: 5000 }];
    expect(newNodeOutcomeIsCorrect(wanderer553.startPositions, separated, key)).toBe(true);
  });
});

describe('layout output renders on the canvas', () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = null;
    container = null;
  });

  it('renders every placed node and parent edge of a generated chain', async () => {
    const graph = generateChain({ nodeCount: 50, seed: SEED });
    const tree = buildChainTree(graph, SYNTHETIC_ROOT_SYSTEM_ID);
    const placed = await viaWorkerBoundary(createStubEngine()).layout({
      type: 'full',
      tree,
      mode: 'top-down',
      manualPositions: [],
    });
    const nodes: CanvasNode[] = placed.map((p) => ({ key: p.nodeKey, x: p.x, y: p.y, isAlias: p.alias }));
    const edges: CanvasEdge[] = [];
    const visit = (node: ChainNode): void => {
      for (const child of node.children) {
        if (child.parentEdge !== null) {
          edges.push({
            connectionId: String(child.parentEdge.connectionId),
            sourceKey: node.keyString,
            targetKey: child.keyString,
          });
        }
        visit(child);
      }
    };
    visit(tree.root);

    container = document.createElement('div');
    container.style.width = '800px';
    container.style.height = '600px';
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(<ReactFlowCanvas nodes={nodes} edges={edges} onNodeSelect={vi.fn()} onNodesMoved={vi.fn()} />);
    });
    expect(container.querySelectorAll('.react-flow__node')).toHaveLength(tree.nodes.length);
    expect(container.querySelectorAll('.react-flow__edge')).toHaveLength(tree.nodes.length - 1);
  });
});
