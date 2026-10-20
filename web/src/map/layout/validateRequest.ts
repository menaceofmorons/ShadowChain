import { LAYOUT_MODES, LayoutError } from './types';
import type { LayoutMode, LayoutRequest } from './types';

const fail = (message: string): never => {
  throw new LayoutError({ code: 'malformed-request', message });
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

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

const requireUnique = (keys: readonly string[], name: string): Set<string> => {
  const set = new Set(keys);
  if (set.size !== keys.length) {
    fail(`${name} must not repeat a node key`);
  }
  return set;
};

const requireConsistentTree = (tree: Record<string, unknown>): Set<string> => {
  const nodes = tree['nodes'] as unknown[];
  if (
    nodes.some((node) => !isRecord(node) || typeof node['keyString'] !== 'string' || !Array.isArray(node['children']))
  ) {
    fail('tree nodes need a keyString and children');
  }
  const typed = nodes as { keyString: string; children: { keyString?: unknown }[]; parentEdge?: unknown }[];
  const keys = requireUnique(
    typed.map((node) => node.keyString),
    'tree nodes',
  );
  const root = tree['root'] as { keyString?: unknown };
  if (typeof root['keyString'] !== 'string' || !keys.has(root['keyString'])) {
    fail('tree root must be one of the tree nodes');
  }
  for (const node of typed) {
    for (const child of node.children) {
      if (typeof child.keyString !== 'string' || !keys.has(child.keyString)) {
        fail('tree children must reference existing nodes');
      }
    }
  }
  const roots = typed.filter((node) => node.parentEdge === null || node.parentEdge === undefined);
  if (roots.length !== 1 || roots[0]?.keyString !== root['keyString']) {
    fail('tree must have exactly one root');
  }
  return keys;
};

const requireConsistentIncremental = (value: Record<string, unknown>, treeKeys: Set<string>): void => {
  const previous = requireUnique(
    (value['previous'] as { nodeKey: string }[]).map((item) => item.nodeKey),
    'previous',
  );
  const added = requireUnique(value['addedNodeKeys'] as string[], 'addedNodeKeys');
  const removed = requireUnique(value['removedNodeKeys'] as string[], 'removedNodeKeys');
  for (const key of added) {
    if (!treeKeys.has(key)) {
      fail('addedNodeKeys must exist in the tree');
    }
    if (previous.has(key)) {
      fail('addedNodeKeys must not already be placed');
    }
  }
  for (const key of removed) {
    if (treeKeys.has(key)) {
      fail('removedNodeKeys must not exist in the tree');
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
  const treeKeys = requireConsistentTree(tree as Record<string, unknown>);
  const manual = requireUnique(
    (value['manualPositions'] as { nodeKey: string }[]).map((item) => item.nodeKey),
    'manualPositions',
  );
  for (const key of manual) {
    if (!treeKeys.has(key)) {
      fail('manualPositions must reference tree nodes');
    }
  }
  if (value['type'] === 'incremental') {
    requireConsistentIncremental(value, treeKeys);
  }
  return value as unknown as LayoutRequest;
}
