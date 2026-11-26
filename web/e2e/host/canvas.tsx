import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ReactFlowProvider, useReactFlow, useStoreApi, ViewportPortal } from '@xyflow/react';
import {
  applyGesture,
  buildChainTree,
  createMapSession,
  createPositionStore,
  DEFAULT_ENGINE_OPTIONS,
  engineEntryForMode,
  generateChain,
  LAYOUT_MODES,
  nodeSize,
  ReactFlowCanvas,
  renderCounts,
  resetRenderCounts,
  SYNTHETIC_ROOT_SYSTEM_ID,
  wanderer553,
  wanderer98,
  type CanvasEdge,
  type CanvasGesture,
  type CanvasNode,
  type ChainGraph,
  type ChainNode,
  type LayoutMode,
  type MapSession,
  type PositionsBatch,
  type PositionStore,
} from '../../src/map';

export interface HostPlacement {
  key: string;
  x: number;
  y: number;
  source: 'auto' | 'manual';
}

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
  selectedKey: string | null;
  moved: { key: string; x: number; y: number }[];
  gestures: string[];
  batches: PositionsBatch[];
  placed: HostPlacement[];
  rootOffset: number;
  sceneVersion: number;
}

export interface CanvasRenderProbe {
  counts: () => Record<string, number>;
  reset: () => void;
}

declare global {
  interface Window {
    __canvas: CanvasHostState;
    __canvasRenders: CanvasRenderProbe;
  }
}

const params = new URLSearchParams(window.location.search);
const modeParam = params.get('mode') ?? 'top-down';
const initialMode = LAYOUT_MODES.find((candidate) => candidate === modeParam) ?? 'top-down';
const size = Number(params.get('size') ?? 150);
const seed = Number(params.get('seed') ?? 7);
const collapse = Number(params.get('collapse') ?? 0);
const fixture = params.get('fixture');
const MIN_ZOOM = 0.02;
const FIXTURE_ROOT_SYSTEM_ID = 1;
const FIXTURE_NEW_SYSTEM_ID = 5;

window.__canvas = {
  done: false,
  error: null,
  mode: initialMode,
  engine: engineEntryForMode(initialMode).id,
  nodeCount: 0,
  expectedNodeCount: 0,
  edgeCount: 0,
  collapsedCount: 0,
  ringGuides: 0,
  selectedKey: null,
  moved: [],
  gestures: [],
  batches: [],
  placed: [],
  rootOffset: 0,
  sceneVersion: 0,
};

window.__canvasRenders = { counts: renderCounts, reset: resetRenderCounts };

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
        connectionId: child.parentEdge?.connectionId ?? -edges.length - 1,
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

interface Rig {
  readonly session: MapSession;
  readonly store: PositionStore;
  readonly staleRevision: number;
  readonly rootSystemId: number;
}

function fixtureGraph(): ChainGraph {
  return {
    systems: wanderer553.graph.systems.filter((system) => system.id !== FIXTURE_NEW_SYSTEM_ID),
    connections: wanderer553.graph.connections.filter((connection) => connection.endB !== FIXTURE_NEW_SYSTEM_ID),
  };
}

async function createRig(): Promise<Rig> {
  const useFixture = fixture === 'wanderer553' || fixture === 'wanderer98';
  const graph = useFixture ? fixtureGraph() : generateChain({ nodeCount: size, seed });
  const rootSystemId = useFixture ? FIXTURE_ROOT_SYSTEM_ID : SYNTHETIC_ROOT_SYSTEM_ID;
  const store = createPositionStore({
    tabId: 'e2e',
    onBatch: (batch) => {
      window.__canvas.batches = [...window.__canvas.batches, batch];
    },
  });
  const collapsedKeys = collapseTargets(buildChainTree(graph, rootSystemId).root, collapse);
  collapsedKeys.forEach((key) => {
    store.setCollapsed(key, true);
  });
  window.__canvas.collapsedCount = collapsedKeys.length;
  const session = createMapSession({ graph, rootSystemId, mode: initialMode, store });
  await session.open();
  return { session, store, staleRevision: store.snapshot().revision, rootSystemId };
}

