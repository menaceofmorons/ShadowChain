import { connectionEncoding, edgeEncodings, type ConnectionEncoding } from '../../encoding';
import type { ConnectionId } from '../../model/nodeKey';
import type { ChainConnection, ChainNode } from '../../model/types';
import type { CanvasEdge } from '../canvasAdapter';

export const NEUTRAL_ENCODINGS: readonly ConnectionEncoding[] = [connectionEncoding({})];

export function collectCanvasEdges(root: ChainNode, connections: readonly ChainConnection[]): CanvasEdge[] {
  const byId = new Map<ConnectionId, ChainConnection>(connections.map((connection) => [connection.id, connection]));
  const attributesOf = (id: ConnectionId): ChainConnection => byId.get(id) ?? ({ id } as ChainConnection);
  const edges: CanvasEdge[] = [];
  const visit = (node: ChainNode): void => {
    for (const child of node.children) {
      const parentEdge = child.parentEdge;
      edges.push({
        connectionId: parentEdge?.connectionId ?? -edges.length - 1,
        sourceKey: node.keyString,
        targetKey: child.keyString,
        encodings: parentEdge === null ? NEUTRAL_ENCODINGS : edgeEncodings(parentEdge, attributesOf),
      });
      visit(child);
    }
  };
  visit(root);
  return edges;
}
