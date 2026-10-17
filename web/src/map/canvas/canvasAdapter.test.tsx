import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReactFlowCanvas, movedNodes, type CanvasEdge, type CanvasNode } from "./index";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

async function render(nodes: CanvasNode[], edges: CanvasEdge[], onNodeSelect = vi.fn()): Promise<void> {
  container = document.createElement("div");
  container.style.width = "800px";
  container.style.height = "600px";
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <ReactFlowCanvas nodes={nodes} edges={edges} onNodeSelect={onNodeSelect} onNodesMoved={vi.fn()} />,
    );
  });
}

function makeGraph(n: number): { nodes: CanvasNode[]; edges: CanvasEdge[] } {
  const nodes = Array.from({ length: n }, (_, i) => ({ key: `s:${i}`, x: i * 50, y: 0, isAlias: i % 2 === 1 }));
  const edges = nodes.slice(1).map((node, i) => ({
    connectionId: `c${i}`,
    sourceKey: `s:${i}`,
    targetKey: node.key,
  }));
  return { nodes, edges };
}

const mapSources = import.meta.glob("../**/*.{ts,tsx}", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

describe("ReactFlowCanvas",  () => {
  it("renders N nodes and M edges", async () => {
    const { nodes, edges } = makeGraph(5);
    await render(nodes, edges);
    expect(container?.querySelectorAll(".react-flow__node")).toHaveLength(5);
    expect(container?.querySelectorAll(".react-flow__edge")).toHaveLength(4);
  });

  it("renders nodes beyond the viewport", async () => {
    const { nodes, edges } = makeGraph(40);
    nodes[39] = { key: "s:far", x: 100000, y: 100000, isAlias: false };
    await render(nodes, edges);
    expect(container?.querySelectorAll(".react-flow__node")).toHaveLength(40);
  });

  it("reports node selection", async () => {
    const onSelect = vi.fn();
    const { nodes, edges } = makeGraph(3);
    await render(nodes, edges, onSelect);
    const node = container?.querySelector('.react-flow__node[data-id="s:1"]');
    expect(node).not.toBeNull();
    act(() => {
      node?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onSelect).toHaveBeenCalledWith("s:1");
  });

  it("reports every dragged node in one batch", () => {
    const onNodesMoved = vi.fn();
    const dragged = [
      { id: "s:1", position: { x: 1, y: 2 } },
      { id: "s:2", position: { x: 3, y: 4 } },
      { id: "s:3", position: { x: 5, y: 6 } },
    ];
    onNodesMoved(movedNodes(dragged));
    expect(onNodesMoved).toHaveBeenCalledTimes(1);
    expect(onNodesMoved).toHaveBeenCalledWith([
      { key: "s:1", x: 1, y: 2 },
      { key: "s:2", x: 3, y: 4 },
      { key: "s:3", x: 5, y: 6 },
    ]);
  });

  it("is the only importer of @xyflow/react under web/src/map", () => {
    const paths = Object.keys(mapSources);
    expect(paths.length).toBeGreaterThan(5);
    const offenders = paths.filter(
      (path) => !path.startsWith("./") && !path.startsWith("../canvas/") && mapSources[path]?.includes("@xyflow/react"),
    );
    expect(offenders).toEqual([]);
  });
});
