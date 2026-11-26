import { useCallback, useMemo, useRef, useState } from 'react';
import { applyNodeChanges, Position, ReactFlow, type Edge, type Node, type NodeChange } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { DEFAULT_ENGINE_OPTIONS, nodeSizeForKind } from '../layout/engineOptions';
import type { LayoutMode } from '../layout/types';
import type { CanvasAdapterProps, CanvasNode, MovedNode } from './canvasAdapter';
import { NODE_TYPES, SIDES, type BoxData, type BoxNode } from './canvasNodes';
import { createHighlightStore, HighlightContext } from './highlightStore';
import { canvasNodeKind, highlightGroups, type CanvasNodeKind } from './nodeKinds';

const handlePoint = (position: Position, width: number, height: number): { x: number; y: number } => {
  switch (position) {
    case Position.Top:
      return { x: width / 2, y: 0 };
    case Position.Bottom:
      return { x: width / 2, y: height };
    case Position.Left:
      return { x: 0, y: height / 2 };
    case Position.Right:
      return { x: width, y: height / 2 };
  }
};

const ENGINE_KIND = { system: 'primary', alias: 'alias', unknown: 'unknownEnd', collapsed: 'collapsed' } as const;

const labelFor = (kind: CanvasNodeKind, node: CanvasNode): string => {
  switch (kind) {
    case 'collapsed':
      return `+${String(node.hiddenCount)}`;
    case 'unknown':
      return '?';
    default:
      return node.key;
  }
};

const sameData = (a: BoxData, b: BoxData): boolean =>
  a.label === b.label &&
  a.width === b.width &&
  a.height === b.height &&
  a.mode === b.mode &&
  a.isRoot === b.isRoot &&
  a.kind === b.kind;

function toBoxNode(node: CanvasNode, mode: LayoutMode): BoxNode {
  const kind = canvasNodeKind(node);
  const { width, height } = nodeSizeForKind(ENGINE_KIND[kind], DEFAULT_ENGINE_OPTIONS);
  const sides = SIDES[mode];
  const point = (position: Position) =>
    mode === 'radial' ? { x: width / 2, y: height / 2 } : handlePoint(position, width, height);
  return {
    id: node.key,
    type: kind,
    position: { x: node.x, y: node.y },
    data: { label: labelFor(kind, node), width, height, mode, isRoot: node.isRoot === true, kind },
    initialWidth: width,
    initialHeight: height,
    handles: [
      { type: 'target', position: sides.target, ...point(sides.target), width: 1, height: 1 },
      { type: 'source', position: sides.source, ...point(sides.source), width: 1, height: 1 },
    ],
  };
}

export function movedNodes(dragged: readonly Pick<Node, 'id' | 'position'>[]): MovedNode[] {
  return dragged.map((n) => ({ key: n.id, x: n.position.x, y: n.position.y }));
}

const APPLIED_CHANGES = new Set<NodeChange['type']>(['position', 'dimensions']);

export function ReactFlowCanvas({
  nodes,
  edges,
  mode = 'top-down',
  children,
  onNodeSelect,
  onNodesMoved,
}: CanvasAdapterProps) {
  const cache = useRef(new Map<string, BoxNode>());
  const baseNodes = useMemo<BoxNode[]>(() => {
    const next = new Map<string, BoxNode>();
    const built = nodes.map((n) => {
      const fresh = toBoxNode(n, mode);
      const previous = cache.current.get(n.key);
      const reuse =
        previous !== undefined &&
        previous.position.x === fresh.position.x &&
        previous.position.y === fresh.position.y &&
        previous.type === fresh.type &&
        sameData(previous.data, fresh.data);
      const chosen = reuse ? previous : fresh;
      next.set(n.key, chosen);
      return chosen;
    });
    cache.current = next;
    return built;
  }, [nodes, mode]);

  const [shownBase, setShownBase] = useState(baseNodes);
  const [flowNodes, setFlowNodes] = useState(baseNodes);
  if (shownBase !== baseNodes) {
    setShownBase(baseNodes);
    setFlowNodes(baseNodes);
  }

  const onNodesChange = useCallback((changes: NodeChange<BoxNode>[]) => {
    const applicable = changes.filter((change) => APPLIED_CHANGES.has(change.type));
    if (applicable.length > 0) {
      setFlowNodes((current) => applyNodeChanges(applicable, current));
    }
  }, []);

  const flowEdges = useMemo<Edge[]>(
    () =>
      edges.map((e) => ({
        id: String(e.connectionId),
        source: e.sourceKey,
        target: e.targetKey,
        type: mode === 'radial' ? 'straight' : 'default',
      })),
    [edges, mode],
  );

  const highlight = useRef(createHighlightStore()).current;
  const groups = useMemo(() => highlightGroups(nodes), [nodes]);
  const select = useCallback(
    (key: string | null) => {
      highlight.set(key, key === null ? [] : (groups.get(key) ?? []));
    },
    [highlight, groups],
  );

  return (
    <HighlightContext.Provider value={highlight}>
      <ReactFlow
        nodes={flowNodes}
        edges={flowEdges}
        nodeTypes={NODE_TYPES}
        onlyRenderVisibleElements={false}
        onNodesChange={onNodesChange}
        onNodeClick={(_, node) => {
          select(node.id);
          onNodeSelect(node.id);
        }}
        onPaneClick={() => {
          select(null);
        }}
        onNodeDragStop={(_, _node, dragged) => {
          onNodesMoved(movedNodes(dragged));
        }}
      >
        {children}
      </ReactFlow>
    </HighlightContext.Provider>
  );
}
