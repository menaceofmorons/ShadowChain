import { LayoutError } from './types';
import type { LayoutRequest, LayoutRequestMessage, LayoutResponseMessage, PlacedNode } from './types';
import type { Endpoint } from './transport';

export interface LayoutAdapter {
  layout(request: LayoutRequest): Promise<readonly PlacedNode[]>;
}

interface Pending {
  readonly resolve: (nodes: readonly PlacedNode[]) => void;
  readonly reject: (error: LayoutError) => void;
}

export function createLayoutAdapter(
  endpoint: Endpoint<LayoutRequestMessage, LayoutResponseMessage>,
): LayoutAdapter {
  const pending = new Map<number, Pending>();
  let nextId = 1;

  endpoint.onMessage((message) => {
    const entry = pending.get(message.id);
    if (entry === undefined) {
      return;
    }
    pending.delete(message.id);
    if (message.ok) {
      entry.resolve(message.nodes);
    } else {
      entry.reject(new LayoutError(message.error));
    }
  });

  endpoint.onError((reason) => {
    const entries = [...pending.values()];
    pending.clear();
    for (const entry of entries) {
      entry.reject(new LayoutError({ code: 'engine-failure', message: reason }));
    }
  });

  return {
    layout: (request) =>
      new Promise((resolve, reject) => {
        const id = nextId++;
        pending.set(id, { resolve, reject });
        endpoint.post({ id, request });
      }),
  };
}
