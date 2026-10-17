import { useMemo } from "react";
import { Position, ReactFlow, type Edge, type Node } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { CanvasAdapterProps } from "./canvasAdapter";

const PLACEHOLDER_WIDTH = 150;
const PLACEHOLDER_HEIGHT = 36;

export function movedNodes(dragged: readonly Pick<Node, "id" | "position">[]): { key: string; x: number; y: number }[] {
  return dragged.map((n) => ({ key: n.id, x: n.position.x, y: n.position.y }));
}

export function ReactFlowCanvas({ nodes, edges, onNodeSelect, onNodesMoved }: CanvasAdapterProps) {
  const flowNodes = useMemo<Node[]>(
    () =>
      nodes.map((n) => ({
        id: n.key,
        position: { x: n.x, y: n.y },
        data: { label: n.key, isAlias: n.isAlias },
        initialWidth: PLACEHOLDER_WIDTH,
        initialHeight: PLACEHOLDER_HEIGHT,
        handles: [
          { type: "target", position: Position.Top, x: PLACEHOLDER_WIDTH / 2, y: 0, width: 1, height: 1 },
          { type: "source", position: Position.Bottom, x: PLACEHOLDER_WIDTH / 2, y: PLACEHOLDER_HEIGHT, width: 1, height: 1 },
        ],
      })),
    [nodes],
  );
  const flowEdges = useMemo<Edge[]>(
    () => edges.map((e) => ({ id: e.connectionId, source: e.sourceKey, target: e.targetKey })),
    [edges],
  );

  return (
    <ReactFlow
      nodes={flowNodes}
      edges={flowEdges}
      onlyRenderVisibleElements={false}
      onNodeClick={(_, node) => onNodeSelect(node.id)}
      onNodeDragStop={(_, _node, dragged) => onNodesMoved(movedNodes(dragged))}
    />
  );
}
