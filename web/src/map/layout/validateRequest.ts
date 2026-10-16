import { LAYOUT_MODES, LayoutError } from './types';
import type { LayoutMode, LayoutRequest } from './types';

const fail = (message: string): never => {
  throw new LayoutError({ code: 'malformed-request', message });
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const requireStringArray = (value: unknown, name: string): void => {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    fail(`${name} must be an array of strings`);
  }
};

const requirePlacements = (value: unknown, name: string, withSource: boolean): void => {
  if (!Array.isArray(value)) {
    fail(`${name} must be an array`);
    return;
  }
  for (const item of value as unknown[]) {
    if (
      !isRecord(item) ||
      typeof item['nodeKey'] !== 'string' ||
      typeof item['x'] !== 'number' ||
      typeof item['y'] !== 'number' ||
      !Number.isFinite(item['x']) ||
      !Number.isFinite(item['y'])
    ) {
      fail(`${name} entries need nodeKey, x and y`);
      return;
    }
    if (withSource && item['source'] !== 'auto' && item['source'] !== 'manual') {
      fail(`${name} entries need a source of auto or manual`);
    }
  }
};

export function validateRequest(value: unknown): LayoutRequest {
  if (!isRecord(value)) {
    return fail('request must be an object');
  }
  if (value['type'] !== 'full' && value['type'] !== 'incremental') {
    fail('request type must be full or incremental');
  }
  if (!LAYOUT_MODES.includes(value['mode'] as LayoutMode)) {
    fail('request mode is not a layout mode');
  }
  const tree = value['tree'];
  if (!isRecord(tree) || !isRecord(tree['root']) || !Array.isArray(tree['nodes'])) {
    fail('request tree must have a root and nodes');
  }
  requirePlacements(value['manualPositions'], 'manualPositions', false);
  if (value['type'] === 'incremental') {
    requirePlacements(value['previous'], 'previous', true);
    requireStringArray(value['addedNodeKeys'], 'addedNodeKeys');
    requireStringArray(value['removedNodeKeys'], 'removedNodeKeys');
  }
  return value as unknown as LayoutRequest;
}
