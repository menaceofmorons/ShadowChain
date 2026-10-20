import { LayoutError } from './types';
import type { LayoutRequest, LayoutRequestMessage, LayoutResponseMessage, PlacedNode } from './types';
import type { Endpoint } from './transport';
import { isValidResponse, responseId } from './validateResponse';

export const DEFAULT_LAYOUT_TIMEOUT_MS = 10_000;

export interface LayoutAdapterOptions {
  readonly timeoutMs?: number;
}

export interface LayoutAdapter {
  layout(request: LayoutRequest): Promise<readonly PlacedNode[]>;
}

interface Pending {
  readonly resolve: (nodes: readonly PlacedNode[]) => void;
  readonly reject: (error: LayoutError) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

const engineFailure = (message: string): LayoutError => new LayoutError({ code: 'engine-failure', message });

export function createLayoutAdapter(
  endpoint: Endpoint<LayoutRequestMessage, LayoutResponseMessage>,
  options: LayoutAdapterOptions = {},
): LayoutAdapter {
  const timeoutMs = options.timeoutMs ?? DEFAULT_LAYOUT_TIMEOUT_MS;
  const pending = new Map<number, Pending>();
  let nextId = 1;
  let fatal: LayoutError | null = null;

  const settle = (id: number): Pending | undefined => {
    const entry = pending.get(id);
    if (entry !== undefined) {
      clearTimeout(entry.timer);
      pending.delete(id);
    }
    return entry;
  };

  const rejectAll = (error: LayoutError): void => {
    for (const id of [...pending.keys()]) {
      settle(id)?.reject(error);
    }
  };

  endpoint.onMessage((message: unknown) => {
    const id = responseId(message);
    if (id === null) {
      return;
    }
    const entry = settle(id);
    if (entry === undefined) {
      return;
    }
    if (!isValidResponse(message)) {
      entry.reject(engineFailure('worker returned an invalid response'));
    } else if (message.ok) {
      entry.resolve(message.nodes);
    } else {
      entry.reject(new LayoutError(message.error));
    }
  });

  endpoint.onError((reason) => {
    fatal = engineFailure(reason);
    rejectAll(fatal);
  });

  endpoint.onMessageError((reason) => {
    rejectAll(engineFailure(reason));
  });

  return {
    layout: (request) => {
      if (fatal !== null) {
        return Promise.reject(fatal);
      }
      return new Promise((resolve, reject) => {
        const id = nextId++;
        const timer = setTimeout(() => {
          settle(id)?.reject(engineFailure(`layout request timed out after ${String(timeoutMs)} ms`));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        try {
          endpoint.post({ id, request });
        } catch (error) {
          settle(id)?.reject(engineFailure(error instanceof Error ? error.message : String(error)));
        }
      });
    },
  };
}
