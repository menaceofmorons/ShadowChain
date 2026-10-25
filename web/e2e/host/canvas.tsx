import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ReactFlowProvider, useReactFlow, useStoreApi, ViewportPortal } from '@xyflow/react';
import {
  buildChainTree,
  collapseChainTree,
  createRegistryAdapter,
  DEFAULT_ENGINE_OPTIONS,
  engineEntryForMode,
  generateChain,
  LAYOUT_MODES,
  nodeSize,
  ReactFlowCanvas,
  SYNTHETIC_ROOT_SYSTEM_ID,
  type CanvasEdge,
  type CanvasNode,
  type ChainNode,
  type LayoutMode,
} from '../../src/map';

export interface CanvasHostState {
  done: boolean;
  error: string | null;
  mode: LayoutMode;
  engine: string;
  nodeCount: number;
  expectedNodeCount: number;
  edgeCount: number;
  collapsedCount: number;
  ringGuides: number;
}

declare global {
  interface Window {
    __canvas: CanvasHostState;
  }
}

const params = new URLSearchParams(window.location.search);
const modeParam = params.get('mode') ?? 'top-down';
const mode = LAYOUT_MODES.find((candidate) => candidate === modeParam) ?? 'top-down';
const size = Number(params.get('size') ?? 150);
const seed = Number(params.get('seed') ?? 7);
const collapse = Number(params.get('collapse') ?? 0);
const MIN_ZOOM = 0.02;

window.__canvas = {
  done: false,
  error: null,
  mode,
  engine: engineEntryForMode(mode).id,
  nodeCount: 0,
  expectedNodeCount: 0,
  edgeCount: 0,
  collapsedCount: 0,
  ringGuides: 0,
};

interface RingGuide {
  readonly radius: number;
}

interface Scene {
  readonly nodes: readonly CanvasNode[];
  readonly edges: readonly CanvasEdge[];
  readonly centre: { readonly x: number; readonly y: number };
  readonly guides: readonly RingGuide[];
}

function ringGuides(root: ChainNode, nodes: readonly CanvasNode[]): Pick<Scene, 'centre' | 'guides'> {
  const byKey = new Map(nodes.map((node) => [node.key, node]));
  const centreOf = (node: ChainNode) => {
    const placed = byKey.get(node.keyString) as CanvasNode;
    const size = nodeSize(node, DEFAULT_ENGINE_OPTIONS);
    return { x: placed.x + size.width / 2, y: placed.y + size.height / 2 };
  };
  const centre = centreOf(root);
  const sums: { total: number; count: number }[] = [];
  const visit = (node: ChainNode, depth: number): void => {
    const point = centreOf(node);
    const sum = (sums[depth] ??= { total: 0, count: 0 });
    sum.total += Math.hypot(point.x - centre.x, point.y - centre.y);
    sum.count += 1;
    node.children.forEach((child) => {
      visit(child, depth + 1);
    });
  };
  visit(root, 0);
  return { centre, guides: sums.slice(1).map((sum) => ({ radius: sum.total / sum.count })) };
}

function collectEdges(root: ChainNode): CanvasEdge[] {
  const edges: CanvasEdge[] = [];
  const visit = (node: ChainNode): void => {
    for (const child of node.children) {
      edges.push({
        connectionId: child.parentEdge === null ? child.keyString : String(child.parentEdge.connectionId),
        sourceKey: node.keyString,
        targetKey: child.keyString,
      });
      visit(child);
    }
  };
  visit(root);
  return edges;
}

function collapseTargets(root: ChainNode, count: number): string[] {
  const targets: string[] = [];
  const visit = (node: ChainNode): void => {
    if (targets.length >= count) {
      return;
    }
    if (node !== root && node.kind === 'primary' && node.children.length > 0) {
      targets.push(node.keyString);
      return;
    }
    node.children.forEach(visit);
  };
  visit(root);
  return targets;
}

