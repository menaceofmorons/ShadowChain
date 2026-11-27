import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { applyNodeChanges, Position, ReactFlow, SelectionMode, type Node, type NodeChange } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { buildFlowEdges, EDGE_TYPES, type ConnectorEdgeType, type EdgeCache } from './edges';
import { DEFAULT_ENGINE_OPTIONS, nodeSizeForKind } from '../layout/engineOptions';
import type { LayoutMode } from '../layout/types';
import type { CanvasAdapterProps, CanvasNode, MovedNode } from './canvasAdapter';
import type { CanvasGesture } from './interaction/gestures';
import { NODE_TYPES, SIDES, type BoxData, type BoxNode } from './canvasNodes';
import { createHighlightStore, HighlightContext } from './highlightStore';
import {
  ContextMenu,
  constrainToRootAxis,
  decodeModifiers,
  menuItemsFor,
  MULTI_SELECTION_KEY_CODES,
  planDrag,
  SELECTION_KEY_CODE,
} from './interaction';
import type { Point } from './interaction/rootAxis';
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
  if (node.label !== undefined && (kind === 'system' || kind === 'alias')) {
    return node.label;
  }
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
    draggable: !(kind === 'collapsed' || (mode === 'radial' && node.isRoot === true)),
    handles: [
      { type: 'target', position: sides.target, ...point(sides.target), width: 1, height: 1 },
      { type: 'source', position: sides.source, ...point(sides.source), width: 1, height: 1 },
    ],
  };
}

export function movedNodes(dragged: readonly Pick<Node, 'id' | 'position'>[]): MovedNode[] {
  return dragged.map((n) => ({ key: n.id, x: n.position.x, y: n.position.y }));
}

const APPLIED_CHANGES = new Set<NodeChange['type']>(['position', 'dimensions', 'select']);

const withSelection = (base: readonly BoxNode[], current: readonly BoxNode[]): BoxNode[] => {
  const selected = new Set(current.filter((node) => node.selected === true).map((node) => node.id));
  return base.map((node) => (selected.has(node.id) ? { ...node, selected: true } : node));
};

function constrainRootChanges(
  changes: NodeChange<BoxNode>[],
  mode: LayoutMode,
  rootKey: string | null,
  current: readonly BoxNode[],
): NodeChange<BoxNode>[] {
  if (rootKey === null) {
    return changes;
  }
  return changes.map((change) => {
    if (change.type !== 'position' || change.id !== rootKey || change.position === undefined) {
      return change;
    }
    const start = current.find((node) => node.id === rootKey)?.position;
    return start === undefined ? change : { ...change, position: constrainToRootAxis(mode, start, change.position) };
  });
}

interface BuiltEdges {
  readonly edges: ConnectorEdgeType[];
  readonly cache: EdgeCache;
}

interface DragStart {
  readonly alone: boolean;
  readonly starts: ReadonlyMap<string, Point>;
}

interface MenuState {
  readonly key: string;
  readonly x: number;
  readonly y: number;
}

