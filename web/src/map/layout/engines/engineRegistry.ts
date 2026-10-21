import { LAYOUT_MODES } from '../types';
import type { LayoutEngine, LayoutMode, LayoutRequest, PlacedNode } from '../types';

export const ENGINE_IDS = ['tidy-tree', 'elkjs'] as const;

export type EngineId = (typeof ENGINE_IDS)[number];

export interface EngineEntry {
  readonly id: EngineId;
  readonly createEngine: () => Promise<LayoutEngine>;
  readonly createWorker: () => Worker;
}

export type EngineRegistry = Readonly<Record<LayoutMode, EngineEntry>>;

export const TIDY_TREE_ENTRY: EngineEntry = {
  id: 'tidy-tree',
  createEngine: async () => (await import('./tidyTree')).createTidyTreeEngine(),
  createWorker: () => new Worker(new URL('./tidyTree/tidyTreeWorker.ts', import.meta.url), { type: 'module' }),
};

export const ELK_ENTRY: EngineEntry = {
  id: 'elkjs',
  createEngine: async () => (await import('./elk')).createElkEngine(),
  createWorker: () => new Worker(new URL('./elk/elkWorker.ts', import.meta.url), { type: 'module' }),
};

export const DEFAULT_ENGINE_REGISTRY: EngineRegistry = {
  'top-down': TIDY_TREE_ENTRY,
  'left-to-right': TIDY_TREE_ENTRY,
  radial: ELK_ENTRY,
};

export const engineEntryForMode = (mode: LayoutMode, registry: EngineRegistry = DEFAULT_ENGINE_REGISTRY): EngineEntry =>
  registry[mode];

export const registeredEngineIds = (registry: EngineRegistry = DEFAULT_ENGINE_REGISTRY): readonly EngineId[] => [
  ...new Set(LAYOUT_MODES.map((mode) => registry[mode].id)),
];

export function createRoutedEngine(registry: EngineRegistry = DEFAULT_ENGINE_REGISTRY): LayoutEngine {
  const engines = new Map<EngineId, Promise<LayoutEngine>>();
  const engineFor = (entry: EngineEntry): Promise<LayoutEngine> => {
    const existing = engines.get(entry.id);
    if (existing !== undefined) {
      return existing;
    }
    const created = entry.createEngine();
    engines.set(entry.id, created);
    created.catch(() => {
      if (engines.get(entry.id) === created) {
        engines.delete(entry.id);
      }
    });
    return created;
  };
  return {
    async layout(request: LayoutRequest): Promise<readonly PlacedNode[]> {
      const engine = await engineFor(registry[request.mode]);
      return engine.layout(request);
    },
  };
}
