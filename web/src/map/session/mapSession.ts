import { removeConnections as removeGraphConnections } from '../model/chainOps';
import { buildChainTree } from '../model/chainTree';
import type { ChainConnection, ChainGraph, ChainSystem, ChainTree } from '../model/types';
import type { ConnectionId, SystemId } from '../model/nodeKey';
import { createRegistryAdapter } from '../layout/engines/registryAdapter';
import type { LayoutEngine, LayoutMode, LayoutRequest, ManualPosition, PlacedNode } from '../layout/types';
import type { PositionStore } from '../store';
import { buildFullRequest, buildIncrementalRequest, reduceTree, withFlags } from './requestBuilder';
import type { RequestContext } from './requestBuilder';

export const COLLAPSED_MARKER_PREFIX = '+:';

export interface MapSessionOptions {
  readonly graph: ChainGraph;
  readonly rootSystemId: SystemId;
  readonly mode: LayoutMode;
  readonly store: PositionStore;
  readonly layout?: LayoutEngine;
}

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface Delta {
  readonly dx: number;
  readonly dy: number;
}

export type PlacedListener = (node: PlacedNode | undefined) => void;

export interface MapSession {
  readonly store: PositionStore;
  readonly mode: () => LayoutMode;
  readonly graph: () => ChainGraph;
  readonly tree: () => ChainTree;
  readonly placedNodes: () => readonly PlacedNode[];
  readonly open: () => Promise<void>;
  readonly setMode: (mode: LayoutMode) => Promise<void>;
  readonly addConnection: (connection: ChainConnection, newSystems?: readonly ChainSystem[]) => Promise<void>;
  readonly removeConnections: (connectionIds: readonly ConnectionId[]) => Promise<void>;
  readonly dragNode: (nodeKey: string, to: Point) => Promise<readonly ManualPosition[]>;
  readonly dragNodeAlone: (nodeKey: string, to: Point) => Promise<readonly ManualPosition[]>;
  readonly dragGroup: (nodeKeys: readonly string[], delta: Delta) => Promise<readonly ManualPosition[]>;
  readonly moveRoot: (rootOffset: number) => Promise<boolean>;
  readonly resetPosition: (nodeKey: string) => Promise<void>;
  readonly tidy: () => Promise<void>;
  readonly setCollapsed: (nodeKey: string, collapsed: boolean) => Promise<void>;
  readonly subscribe: (listener: () => void) => () => void;
  readonly subscribeNode: (nodeKey: string, listener: PlacedListener) => () => void;
  readonly dispose: () => void;
}

const samePlacement = (a: PlacedNode | undefined, b: PlacedNode | undefined): boolean =>
  a === b ||
  (a !== undefined &&
    b !== undefined &&
    a.x === b.x &&
    a.y === b.y &&
    a.source === b.source &&
    a.alias === b.alias &&
    a.collapsed === b.collapsed &&
    a.hiddenCount === b.hiddenCount);

