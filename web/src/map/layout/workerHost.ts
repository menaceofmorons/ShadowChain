import { LayoutError } from './types';
import type { LayoutEngine, LayoutErrorInfo, LayoutRequestMessage, LayoutResponseMessage } from './types';
import type { Endpoint } from './transport';
import { validateRequest } from './validateRequest';

const toErrorInfo = (error: unknown): LayoutErrorInfo =>
  error instanceof LayoutError
    ? { code: error.code, message: error.message }
    : { code: 'engine-failure', message: error instanceof Error ? error.message : String(error) };

export function createWorkerHost(
  engine: LayoutEngine,
  endpoint: Endpoint<LayoutResponseMessage, LayoutRequestMessage>,
): void {
  endpoint.onMessage((message) => {
    const id = message.id;
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
