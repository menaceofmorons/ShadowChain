import { LayoutError } from './types';
import type { LayoutEngine, LayoutErrorInfo, LayoutRequestMessage, LayoutResponseMessage } from './types';
import type { Endpoint } from './transport';
import { validateRequest } from './validateRequest';

export interface WorkerHostOptions {
  readonly onInvalidEnvelope?: (reason: string) => void;
}

const toErrorInfo = (error: unknown): LayoutErrorInfo =>
  error instanceof LayoutError
    ? { code: error.code, message: error.message }
    : { code: 'engine-failure', message: error instanceof Error ? error.message : String(error) };

const usableId = (message: unknown): number | null => {
  if (typeof message !== 'object' || message === null) {
    return null;
  }
  const id = (message as { id?: unknown }).id;
  return typeof id === 'number' && Number.isFinite(id) ? id : null;
};

export function createWorkerHost(
  engine: LayoutEngine,
  endpoint: Endpoint<LayoutResponseMessage, LayoutRequestMessage>,
  options: WorkerHostOptions = {},
): void {
  endpoint.onMessage((message) => {
    const id = usableId(message);
    if (id === null) {
      options.onInvalidEnvelope?.('request envelope has no usable id');
      return;
    }
    void (async () => {
      try {
        const request = validateRequest(message.request);
        const nodes = await engine.layout(request);
        endpoint.post({ id, ok: true, nodes });
      } catch (error) {
        endpoint.post({ id, ok: false, error: toErrorInfo(error) });
      }
    })();
  });
}
