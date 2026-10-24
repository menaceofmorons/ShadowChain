import { useMemo } from 'react';
import { Handle, Position, ReactFlow, type Edge, type Node, type NodeProps, type NodeTypes } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { ChainNode } from '../model/types';
import { DEFAULT_ENGINE_OPTIONS, nodeSize } from '../layout/engineOptions';
import type { LayoutMode } from '../layout/types';
import type { CanvasAdapterProps } from './canvasAdapter';

interface BoxData extends Record<string, unknown> {
  label: string;
  width: number;
  height: number;
  mode: LayoutMode;
}

type BoxNode = Node<BoxData, 'box'>;

interface HandleSides {
  readonly target: Position;
  readonly source: Position;
}

const SIDES: Record<LayoutMode, HandleSides> = {
  'top-down': { target: Position.Top, source: Position.Bottom },
  'left-to-right': { target: Position.Left, source: Position.Right },
  radial: { target: Position.Top, source: Position.Top },
};

const CENTRED = { top: '50%', left: '50%', opacity: 0 } as const;

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

function Box({ data }: NodeProps<BoxNode>) {
  const sides = SIDES[data.mode];
  const handleStyle = data.mode === 'radial' ? CENTRED : undefined;
  return (
    <div
      style={{
        width: data.width,
        height: data.height,
        boxSizing: 'border-box',
        border: '1px solid #1a192b',
        borderRadius: 3,
        background: '#fff',
        font: '12px sans-serif',
        color: '#222',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        overflow: 'hidden',
        whiteSpace: 'nowrap',
      }}
    >
      <Handle type="target" position={sides.target} style={handleStyle} />
      {data.label}
      <Handle type="source" position={sides.source} style={handleStyle} />
    </div>
  );
}

const NODE_TYPES: NodeTypes = { box: Box };

export function movedNodes(dragged: readonly Pick<Node, 'id' | 'position'>[]): { key: string; x: number; y: number }[] {
  return dragged.map((n) => ({ key: n.id, x: n.position.x, y: n.position.y }));
}

export function ReactFlowCanvas({ nodes, edges, mode = 'top-down', onNodeSelect, onNodesMoved }: CanvasAdapterProps) {
  const flowNodes = useMemo<BoxNode[]>(
    () =>
      nodes.map((n) => {
        const collapsed = n.hiddenCount !== undefined && n.hiddenCount !== null;
        const { width, height } = nodeSize(
          { kind: collapsed ? 'collapsed' : n.isAlias ? 'alias' : 'primary' } as ChainNode,
          DEFAULT_ENGINE_OPTIONS,
        );
        const sides = SIDES[mode];
        const centred = mode === 'radial';
        const point = (position: Position) =>
          centred ? { x: width / 2, y: height / 2 } : handlePoint(position, width, height);
        return {
          id: n.key,
          type: 'box',
          position: { x: n.x, y: n.y },
          data: { label: collapsed ? `+${String(n.hiddenCount)}` : n.key, width, height, mode },
          initialWidth: width,
          initialHeight: height,
          handles: [
            { type: 'target', position: sides.target, ...point(sides.target), width: 1, height: 1 },
            { type: 'source', position: sides.source, ...point(sides.source), width: 1, height: 1 },
          ],
        };
      }),
    [nodes, mode],
  );
  const flowEdges = useMemo<Edge[]>(
    () =>
      edges.map((e) => ({
        id: e.connectionId,
        source: e.sourceKey,
        target: e.targetKey,
        type: mode === 'radial' ? 'straight' : 'default',
      })),
    [edges, mode],
  );

  return (
    <ReactFlow
      nodes={flowNodes}
      edges={flowEdges}
      nodeTypes={NODE_TYPES}
      onlyRenderVisibleElements={false}
      onNodeClick={(_, node) => onNodeSelect(node.id)}
      onNodeDragStop={(_, _node, dragged) => onNodesMoved(movedNodes(dragged))}
    />
  );
}
