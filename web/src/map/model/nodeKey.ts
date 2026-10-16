export type SystemId = number;
export type ConnectionId = number;

export type NodeKey =
  | { readonly kind: 'system'; readonly systemId: SystemId }
  | { readonly kind: 'alias'; readonly systemId: SystemId; readonly connectionId: ConnectionId }
  | { readonly kind: 'unknownEnd'; readonly connectionId: ConnectionId };

export const systemKey = (systemId: SystemId): NodeKey => ({ kind: 'system', systemId });

export const aliasKey = (systemId: SystemId, connectionId: ConnectionId): NodeKey => ({
  kind: 'alias',
  systemId,
  connectionId,
});

export const unknownEndKey = (connectionId: ConnectionId): NodeKey => ({
  kind: 'unknownEnd',
  connectionId,
});

export function serialiseNodeKey(key: NodeKey): string {
  switch (key.kind) {
    case 'system':
      return `s:${key.systemId}`;
    case 'alias':
      return `a:${key.systemId}:${key.connectionId}`;
    case 'unknownEnd':
      return `u:${key.connectionId}`;
  }
}

const KEY_PATTERN = /^(?:s:(\d+)|a:(\d+):(\d+)|u:(\d+))$/;

export function parseNodeKey(text: string): NodeKey {
  const match = KEY_PATTERN.exec(text);
  if (match === null) {
    throw new Error(`Invalid node key: ${text}`);
  }
  const [, system, aliasSystem, aliasConnection, unknownConnection] = match;
  if (system !== undefined) {
    return systemKey(Number(system));
  }
  if (aliasSystem !== undefined && aliasConnection !== undefined) {
    return aliasKey(Number(aliasSystem), Number(aliasConnection));
  }
  return unknownEndKey(Number(unknownConnection));
}