async function buildScene(): Promise<Scene> {
  const fullTree = buildChainTree(generateChain({ nodeCount: size, seed }), SYNTHETIC_ROOT_SYSTEM_ID);
  const collapsedKeys = collapseTargets(fullTree.root, collapse);
  const tree = collapseChainTree(fullTree, new Set(collapsedKeys));
  const adapter = createRegistryAdapter();
  try {
    window.__canvas.expectedNodeCount = tree.nodes.length;
    window.__canvas.collapsedCount = collapsedKeys.length;
    const placed = await adapter.layout({ type: 'full', tree, mode, manualPositions: [], collapsedKeys });
    const nodes = placed.map((p) => ({
      key: p.nodeKey,
      x: p.x,
      y: p.y,
      isAlias: p.alias,
      hiddenCount: p.hiddenCount,
      isRoot: p.nodeKey === tree.root.keyString,
    }));
    const rings = mode === 'radial' ? ringGuides(tree.root, nodes) : { centre: { x: 0, y: 0 }, guides: [] };
    return { nodes, edges: collectEdges(tree.root), ...rings };
  } finally {
    adapter.dispose();
  }
}

function FitOnChange({ scene }: { scene: Scene | null }) {
  const { fitView } = useReactFlow();
  const store = useStoreApi();
  useEffect(() => {
    if (scene === null) {
      return;
    }
    const frame = requestAnimationFrame(() => {
      store.getState().setMinZoom(MIN_ZOOM);
      void fitView({ padding: 0.05 }).then(() => {
        window.__canvas.nodeCount = document.querySelectorAll('.react-flow__node').length;
        window.__canvas.edgeCount = document.querySelectorAll('.react-flow__edge').length;
        window.__canvas.ringGuides = document.querySelectorAll('[data-ring-guide]').length;
        window.__canvas.done = true;
      });
    });
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [scene, fitView, store]);
  return null;
}

function Host() {
  const [scene, setScene] = useState<Scene | null>(null);
  useEffect(() => {
    buildScene()
      .then(setScene)
      .catch((error: unknown) => {
        window.__canvas.error = error instanceof Error ? error.message : String(error);
        window.__canvas.done = true;
      });
  }, []);
  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', fontFamily: 'sans-serif' }}>
      <div style={{ padding: 8, display: 'flex', gap: 16 }}>
        {LAYOUT_MODES.map((candidate) => (
          <a
            key={candidate}
            href={`?mode=${candidate}&size=${String(size)}&seed=${String(seed)}&collapse=${String(collapse)}`}
          >
            {candidate === mode ? `[${candidate}]` : candidate}
          </a>
        ))}
        <span>
          engine: {engineEntryForMode(mode).id}, nodes: {size}, seed: {seed}
        </span>
      </div>
      <div style={{ flex: 1 }}>
        <ReactFlowProvider>
          <ReactFlowCanvas
            nodes={scene?.nodes ?? []}
            edges={scene?.edges ?? []}
            mode={mode}
            onNodeSelect={() => undefined}
            onNodesMoved={() => undefined}
          >
            <ViewportPortal>
              {scene?.guides.map((guide, index) => (
                <div
                  key={index}
                  data-ring-guide={index + 1}
                  style={{
                    position: 'absolute',
                    left: scene.centre.x - guide.radius,
                    top: scene.centre.y - guide.radius,
                    width: 2 * guide.radius,
                    height: 2 * guide.radius,
                    boxSizing: 'border-box',
                    border: '2px dashed #9aa5b1',
                    borderRadius: '50%',
                    pointerEvents: 'none',
                  }}
                />
              ))}
            </ViewportPortal>
          </ReactFlowCanvas>
          <FitOnChange scene={scene} />
        </ReactFlowProvider>
      </div>
    </div>
  );
}

const container = document.getElementById('root');
if (container !== null) {
  createRoot(container).render(<Host />);
}
