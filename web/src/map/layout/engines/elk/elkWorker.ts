import { bindEngineToWorker } from '../../workerBootstrap';
import { createElkEngine } from './elkEngine';

bindEngineToWorker(createElkEngine());
