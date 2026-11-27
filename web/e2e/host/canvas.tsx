import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ReactFlowProvider, useReactFlow, useStoreApi, ViewportPortal } from '@xyflow/react';
import {
  applyGesture,
  buildChainTree,
  collectCanvasEdges,
  createMapSession,
  createPositionStore,
  DEFAULT_ENGINE_OPTIONS,
  edgeRenderCounts,
  engineEntryForMode,
  generateChain,
  generateChurnScript,
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
  type ChurnOperation,
  type ChainConnection,
  type ChainGraph,
  type ChainNode,
  type ChainSystem,
  type ConnectionSize,
  type LifeStage,
  type MassStatus,
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
  edgeCounts: () => Record<string, number>;
  reset: () => void;
}

export interface CanvasOps {
  moveNode: (key: string, dx: number, dy: number) => Promise<void>;
  moveGroup: (keys: readonly string[], dx: number, dy: number) => Promise<void>;
  setCollapsed: (key: string, collapsed: boolean) => Promise<void>;
  fieldUpdate: (key: string, label: string) => void;
  addLeaf: () => Promise<void>;
  removeLast: () => Promise<void>;
  churnStep: () => Promise<boolean>;
}

declare global {
  interface Window {
    __canvas: CanvasHostState;
    __canvasRenders: CanvasRenderProbe;
    __canvasOps: CanvasOps;
  }
}

const params = new URLSearchParams(window.location.search);
const modeParam = params.get('mode') ?? 'top-down';
const initialMode = LAYOUT_MODES.find((candidate) => candidate === modeParam) ?? 'top-down';
const size = Number(params.get('size') ?? 150);
const seed = Number(params.get('seed') ?? 7);
const collapse = Number(params.get('collapse') ?? 0);
const fixture = params.get('fixture');
const churnCount = Number(params.get('churn') ?? 0);
const churnSeed = Number(params.get('churnSeed') ?? 3);
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

window.__canvasRenders = { counts: renderCounts, edgeCounts: edgeRenderCounts, reset: resetRenderCounts };

const labelOverrides = new Map<string, string>();

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

const LEGEND_MASSES: readonly MassStatus[] = ['fresh', 'reduced', 'critical'];
const LEGEND_STAGES: readonly LifeStage[] = [1, 2, 3, 4];
const LEGEND_SIZES: readonly ConnectionSize[] = ['small', 'medium', 'large', 'freighter', 'capital', 'unknown'];

function legendGraph(): ChainGraph {
  const combos = LEGEND_MASSES.flatMap((massStatus) => LEGEND_STAGES.map((lifeStage) => ({ massStatus, lifeStage })));
  const connections: ChainConnection[] = combos.map((combo, index) => ({
    id: index + 1,
    createdAt: index + 1,
    endA: FIXTURE_ROOT_SYSTEM_ID,
    endB: index + 2,
    ...combo,
    size: LEGEND_SIZES[index % LEGEND_SIZES.length] as ConnectionSize,
  }));
  const parallel: ChainConnection = {
    id: combos.length + 1,
    createdAt: combos.length + 1,
    endA: FIXTURE_ROOT_SYSTEM_ID,
    endB: 2,
    massStatus: 'critical',
    lifeStage: 4,
    size: 'capital',
  };
  return {
    systems: [{ id: FIXTURE_ROOT_SYSTEM_ID }, ...combos.map((_, index) => ({ id: index + 2 }))],
    connections: [...connections, parallel],
  };
}

async function createRig(): Promise<Rig> {
  const useFixture = fixture === 'wanderer553' || fixture === 'wanderer98' || fixture === 'legend';
  const graph =
    fixture === 'legend' ? legendGraph() : useFixture ? fixtureGraph() : generateChain({ nodeCount: size, seed });
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
    label: labelOverrides.get(p.nodeKey),
  }));
  const rings = session.mode() === 'radial' ? ringGuides(tree.root, nodes) : { centre: { x: 0, y: 0 }, guides: [] };
  window.__canvas.expectedNodeCount = tree.nodes.length;
  window.__canvas.placed = session.placedNodes().map((p) => ({ key: p.nodeKey, x: p.x, y: p.y, source: p.source }));
  window.__canvas.rootOffset = session.store.rootOffset();
  window.__canvas.sceneVersion += 1;
  return { nodes, edges: collectCanvasEdges(tree.root, session.graph().connections), ...rings };
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

  const opsRig = useRef<Rig | null>(null);
  opsRig.current = rig;
  const churn = useRef<{ script: readonly ChurnOperation[]; next: number; lastAdded: number | null } | null>(null);

  useEffect(() => {
    const need = (): Rig => {
      if (opsRig.current === null) {
        throw new Error('rig not ready');
      }
      return opsRig.current;
    };
    const placedOf = (key: string): { x: number; y: number } => {
      const found = need()
        .session.placedNodes()
        .find((p) => p.nodeKey === key);
      if (found === undefined) {
        throw new Error(`no node ${key}`);
      }
      return found;
    };
    const addConnectionOp = async (connection: ChainConnection, systems: ChainSystem[]): Promise<void> => {
      await need().session.addConnection(connection, systems);
    };
    window.__canvasOps = {
      moveNode: async (key, dx, dy) => {
        const at = placedOf(key);
        await need().session.dragNode(key, { x: at.x + dx, y: at.y + dy });
      },
      moveGroup: async (keys, dx, dy) => {
        await need().session.dragGroup(keys, { dx, dy });
      },
      setCollapsed: async (key, collapsed) => {
        await need().session.setCollapsed(key, collapsed);
      },
      fieldUpdate: (key, label) => {
        labelOverrides.set(key, label);
        setScene(sceneOf(need().session));
      },
      addLeaf: async () => {
        const current = need().session.graph();
        const systemId = Math.max(...current.systems.map((system) => system.id)) + 1;
        const connectionId = Math.max(...current.connections.map((connection) => connection.id)) + 1;
        const state = (churn.current ??= { script: [], next: 0, lastAdded: null });
        state.lastAdded = connectionId;
        await addConnectionOp(
          { id: connectionId, createdAt: connectionId, endA: need().rootSystemId, endB: systemId },
          [{ id: systemId }],
        );
      },
      removeLast: async () => {
        const state = churn.current;
        if (state?.lastAdded === null || state === null) {
          throw new Error('nothing to remove');
        }
        await need().session.removeConnections([state.lastAdded]);
        state.lastAdded = null;
      },
      churnStep: async () => {
        const { session } = need();
        const state = (churn.current ??= {
          script: generateChurnScript(session.graph(), { seed: churnSeed, operationCount: churnCount }),
          next: 0,
          lastAdded: null,
        });
        const operation = state.script[state.next];
        if (operation === undefined) {
          return false;
        }
        state.next += 1;
        if (operation.kind === 'add') {
          const known = new Set(session.graph().systems.map((system) => system.id));
          const missing = [operation.connection.endA, operation.connection.endB]
            .filter((id): id is number => id !== null && !known.has(id))
            .map((id) => ({ id }));
          await session.addConnection(operation.connection, missing);
        } else {
          await session.removeConnections([operation.connectionId]);
        }
        return true;
      },
    };
  }, []);

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
