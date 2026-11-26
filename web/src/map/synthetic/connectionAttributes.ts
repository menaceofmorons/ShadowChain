import type { ConnectionAttributes, ConnectionSize, LifeStage, MassStatus } from '../model/types';
import { createPrng } from './prng';
import type { Prng } from './prng';

export const MASS_STATUSES: readonly MassStatus[] = ['fresh', 'reduced', 'critical'];
export const LIFE_STAGES: readonly LifeStage[] = [1, 2, 3, 4];
export const CONNECTION_SIZES: readonly ConnectionSize[] = [
  'small',
  'medium',
  'large',
  'freighter',
  'capital',
  'unknown',
];

const ATTRIBUTE_STREAM_SALT = 0x5eeda77;

export const createAttributeStream = (seed: number): Prng => createPrng((seed ^ ATTRIBUTE_STREAM_SALT) >>> 0);

export const drawConnectionAttributes = (stream: Prng): Required<ConnectionAttributes> => ({
  massStatus: MASS_STATUSES[stream.int(MASS_STATUSES.length)] as MassStatus,
  lifeStage: LIFE_STAGES[stream.int(LIFE_STAGES.length)] as LifeStage,
  size: CONNECTION_SIZES[stream.int(CONNECTION_SIZES.length)] as ConnectionSize,
});
