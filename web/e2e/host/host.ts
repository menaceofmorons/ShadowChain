import { createLayoutAdapter } from '../../src/map/layout/layoutAdapter';
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
import { generateChain, generateChurnScript, SYNTHETIC_ROOT_SYSTEM_ID } from '../../src/map/synthetic';
import { isEngineName } from './engines';

export interface HostResult {
  readonly report: HarnessReport;
  readonly finalPlaced: readonly PlacedNode[];
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

async function run(): Promise<HostResult> {
  const params = new URLSearchParams(window.location.search);
  const engineName = params.get('engine') ?? 'stable';
  if (!isEngineName(engineName)) {
    throw new Error(`unknown engine: ${engineName}`);
  }
  const size = numberParam(params, 'size', 50);
  const seed = numberParam(params, 'seed', 1);
  const churnCount = numberParam(params, 'churn', 10);
  const fullRepeats = numberParam(params, 'repeats', 3);

  const worker = new Worker(new URL('./engineWorker.ts', import.meta.url), { type: 'module', name: engineName });
  const adapter = createLayoutAdapter(endpointFromWorker<LayoutRequestMessage, LayoutResponseMessage>(worker));

  let finalPlaced: readonly PlacedNode[] = [];
  const engine: LayoutEngine = {
    layout: async (request) => {
      finalPlaced = await adapter.layout(request);
      return finalPlaced;
    },
  };

  const graph = generateChain({ nodeCount: size, seed });
  const report = await runHarness({
    label: engineName,
    engine,
    graph,
    rootSystemId: SYNTHETIC_ROOT_SYSTEM_ID,
    churn: generateChurnScript(graph, { seed: seed + 1, operationCount: churnCount }),
    engineSources: [],
    mode: modeParam(params),
    fullRepeats,
  });
  worker.terminate();
  return { report, finalPlaced };
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
