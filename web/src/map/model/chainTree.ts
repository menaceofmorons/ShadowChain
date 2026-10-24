import {
  aliasKey,
  serialiseNodeKey,
  systemKey,
  unknownEndKey,
  type ConnectionId,
  type NodeKey,
  type SystemId,
} from './nodeKey';
import type { ChainConnection, ChainEdge, ChainGraph, ChainNode, ChainNodeKind, ChainTree } from './types';

interface MutableNode {
  key: NodeKey;
  kind: ChainNodeKind;
  systemId: SystemId | null;
  parentEdge: ChainEdge | null;
  children: MutableNode[];
}

interface Candidate {
  parent: MutableNode;
  connection: ChainConnection;
}

const byCreation = (a: ChainConnection, b: ChainConnection): number => a.createdAt - b.createdAt || a.id - b.id;

const otherEnd = (connection: ChainConnection, systemId: SystemId): SystemId | null =>
  connection.endA === systemId ? connection.endB : connection.endA;

function freeze(node: MutableNode): ChainNode {
  return {
    key: node.key,
    keyString: serialiseNodeKey(node.key),
    kind: node.kind,
    systemId: node.systemId,
    parentEdge: node.parentEdge,
    hiddenCount: null,
    children: node.children.map(freeze),
  };
}

function flatten(node: ChainNode, out: ChainNode[]): void {
  out.push(node);
  for (const child of node.children) flatten(child, out);
}

export function buildChainTree(graph: ChainGraph, rootSystemId: SystemId): ChainTree {
  if (!graph.systems.some((system) => system.id === rootSystemId)) {
    throw new Error(`Root system ${rootSystemId} is not in the chain graph`);
  }

  const bySystem = new Map<SystemId, ChainConnection[]>();
  for (const connection of [...graph.connections].sort(byCreation)) {
    for (const end of new Set([connection.endA, connection.endB])) {
      if (end === null) continue;
      const list = bySystem.get(end) ?? [];
      list.push(connection);
      bySystem.set(end, list);
    }
  }

  const root: MutableNode = {
    key: systemKey(rootSystemId),
    kind: 'primary',
    systemId: rootSystemId,
    parentEdge: null,
    children: [],
  };
  const primaries = new Set<SystemId>([rootSystemId]);
  const consumed = new Set<ConnectionId>();
  let level: MutableNode[] = [root];

  while (level.length > 0) {
    const candidates: Candidate[] = [];
    for (const parent of level) {
      for (const connection of bySystem.get(parent.systemId as SystemId) ?? []) {
        candidates.push({ parent, connection });
      }
    }
    candidates.sort((a, b) => byCreation(a.connection, b.connection));

    const next: MutableNode[] = [];
    for (const { parent, connection } of candidates) {
      if (consumed.has(connection.id)) continue;
      const parentSystem = parent.systemId as SystemId;
      const far = otherEnd(connection, parentSystem);
      consumed.add(connection.id);

      if (far === null) {
        parent.children.push({
          key: unknownEndKey(connection.id),
          kind: 'unknownEnd',
          systemId: null,
          parentEdge: { connectionId: connection.id, parallelConnectionIds: [] },
          children: [],
        });
        continue;
      }

      const parallelConnectionIds = (bySystem.get(parentSystem) ?? [])
        .filter((other) => !consumed.has(other.id) && otherEnd(other, parentSystem) === far)
        .map((other) => other.id);
      for (const id of parallelConnectionIds) consumed.add(id);
      const parentEdge: ChainEdge = { connectionId: connection.id, parallelConnectionIds };

      if (primaries.has(far)) {
        parent.children.push({
          key: aliasKey(far, connection.id),
          kind: 'alias',
          systemId: far,
          parentEdge,
          children: [],
        });
      } else {
        primaries.add(far);
        const child: MutableNode = {
          key: systemKey(far),
          kind: 'primary',
          systemId: far,
          parentEdge,
          children: [],
        };
        parent.children.push(child);
        next.push(child);
      }
    }
    level = next;
  }

  const frozenRoot = freeze(root);
  const nodes: ChainNode[] = [];
  flatten(frozenRoot, nodes);
  return { root: frozenRoot, nodes };
}
