import { createElkEngine } from '../layout/engines/elk';
import { createTidyTreeEngine } from '../layout/engines/tidyTree';
import type { BakeoffCandidate } from './types';

export const BAKEOFF_CANDIDATES: readonly BakeoffCandidate[] = [
  { name: 'tidy-tree', createEngine: () => createTidyTreeEngine(), modes: ['top-down', 'left-to-right'] },
  { name: 'elkjs', createEngine: () => createElkEngine(), modes: ['top-down', 'left-to-right', 'radial'] },
];
