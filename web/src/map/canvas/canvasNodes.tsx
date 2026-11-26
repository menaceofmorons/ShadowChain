import { memo, type CSSProperties } from 'react';
import { Handle, Position, type Node, type NodeProps, type NodeTypes } from '@xyflow/react';
import type { LayoutMode } from '../layout/types';
import type { CanvasNodeKind } from './nodeKinds';
import { useNodeMark, type NodeMark } from './highlightStore';
import { recordRender } from './renderCounts';

export interface BoxData extends Record<string, unknown> {
  label: string;
  width: number;
  height: number;
  mode: LayoutMode;
  isRoot: boolean;
  kind: CanvasNodeKind;
}

export type BoxNode = Node<BoxData, CanvasNodeKind>;

export interface HandleSides {
  readonly target: Position;
  readonly source: Position;
}

export const SIDES: Record<LayoutMode, HandleSides> = {
  'top-down': { target: Position.Top, source: Position.Bottom },
  'left-to-right': { target: Position.Left, source: Position.Right },
  radial: { target: Position.Top, source: Position.Top },
};

const CENTRED = { top: '50%', left: '50%', opacity: 0, pointerEvents: 'none' } as const;

const KIND_STYLE: Record<CanvasNodeKind, CSSProperties> = {
  system: { borderRadius: 3, border: '1px solid #1a192b', background: '#fff' },
  alias: { borderRadius: '50%', border: '1px solid #5b6b7a', background: '#eef2f6' },
  unknown: { borderRadius: 3, border: '1px dashed #5b6b7a', background: '#fafafa' },
  collapsed: { borderRadius: 3, border: '1px solid #8a6d3b', background: '#fff6e0' },
};

const ROOT_STYLE: CSSProperties = { border: '3px solid #c0392b', borderRadius: 24, background: '#ffe9e6' };

const MARK_STYLE: Record<NodeMark, CSSProperties> = {
  none: {},
  group: { boxShadow: '0 0 0 3px #f1c40f' },
  selected: { boxShadow: '0 0 0 3px #2980b9' },
};

function NodeShell({ id, data, selected }: NodeProps<BoxNode>) {
  recordRender(id);
  const highlightMark = useNodeMark(id);
  const mark: NodeMark = selected ? 'selected' : highlightMark === 'selected' ? 'none' : highlightMark;
  const sides = SIDES[data.mode];
  const handleStyle = data.mode === 'radial' ? CENTRED : undefined;
  return (
    <div
      data-kind={data.kind}
      data-highlighted={highlightMark === 'none' ? undefined : 'true'}
      data-selected={selected ? 'true' : undefined}
      style={{
        ...KIND_STYLE[data.kind],
        ...(data.isRoot ? ROOT_STYLE : {}),
        ...MARK_STYLE[mark],
        width: data.width,
        height: data.height,
        boxSizing: 'border-box',
        font: data.isRoot ? 'bold 12px sans-serif' : '12px sans-serif',
        color: '#222',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        whiteSpace: 'nowrap',
      }}
    >
      <Handle type="target" position={sides.target} style={handleStyle} />
      {data.label}
      <Handle type="source" position={sides.source} style={handleStyle} />
    </div>
  );
}

export const SystemNode = memo(function SystemNode(props: NodeProps<BoxNode>) {
  return <NodeShell {...props} />;
});

export const AliasNode = memo(function AliasNode(props: NodeProps<BoxNode>) {
  return <NodeShell {...props} />;
});

export const UnknownNode = memo(function UnknownNode(props: NodeProps<BoxNode>) {
  return <NodeShell {...props} />;
});

export const CollapsedNode = memo(function CollapsedNode(props: NodeProps<BoxNode>) {
  return <NodeShell {...props} />;
});

export const NODE_TYPES: NodeTypes = {
  system: SystemNode,
  alias: AliasNode,
  unknown: UnknownNode,
  collapsed: CollapsedNode,
};
