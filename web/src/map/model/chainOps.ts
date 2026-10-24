import { buildChainTree } from './chainTree';
import { collapsedKey, serialiseNodeKey, type ConnectionId, type PersistedNodeKey, type SystemId } from './nodeKey';
import type { ChainGraph, ChainNode, ChainTree } from './types';

export function removeConnections(graph: ChainGraph, connectionIds: readonly ConnectionId[]): ChainGraph {
  const removed = new Set(connectionIds);
  return { systems: graph.systems, connections: graph.connections.filter((c) => !removed.has(c.id)) };
}

export function removeConnectionFromTree(
  graph: ChainGraph,
  rootSystemId: SystemId,
  connectionIds: readonly ConnectionId[],
): ChainTree {
  return buildChainTree(removeConnections(graph, connectionIds), rootSystemId);
}

export function disconnectedSystemIds(graph: ChainGraph, tree: ChainTree): readonly SystemId[] {
  const inTree = new Set<SystemId>();
  for (const node of tree.nodes) {
    if (node.kind === 'primary' && node.systemId !== null) inTree.add(node.systemId);
  }
  return graph.systems.map((system) => system.id).filter((id) => !inTree.has(id));
}

const subtreeSize = (node: ChainNode): number => node.children.reduce((sum, child) => sum + 1 + subtreeSize(child), 0);

function collapseNode(node: ChainNode, collapsed: ReadonlySet<string>): ChainNode {
  if (collapsed.has(node.keyString)) {
    const hidden = subtreeSize(node);
    if (hidden === 0) return node;
    const target = node.key as PersistedNodeKey;
    const key = collapsedKey(target);
    const leaf: ChainNode = {
      key,
      keyString: serialiseNodeKey(key),
      kind: 'collapsed',
      systemId: null,
      parentEdge: null,
      hiddenCount: hidden,
      children: [],
    };
    return { ...node, children: [leaf] };
  }
  return { ...node, children: node.children.map((child) => collapseNode(child, collapsed)) };
}

function flatten(node: ChainNode, out: ChainNode[]): ChainNode[] {
  out.push(node);
  for (const child of node.children) flatten(child, out);
  return out;
}

export function collapseChainTree(tree: ChainTree, collapsedKeys: ReadonlySet<string>): ChainTree {
  if (collapsedKeys.size === 0) return tree;
  const root = collapseNode(tree.root, collapsedKeys);
  return { root, nodes: flatten(root, []) };
}