export function createMapSession(options: MapSessionOptions): MapSession {
  const { store, rootSystemId } = options;
  const ownedAdapter = options.layout === undefined ? createRegistryAdapter() : null;
  const engine: LayoutEngine = options.layout ?? (ownedAdapter as LayoutEngine);

  let graph = options.graph;
  let mode = options.mode;
  let fullTree = buildChainTree(graph, rootSystemId);
  let shownTree: ChainTree = reduceTree(fullTree, store.collapsedKeys()).tree;
  let placed: readonly PlacedNode[] = [];
  let placedByKey = new Map<string, PlacedNode>();
  let tail: Promise<unknown> = Promise.resolve();

  const sessionListeners = new Set<() => void>();
  const nodeListeners = new Map<string, Set<PlacedListener>>();

  const context = (): RequestContext => ({ fullTree, mode, store });

  const exclusive = <T>(task: () => Promise<T>): Promise<T> => {
    const run = tail.then(task, task);
    tail = run.catch(() => undefined);
    return run;
  };

  const apply = (request: LayoutRequest, nodes: readonly PlacedNode[]): void => {
    const next = withFlags(nodes, request.tree, request.collapsedKeys ?? []);
    const nextByKey = new Map(next.map((node) => [node.nodeKey, node]));
    const changed = new Set<string>();
    for (const [key, node] of nextByKey) {
      if (!samePlacement(placedByKey.get(key), node)) changed.add(key);
    }
    for (const key of placedByKey.keys()) {
      if (!nextByKey.has(key)) changed.add(key);
    }
    placed = next;
    placedByKey = nextByKey;
    shownTree = request.tree;
    for (const key of changed) {
      for (const listener of [...(nodeListeners.get(key) ?? [])]) listener(nextByKey.get(key));
    }
    for (const listener of [...sessionListeners]) listener();
  };

  const layoutFull = async (): Promise<void> => {
    const request = buildFullRequest(context());
    apply(request, await engine.layout(request));
  };

  const layoutIncremental = async (previousTree: ChainTree): Promise<void> => {
    if (placed.length === 0) {
      await layoutFull();
      return;
    }
    const request = buildIncrementalRequest(context(), { previous: placed, previousTree });
    apply(request, await engine.layout(request));
  };

  const placement = (nodeKey: string): PlacedNode => {
    const node = placedByKey.get(nodeKey);
    if (node === undefined) {
      throw new Error(`Node is not placed: ${nodeKey}`);
    }
    return node;
  };

  const isDraggable = (nodeKey: string): boolean => {
    const node = shownTree.nodes.find((candidate) => candidate.keyString === nodeKey);
    return node !== undefined && node.kind !== 'collapsed' && nodeKey !== shownTree.root.keyString;
  };

  const writeManual = async (positions: readonly ManualPosition[]): Promise<readonly ManualPosition[]> => {
    if (positions.length === 0) return positions;
    store.setManualPositions(positions);
    await layoutFull();
    return positions;
  };

  const moved = (nodeKey: string, to: Point): ManualPosition => ({ nodeKey, x: to.x, y: to.y });

  return {
    store,
    mode: () => mode,
    graph: () => graph,
    tree: () => shownTree,
    placedNodes: () => placed,
    open: () => exclusive(layoutFull),
    setMode: (next) =>
      exclusive(async () => {
        if (next === mode) return;
        mode = next;
        await layoutFull();
      }),
    addConnection: (connection, newSystems = []) =>
      exclusive(async () => {
        const previousTree = shownTree;
        const known = new Set(graph.systems.map((system) => system.id));
        graph = {
          systems: [...graph.systems, ...newSystems.filter((system) => !known.has(system.id))],
          connections: [...graph.connections, connection],
        };
        fullTree = buildChainTree(graph, rootSystemId);
        await layoutIncremental(previousTree);
      }),
    removeConnections: (connectionIds) =>
      exclusive(async () => {
        const previousTree = shownTree;
        graph = removeGraphConnections(graph, connectionIds);
        fullTree = buildChainTree(graph, rootSystemId);
        await layoutIncremental(previousTree);
      }),
    dragNode: (nodeKey, to) =>
      exclusive(async () => {
        placement(nodeKey);
        return await writeManual(isDraggable(nodeKey) ? [moved(nodeKey, to)] : []);
      }),
    dragNodeAlone: (nodeKey, to) =>
      exclusive(async () => {
        placement(nodeKey);
        if (!isDraggable(nodeKey)) return [];
        const node = shownTree.nodes.find((candidate) => candidate.keyString === nodeKey);
        const children = (node?.children ?? []).filter((child) => child.kind !== 'collapsed');
        const pinned = children.map((child): ManualPosition => {
          const at = placement(child.keyString);
          return { nodeKey: child.keyString, x: at.x, y: at.y };
        });
        return await writeManual([moved(nodeKey, to), ...pinned]);
      }),
    dragGroup: (nodeKeys, delta) =>
      exclusive(async () => {
        const unique = [...new Set(nodeKeys)].filter((key) => placedByKey.has(key) && isDraggable(key));
        return await writeManual(
          unique.map((key) => {
            const at = placement(key);
            return moved(key, { x: at.x + delta.dx, y: at.y + delta.dy });
          }),
        );
      }),
    moveRoot: (rootOffset) =>
      exclusive(async () => {
        if (mode === 'radial') return false;
        store.setRootOffset(rootOffset);
        await layoutFull();
        return true;
      }),
    resetPosition: (nodeKey) =>
      exclusive(async () => {
        store.resetPosition(nodeKey);
        await layoutFull();
      }),
    tidy: () =>
      exclusive(async () => {
        store.clearManual();
        await layoutFull();
      }),
    setCollapsed: (nodeKey, collapsed) =>
      exclusive(async () => {
        const target = nodeKey.startsWith(COLLAPSED_MARKER_PREFIX)
          ? nodeKey.slice(COLLAPSED_MARKER_PREFIX.length)
          : nodeKey;
        store.setCollapsed(target, collapsed);
        await layoutFull();
      }),
    subscribe: (listener) => {
      sessionListeners.add(listener);
      return () => sessionListeners.delete(listener);
    },
    subscribeNode: (nodeKey, listener) => {
      const set = nodeListeners.get(nodeKey) ?? new Set<PlacedListener>();
      set.add(listener);
      nodeListeners.set(nodeKey, set);
      return () => set.delete(listener);
    },
    dispose: () => {
      sessionListeners.clear();
      nodeListeners.clear();
      ownedAdapter?.dispose();
    },
  };
}