export function ReactFlowCanvas({
  nodes,
  edges,
  mode = 'top-down',
  children,
  onNodeSelect,
  onNodesMoved,
  onGesture,
}: CanvasAdapterProps) {
  const [shownBase, setShownBase] = useState<BoxNode[] | null>(null);
  const [flowNodes, setFlowNodes] = useState<BoxNode[]>([]);
  const baseNodes = useMemo<BoxNode[]>(() => {
    const previousByKey = new Map((shownBase ?? []).map((node) => [node.id, node]));
    return nodes.map((n) => {
      const fresh = toBoxNode(n, mode);
      const previous = previousByKey.get(n.key);
      const reuse =
        previous !== undefined &&
        previous.position.x === fresh.position.x &&
        previous.position.y === fresh.position.y &&
        previous.type === fresh.type &&
        sameData(previous.data, fresh.data);
      return reuse ? previous : fresh;
    });
  }, [nodes, mode]);

  if (shownBase !== baseNodes) {
    setShownBase(baseNodes);
    setFlowNodes((current) => withSelection(baseNodes, current));
  }

  const rootKey = useMemo(() => nodes.find((node) => node.isRoot === true)?.key ?? null, [nodes]);

  const onNodesChange = useCallback(
    (changes: NodeChange<BoxNode>[]) => {
      const applicable = changes.filter((change) => APPLIED_CHANGES.has(change.type));
      if (applicable.length > 0) {
        setFlowNodes((current) => applyNodeChanges(constrainRootChanges(applicable, mode, rootKey, current), current));
      }
    },
    [mode, rootKey],
  );

  const dragStart = useRef<DragStart | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const byKey = useMemo(() => new Map(nodes.map((node) => [node.key, node])), [nodes]);

  const menuItems = useMemo(() => {
    const target = menu === null ? undefined : byKey.get(menu.key);
    if (target === undefined) {
      return [];
    }
    return menuItemsFor({
      key: target.key,
      kind: canvasNodeKind(target),
      isRoot: target.isRoot === true,
      canCollapse: target.canCollapse === true,
    });
  }, [menu, byKey]);

  const latestBase = useRef(baseNodes);
  useEffect(() => {
    latestBase.current = baseNodes;
  }, [baseNodes]);

  const dispatchGesture = (gesture: CanvasGesture): void => {
    const resync = (): void => {
      setFlowNodes((current) => withSelection(latestBase.current, current));
    };
    void (async () => {
      try {
        await onGesture?.(gesture);
      } catch {
        resync();
      }
    })();
  };

  const finishDrag = (dragged: readonly BoxNode[]): void => {
    const begun = dragStart.current;
    dragStart.current = null;
    if (begun === null) {
      return;
    }
    const plan = planDrag({
      mode,
      alone: begun.alone,
      nodes: dragged.flatMap((node) => {
        const start = begun.starts.get(node.id);
        return start === undefined
          ? []
          : [{ key: node.id, kind: node.data.kind, isRoot: node.data.isRoot, start, end: node.position }];
      }),
    });
    if (plan === null) {
      setFlowNodes((current) => withSelection(baseNodes, current));
    } else {
      dispatchGesture(plan);
    }
  };

  const [shownEdges, setShownEdges] = useState<BuiltEdges | null>(null);
  const built = useMemo<BuiltEdges>(
    () =>
      buildFlowEdges(
        nodes,
        edges,
        mode,
        (node) => nodeSizeForKind(ENGINE_KIND[canvasNodeKind(node)], DEFAULT_ENGINE_OPTIONS),
        shownEdges?.cache ?? new Map(),
      ),
    [edges, nodes, mode],
  );
  if (shownEdges !== built) {
    setShownEdges(built);
  }
  const flowEdges: ConnectorEdgeType[] = built.edges;

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
        edgeTypes={EDGE_TYPES}
        onlyRenderVisibleElements={false}
        onNodesChange={onNodesChange}
        selectionKeyCode={SELECTION_KEY_CODE}
        multiSelectionKeyCode={[...MULTI_SELECTION_KEY_CODES]}
        selectionMode={SelectionMode.Partial}
        onNodeClick={(_, node) => {
          setMenu(null);
          select(node.id);
          onNodeSelect(node.id);
          if (node.data.kind === 'collapsed') {
            dispatchGesture({ type: 'set-collapsed', key: node.id, collapsed: false });
          }
        }}
        onPaneClick={() => {
          setMenu(null);
          select(null);
        }}
        onNodeContextMenu={(event, node) => {
          event.preventDefault();
          setMenu({ key: node.id, x: event.clientX, y: event.clientY });
        }}
        onNodeDragStart={(event, _node, dragged) => {
          setMenu(null);
          dragStart.current = {
            alone: decodeModifiers(event).aloneDrag,
            starts: new Map(dragged.map((node) => [node.id, { x: node.position.x, y: node.position.y }])),
          };
        }}
        onNodeDragStop={(_, _node, dragged) => {
          onNodesMoved(movedNodes(dragged));
          finishDrag(dragged as BoxNode[]);
        }}
      >
        {children}
        {menu !== null && menuItems.length > 0 && (
          <ContextMenu
            x={menu.x}
            y={menu.y}
            items={menuItems}
            onChoose={dispatchGesture}
            onClose={() => {
              setMenu(null);
            }}
          />
        )}
      </ReactFlow>
    </HighlightContext.Provider>
  );
}