function sceneOf(session: MapSession): Scene {
  const tree = session.tree();
  const collapsible = new Set(
    tree.nodes
      .filter((node) => node.kind === 'primary' && node !== tree.root && node.children.length > 0)
      .map((node) => node.keyString),
  );
  const nodes = session.placedNodes().map((p) => ({
    key: p.nodeKey,
    x: p.x,
    y: p.y,
    isAlias: p.alias,
    hiddenCount: p.hiddenCount,
    isRoot: p.nodeKey === tree.root.keyString,
    canCollapse: collapsible.has(p.nodeKey),
  }));
  const rings = session.mode() === 'radial' ? ringGuides(tree.root, nodes) : { centre: { x: 0, y: 0 }, guides: [] };
  window.__canvas.expectedNodeCount = tree.nodes.length;
  window.__canvas.placed = session.placedNodes().map((p) => ({ key: p.nodeKey, x: p.x, y: p.y, source: p.source }));
  window.__canvas.rootOffset = session.store.rootOffset();
  window.__canvas.sceneVersion += 1;
  return { nodes, edges: collectEdges(tree.root), ...rings };
}

function FitOnChange({ fitToken }: { fitToken: number }) {
  const { fitView } = useReactFlow();
  const store = useStoreApi();
  useEffect(() => {
    if (fitToken === 0) {
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
  }, [fitToken, fitView, store]);
  return null;
}

function Host() {
  const [rig, setRig] = useState<Rig | null>(null);
  const [scene, setScene] = useState<Scene | null>(null);
  const [mode, setMode] = useState<LayoutMode>(initialMode);
  const [fitToken, setFitToken] = useState(0);

  useEffect(() => {
    let active: Rig | null = null;
    let unsubscribe = (): void => undefined;
    createRig()
      .then((created) => {
        active = created;
        unsubscribe = created.session.subscribe(() => {
          setScene(sceneOf(created.session));
        });
        setRig(created);
        setScene(sceneOf(created.session));
        setFitToken((token) => token + 1);
      })
      .catch((error: unknown) => {
        window.__canvas.error = error instanceof Error ? error.message : String(error);
        window.__canvas.done = true;
      });
    return () => {
      unsubscribe();
      active?.session.dispose();
    };
  }, []);

  const run = (task: Promise<unknown> | undefined): void => {
    task?.catch((error: unknown) => {
      window.__canvas.error = error instanceof Error ? error.message : String(error);
    });
  };

  const changeMode = (next: LayoutMode): void => {
    run(
      rig?.session.setMode(next).then(() => {
        window.__canvas.mode = next;
        window.__canvas.engine = engineEntryForMode(next).id;
        setMode(next);
        setFitToken((token) => token + 1);
      }),
    );
  };

  const addConnection = (): void => {
    if (rig === null) {
      return;
    }
    const { rootSystemId, session } = rig;
    const current = session.graph();
    const systemId = Math.max(...current.systems.map((system) => system.id)) + 1;
    const connectionId = Math.max(...current.connections.map((connection) => connection.id)) + 1;
    run(
      session.addConnection({ id: connectionId, createdAt: connectionId, endA: rootSystemId, endB: systemId }, [
        { id: systemId },
      ]),
    );
  };

  const staleUpdate = (): void => {
    if (rig === null) {
      return;
    }
    rig.store.mergeUpdate({
      basedOnRevision: rig.staleRevision,
      positions: wanderer98.staleUpdate.positions.map((p) => ({ ...p, source: 'manual', collapsed: false })),
    });
  };

  const onGesture = (gesture: CanvasGesture): void => {
    window.__canvas.gestures = [...window.__canvas.gestures, gesture.type];
    if (rig !== null) {
      run(applyGesture(rig.session, gesture));
    }
  };

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', fontFamily: 'sans-serif' }}>
      <div style={{ padding: 8, display: 'flex', gap: 16 }}>
        {LAYOUT_MODES.map((candidate) => (
          <button
            key={candidate}
            data-testid={`mode-${candidate}`}
            onClick={() => {
              changeMode(candidate);
            }}
          >
            {candidate === mode ? `[${candidate}]` : candidate}
          </button>
        ))}
        <button
          data-testid="tidy"
          onClick={() => {
            run(rig?.session.tidy());
          }}
        >
          Tidy
        </button>
        <button data-testid="add-connection" onClick={addConnection}>
          Add connection
        </button>
        <button data-testid="stale-update" onClick={staleUpdate}>
          Stale update
        </button>
        <button
          data-testid="flush"
          onClick={() => {
            rig?.store.flush();
          }}
        >
          Flush
        </button>
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
            onNodeSelect={(key) => {
              window.__canvas.selectedKey = key;
            }}
            onNodesMoved={(moved) => {
              window.__canvas.moved = [...moved];
            }}
            onGesture={onGesture}
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
          <FitOnChange fitToken={fitToken} />
        </ReactFlowProvider>
      </div>
    </div>
  );
}

const container = document.getElementById('root');
if (container !== null) {
  createRoot(container).render(<Host />);
}
