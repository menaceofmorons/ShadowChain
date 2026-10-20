import type { LayoutEngine } from '../../src/map/layout/types';
import { createStubEngine } from '../../src/map/layout/testing/stubEngine';
import { createDelayedEngine, createShiftingEngine } from '../../src/map/harness/testing';

export const DELAY_MS = 20;

export const ENGINE_NAMES = ['stable', 'shifting', 'delayed'] as const;

export type EngineName = (typeof ENGINE_NAMES)[number];

export const isEngineName = (value: string): value is EngineName => (ENGINE_NAMES as readonly string[]).includes(value);

export const createEngine = (name: EngineName): LayoutEngine => {
  switch (name) {
    case 'stable':
      return createStubEngine();
    case 'shifting':
      return createShiftingEngine(createStubEngine());
    case 'delayed':
      return createDelayedEngine(createStubEngine(), DELAY_MS);
  }
};
