import { createWorkerHost } from './workerHost';
import { endpointFromWorker } from './transport';
import type { Endpoint, WorkerLike } from './transport';
import type { LayoutEngine, LayoutRequestMessage, LayoutResponseMessage } from './types';

export function bindEngineToWorker(
  engine: LayoutEngine,
  endpoint: Endpoint<LayoutResponseMessage, LayoutRequestMessage> = endpointFromWorker(
    globalThis as unknown as WorkerLike,
  ),
): void {
  createWorkerHost(engine, endpoint);
}
