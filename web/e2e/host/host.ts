import { createLayoutAdapter } from '../../src/map/layout/layoutAdapter';
import type { LayoutAdapter } from '../../src/map/layout/layoutAdapter';
import { endpointFromWorker } from '../../src/map/layout/transport';
import type {
  LayoutEngine,
  LayoutMode,
  LayoutRequestMessage,
  LayoutResponseMessage,
  PlacedNode,
} from '../../src/map/layout/types';
import { LAYOUT_MODES } from '../../src/map/layout/types';
import { runHarness } from '../../src/map/harness/metricsHarness';
import type { HarnessReport } from '../../src/map/harness/metricsHarness';
import { buildChainTree } from '../../src/map/model/chainTree';
import { collapseChainTree } from '../../src/map/model/chainOps';
import { generateChain, generateChurnScript, SYNTHETIC_ROOT_SYSTEM_ID } from '../../src/map/synthetic';
import { isEngineName } from './engines';
import { createRegistryAdapter } from '../../src/map/layout/engines/registryAdapter';
import { isCandidateName } from './candidates';
import type { CandidateName } from './candidates';

export interface HostResult {
  readonly report: HarnessReport;
  readonly finalPlaced: readonly PlacedNode[];
  readonly collapsedPlaced: readonly PlacedNode[];
  readonly collapsedHiddenTotal: number;
}

export interface HostState {
  done: boolean;
  result: HostResult | null;
  error: string | null;
}

declare global {
  interface Window {
    __harness: HostState;
  }
}

const state: HostState = { done: false, result: null, error: null };
window.__harness = state;

const numberParam = (params: URLSearchParams, name: string, fallback: number): number => {
  const raw = params.get(name);
  return raw === null ? fallback : Number(raw);
};

const modeParam = (params: URLSearchParams): LayoutMode => {
  const raw = params.get('mode') ?? 'top-down';
  const mode = LAYOUT_MODES.find((candidate) => candidate === raw);
  if (mode === undefined) {
    throw new Error(`unknown mode: ${raw}`);
  }
  return mode;
};

const createCandidateWorker = (name: CandidateName): Worker => {
  switch (name) {
    case 'tidy-tree':
      return new Worker(new URL('../../src/map/layout/engines/tidyTree/tidyTreeWorker.ts', import.meta.url), {
        type: 'module',
      });
    case 'elkjs':
      return new Worker(new URL('../../src/map/layout/engines/elk/elkWorker.ts', import.meta.url), {
        type: 'module',
      });
  }
};

const createWorker = (engineName: string): Worker => {
  if (isCandidateName(engineName)) {
    return createCandidateWorker(engineName);
  }
  if (!isEngineName(engineName)) {
    throw new Error(`unknown engine: ${engineName}`);
  }
  return new Worker(new URL('./engineWorker.ts', import.meta.url), { type: 'module', name: engineName });
};

const createSingleWorkerAdapter = (
  engineName: string,
  timeoutMs: number | undefined,
): { layout: LayoutAdapter['layout']; dispose: () => void } => {
  const worker = createWorker(engineName);
  const adapter = createLayoutAdapter(
    endpointFromWorker<LayoutRequestMessage, LayoutResponseMessage>(worker),
    timeoutMs === undefined ? undefined : { timeoutMs },
  );
  return {
    layout: (request) => adapter.layout(request),
    dispose: () => {
      worker.terminate();
    },
  };
};

async function run(): Promise<HostResult> {
  const params = new URLSearchParams(window.location.search);
  const engineName = params.get('engine') ?? 'stable';
  const size = numberParam(params, 'size', 50);
  const seed = numberParam(params, 'seed', 1);
  const churnCount = numberParam(params, 'churn', 10);
  const fullRepeats = numberParam(params, 'repeats', 3);

  const warmupRepeats = numberParam(params, 'warmup', 0);
  const timeoutParam = params.get('timeoutMs');
  const adapter =
    engineName === 'registry'
      ? createRegistryAdapter()
      : createSingleWorkerAdapter(engineName, timeoutParam === null ? undefined : Number(timeoutParam));

  let finalPlaced: readonly PlacedNode[] = [];
  const engine: LayoutEngine = {
    layout: async (request) => {
      finalPlaced = await adapter.layout(request);
      return finalPlaced;
    },
  };

  const graph = generateChain({ nodeCount: size, seed });
  const mode = modeParam(params);
  const churn = generateChurnScript(graph, { seed: seed + 1, operationCount: churnCount });
  if (warmupRepeats > 0) {
    await runHarness({
      label: engineName,
      engine,
      graph,
      rootSystemId: SYNTHETIC_ROOT_SYSTEM_ID,
      churn: churn.slice(0, Math.min(churn.length, 4)),
      engineSources: [],
      mode,
      fullRepeats: warmupRepeats,
    });
  }
  const report = await runHarness({
    label: engineName,
    engine,
    graph,
    rootSystemId: SYNTHETIC_ROOT_SYSTEM_ID,
    churn,
    engineSources: [],
    mode,
    fullRepeats,
  });
  const fullTree = buildChainTree(graph, SYNTHETIC_ROOT_SYSTEM_ID);
  const branchRoot = fullTree.nodes.find(
    (node) => node.keyString !== fullTree.root.keyString && node.kind === 'primary' && node.children.length >= 2,
  );
  const collapseKeys = branchRoot === undefined ? [] : [branchRoot.keyString];
  const collapsedTree = collapseChainTree(fullTree, new Set(collapseKeys));
  const collapsedPlaced = await adapter.layout({
    type: 'full',
    tree: collapsedTree,
    mode,
    manualPositions: [],
    collapsedKeys: collapseKeys,
  });
  const collapsedHiddenTotal = fullTree.nodes.length - collapsedTree.nodes.length + (collapseKeys.length > 0 ? 1 : 0);
  adapter.dispose();
  return { report, finalPlaced, collapsedPlaced, collapsedHiddenTotal };
}

run()
  .then((result) => {
    state.result = result;
  })
  .catch((error: unknown) => {
    state.error = error instanceof Error ? error.message : String(error);
  })
  .finally(() => {
    state.done = true;
  });
