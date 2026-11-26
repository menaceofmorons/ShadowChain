export type CanvasNodeKind = 'system' | 'alias' | 'unknown' | 'collapsed';

export interface KindSource {
  readonly key: string;
  readonly isAlias: boolean;
  readonly hiddenCount?: number | null;
}

export function canvasNodeKind(node: KindSource): CanvasNodeKind {
  if (node.hiddenCount !== undefined && node.hiddenCount !== null) {
    return 'collapsed';
  }
  if (node.isAlias) {
    return 'alias';
  }
  return node.key.startsWith('u:') ? 'unknown' : 'system';
}

const SYSTEM_KEY = /^[sa]:(\d+)/;

export function highlightSystemId(node: KindSource): number | null {
  const kind = canvasNodeKind(node);
  if (kind !== 'system' && kind !== 'alias') {
    return null;
  }
  const match = SYSTEM_KEY.exec(node.key);
  return match?.[1] === undefined ? null : Number(match[1]);
}

export function highlightGroups(nodes: readonly KindSource[]): ReadonlyMap<string, readonly string[]> {
  const bySystem = new Map<number, string[]>();
  for (const node of nodes) {
    const systemId = highlightSystemId(node);
    if (systemId !== null) {
      bySystem.set(systemId, [...(bySystem.get(systemId) ?? []), node.key]);
    }
  }
  const groups = new Map<string, readonly string[]>();
  for (const keys of bySystem.values()) {
    for (const key of keys) {
      groups.set(key, keys);
    }
  }
  return groups;
}
