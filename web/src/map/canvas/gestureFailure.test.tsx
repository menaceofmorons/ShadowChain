import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReactFlowCanvas, type CanvasEdge, type CanvasNode } from './index';

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

const NODES: CanvasNode[] = [
  { key: 's:1', x: 0, y: 0, isAlias: false, isRoot: true },
  { key: 'c:2', x: 0, y: 100, isAlias: false, hiddenCount: 3 },
];

const EDGES: CanvasEdge[] = [{ connectionId: 1, sourceKey: 's:1', targetKey: 'c:2' }];

describe('gesture dispatch failure', () => {
  it('swallows a rejected gesture and keeps the canvas mounted', async () => {
    const onGesture = vi.fn(() => Promise.reject(new Error('layout failed')));
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    container = document.createElement('div');
    container.style.width = '800px';
    container.style.height = '600px';
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <ReactFlowCanvas
          nodes={NODES}
          edges={EDGES}
          onNodeSelect={vi.fn()}
          onNodesMoved={vi.fn()}
          onGesture={onGesture}
        />,
      );
    });
    await act(async () => {
      container
        ?.querySelector('.react-flow__node[data-id="c:2"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    process.off('unhandledRejection', unhandled);
    expect(onGesture).toHaveBeenCalledWith({ type: 'set-collapsed', key: 'c:2', collapsed: false });
    expect(unhandled).not.toHaveBeenCalled();
    expect(container.querySelector('.react-flow__node[data-id="s:1"]')).not.toBeNull();
  });
});
