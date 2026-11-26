import type { ConnectionId, NodeKey, SystemId } from './nodeKey';

export interface ChainSystem {
  readonly id: SystemId;
}

export type MassStatus = 'fresh' | 'reduced' | 'critical';

export type LifeStage = 1 | 2 | 3 | 4;

export type ConnectionSize = 'small' | 'medium' | 'large' | 'freighter' | 'capital' | 'unknown';

export interface ConnectionAttributes {
  readonly massStatus?: MassStatus;
  readonly lifeStage?: LifeStage;
  readonly size?: ConnectionSize;
}

export interface ChainConnection extends ConnectionAttributes {
  readonly id: ConnectionId;
  readonly createdAt: number;
  readonly endA: SystemId;
  readonly endB: SystemId | null;
}

export interface ChainGraph {
  readonly systems: readonly ChainSystem[];
  readonly connections: readonly ChainConnection[];
}

export type ChainNodeKind = 'primary' | 'alias' | 'unknownEnd' | 'collapsed';

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
  readonly hiddenCount: number | null;
  readonly children: readonly ChainNode[];
}

export interface ChainTree {
  readonly root: ChainNode;
  readonly nodes: readonly ChainNode[];
}
