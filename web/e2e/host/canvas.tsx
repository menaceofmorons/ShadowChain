import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ReactFlowProvider, useReactFlow, useStoreApi } from '@xyflow/react';
import {
  buildChainTree,
  collapseChainTree,
  createRegistryAdapter,
  engineEntryForMode,
  generateChain,
  LAYOUT_MODES,
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
};

interface Scene {
  readonly nodes: readonly CanvasNode[];
  readonly edges: readonly CanvasEdge[];
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
    return {
      nodes: placed.map((p) => ({ key: p.nodeKey, x: p.x, y: p.y, isAlias: p.alias, hiddenCount: p.hiddenCount })),
      edges: collectEdges(tree.root),
    };
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
          />
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
