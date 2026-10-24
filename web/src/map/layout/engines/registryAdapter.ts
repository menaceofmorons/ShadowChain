import { createLayoutAdapter } from '../layoutAdapter';
import type { LayoutAdapter } from '../layoutAdapter';
import { endpointFromWorker } from '../transport';
import type { LayoutRequestMessage, LayoutResponseMessage } from '../types';
import { DEFAULT_ENGINE_REGISTRY } from './engineRegistry';
import type { EngineId, EngineRegistry } from './engineRegistry';

export interface RegistryAdapter extends LayoutAdapter {
  dispose(): void;
}

export function createRegistryAdapter(registry: EngineRegistry = DEFAULT_ENGINE_REGISTRY): RegistryAdapter {
  const workers = new Map<EngineId, { worker: Worker; adapter: LayoutAdapter }>();
  return {
    layout: async (request) => {
      const entry = registry[request.mode];
      let running = workers.get(entry.id);
      if (running === undefined) {
        const worker = entry.createWorker();
        const endpoint = endpointFromWorker<LayoutRequestMessage, LayoutResponseMessage>(worker);
        const created = {
          worker,
          adapter: createLayoutAdapter({
            ...endpoint,
            onError: (handler) => {
              endpoint.onError((reason) => {
                if (workers.get(entry.id) === created) {
                  workers.delete(entry.id);
                }
                worker.terminate();
                handler(reason);
              });
            },
          }),
        };
        running = created;
        workers.set(entry.id, running);
      }
      return await running.adapter.layout(request);
    },
    dispose: () => {
      for (const { worker } of workers.values()) {
        worker.terminate();
      }
      workers.clear();
    },
  };
}
