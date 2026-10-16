import type { ConnectionId, NodeKey, SystemId } from './nodeKey';

export interface ChainSystem {
  readonly id: SystemId;
}

export interface ChainConnection {
  readonly id: ConnectionId;
  readonly createdAt: number;
  readonly endA: SystemId;
  readonly endB: SystemId | null;
}

export interface ChainGraph {
  readonly systems: readonly ChainSystem[];
  readonly connections: readonly ChainConnection[];
}

export type ChainNodeKind = 'primary' | 'alias' | 'unknownEnd';

export interface ChainEdge {
  readonly connectionId: ConnectionId;
  readonly parallelConnectionIds: readonly ConnectionId[];
}

export interface ChainNode {
  readonly key: NodeKey;
  readonly keyString: string;
  readonly kind: ChainNodeKind;
  readonly systemId: SystemId | null;
  readonly parentEdge: ChainEdge | null;
  readonly children: readonly ChainNode[];
}

export interface ChainTree {
  readonly root: ChainNode;
  readonly nodes: readonly ChainNode[];
}
