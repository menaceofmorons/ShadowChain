import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  edgeRenderCounts,
  ReactFlowCanvas,
  renderCounts,
  resetRenderCounts,
  type CanvasEdge,
  type CanvasNode,
} from './index';

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

const SCENE: CanvasNode[] = [
  { key: 's:1', x: 0, y: 0, isAlias: false, isRoot: true },
  { key: 's:2', x: 0, y: 100, isAlias: false },
  { key: 's:3', x: 200, y: 100, isAlias: false },
  { key: 's:4', x: 400, y: 100, isAlias: false },
];

const EDGES: CanvasEdge[] = [
  { connectionId: 1, sourceKey: 's:1', targetKey: 's:2' },
  { connectionId: 2, sourceKey: 's:1', targetKey: 's:3' },
  { connectionId: 3, sourceKey: 's:1', targetKey: 's:4' },
];

async function show(nodes: readonly CanvasNode[], edges: readonly CanvasEdge[] = EDGES): Promise<void> {
  if (root === null) {
    container = document.createElement('div');
    container.style.width = '800px';
    container.style.height = '600px';
    document.body.appendChild(container);
    root = createRoot(container);
  }
  await act(async () => {
    root?.render(<ReactFlowCanvas nodes={nodes} edges={edges} onNodeSelect={vi.fn()} onNodesMoved={vi.fn()} />);
  });
}

const copy = (nodes: readonly CanvasNode[]): CanvasNode[] => nodes.map((node) => ({ ...node }));

describe('render counts per node and edge component', () => {
  it('renders no node and no edge when equal props arrive in new objects', async () => {
    await show(SCENE);
    resetRenderCounts();
    await show(
      copy(SCENE),
      EDGES.map((edge) => ({ ...edge })),
    );
    expect(renderCounts()).toEqual({});
    expect(edgeRenderCounts()).toEqual({});
  });

  it('renders only the moved node and its incident edge when one node moves', async () => {
    await show(SCENE);
    resetRenderCounts();
    await show(SCENE.map((node) => (node.key === 's:3' ? { ...node, x: node.x + 40 } : { ...node })));
    expect(Object.keys(renderCounts())).toEqual(['s:3']);
    expect(Object.keys(edgeRenderCounts())).toEqual(['s:1>s:3']);
  });

  it('renders only that node and no edge when one node field changes', async () => {
    await show(SCENE);
    resetRenderCounts();
    await show(SCENE.map((node) => (node.key === 's:4' ? { ...node, label: 'updated' } : { ...node })));
    expect(renderCounts()).toEqual({ 's:4': 1 });
    expect(edgeRenderCounts()).toEqual({});
  });

  it('draws the updated field on that node alone', async () => {
    await show(SCENE);
    await show(SCENE.map((node) => (node.key === 's:4' ? { ...node, label: 'updated' } : { ...node })));
    const text = (key: string) => container?.querySelector(`.react-flow__node[data-id="${key}"]`)?.textContent;
    expect(text('s:4')).toBe('updated');
    expect(text('s:3')).toBe('s:3');
  });

  it('renders only the added node and its edge when a node is added', async () => {
    await show(SCENE);
    resetRenderCounts();
    await show(
      [...copy(SCENE), { key: 's:5', x: 600, y: 100, isAlias: false }],
      [...EDGES, { connectionId: 4, sourceKey: 's:1', targetKey: 's:5' }],
    );
    expect(Object.keys(renderCounts())).toEqual(['s:5']);
    expect(Object.keys(edgeRenderCounts())).toEqual(['s:1>s:5']);
  });

  it('renders nothing when a node is removed and nothing else changes', async () => {
    await show(SCENE);
    resetRenderCounts();
    await show(copy(SCENE.slice(0, 3)), EDGES.slice(0, 2));
    expect(renderCounts()).toEqual({});
    expect(edgeRenderCounts()).toEqual({});
  });
});
