import { createWorkerHost } from '../../src/map/layout/workerHost';
import { endpointFromWorker } from '../../src/map/layout/transport';
import type { LayoutRequestMessage, LayoutResponseMessage } from '../../src/map/layout/types';
import { createEngine, isEngineName } from './engines';

if (!isEngineName(self.name)) {
  throw new Error(`unknown engine worker name: ${self.name}`);
}

createWorkerHost(createEngine(self.name), endpointFromWorker<LayoutResponseMessage, LayoutRequestMessage>(self));
