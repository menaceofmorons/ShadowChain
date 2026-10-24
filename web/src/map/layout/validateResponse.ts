import type { LayoutErrorInfo, LayoutResponseMessage, PlacedNode } from './types';

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

const isPlacedNode = (value: unknown): value is PlacedNode =>
  isRecord(value) &&
  typeof value['nodeKey'] === 'string' &&
  typeof value['x'] === 'number' &&
  Number.isFinite(value['x']) &&
  typeof value['y'] === 'number' &&
  Number.isFinite(value['y']) &&
  (value['source'] === 'auto' || value['source'] === 'manual') &&
  typeof value['alias'] === 'boolean' &&
  typeof value['collapsed'] === 'boolean' &&
  (value['hiddenCount'] === null ||
    (typeof value['hiddenCount'] === 'number' && Number.isInteger(value['hiddenCount'])));

const isErrorInfo = (value: unknown): value is LayoutErrorInfo =>
  isRecord(value) &&
  (value['code'] === 'malformed-request' || value['code'] === 'engine-failure') &&
  typeof value['message'] === 'string';

export function responseId(message: unknown): number | null {
  if (!isRecord(message)) {
    return null;
  }
  const id = message['id'];
  return typeof id === 'number' && Number.isFinite(id) ? id : null;
}

export function isValidResponse(message: unknown): message is LayoutResponseMessage {
  if (!isRecord(message)) {
    return false;
  }
  if (message['ok'] === true) {
    return Array.isArray(message['nodes']) && (message['nodes'] as unknown[]).every(isPlacedNode);
  }
  return message['ok'] === false && isErrorInfo(message['error']);
}
