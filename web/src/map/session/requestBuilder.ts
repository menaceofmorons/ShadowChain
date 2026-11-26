import { collapseChainTree } from '../model/chainOps';
import type { ChainNode, ChainTree } from '../model/types';
import { filterManualPositions } from '../layout/manualPositions';
import type {
  FullLayoutRequest,
  IncrementalLayoutRequest,
  LayoutMode,
  PlacedNode,
  PositionSource,
} from '../layout/types';
import type { PositionStore } from '../store';

export interface RequestContext {
  readonly fullTree: ChainTree;
  readonly mode: LayoutMode;
  readonly store: PositionStore;
}

export interface ReducedTree {
  readonly tree: ChainTree;
  readonly collapsedKeys: readonly string[];
}

export function reduceTree(fullTree: ChainTree, storedCollapsedKeys: readonly string[]): ReducedTree {
  const tree = collapseChainTree(fullTree, new Set(storedCollapsedKeys));
  const present = new Set(tree.nodes.map((node) => node.keyString));
  return { tree, collapsedKeys: storedCollapsedKeys.filter((key) => present.has(key)) };
}

export function buildFullRequest(context: RequestContext): FullLayoutRequest {
  const { tree, collapsedKeys } = reduceTree(context.fullTree, context.store.collapsedKeys());
  return {
    type: 'full',
    tree,
    mode: context.mode,
    manualPositions: filterManualPositions(tree, context.store.manualPositions()),
    collapsedKeys,
    rootOffset: context.store.rootOffset(),
  };
}

export interface IncrementalDelta {
  readonly previous: readonly PlacedNode[];
  readonly previousTree: ChainTree;
}

export function buildIncrementalRequest(context: RequestContext, delta: IncrementalDelta): IncrementalLayoutRequest {
  const full = buildFullRequest(context);
  const before = new Set(delta.previousTree.nodes.map((node) => node.keyString));
  const after = new Set(full.tree.nodes.map((node) => node.keyString));
  return {
    ...full,
    type: 'incremental',
    previous: delta.previous,
    addedNodeKeys: full.tree.nodes.map((node) => node.keyString).filter((key) => !before.has(key)),
    removedNodeKeys: [...before].filter((key) => !after.has(key)),
  };
}

export function withFlags(
  placed: readonly PlacedNode[],
  tree: ChainTree,
  collapsedKeys: readonly string[],
): PlacedNode[] {
  const nodes = new Map<string, ChainNode>(tree.nodes.map((node) => [node.keyString, node]));
  const collapsed = new Set(collapsedKeys);
  return placed.map((item) => {
    const node = nodes.get(item.nodeKey);
    const source: PositionSource = item.source;
    return {
      nodeKey: item.nodeKey,
      x: item.x,
      y: item.y,
      source,
      alias: node?.kind === 'alias',
      collapsed: collapsed.has(item.nodeKey),
      hiddenCount: node?.kind === 'collapsed' ? node.hiddenCount : null,
    };
  });
}
