import { bindEngineToWorker } from '../../workerBootstrap';
import { createTidyTreeEngine } from './tidyTreeEngine';

bindEngineToWorker(createTidyTreeEngine());
