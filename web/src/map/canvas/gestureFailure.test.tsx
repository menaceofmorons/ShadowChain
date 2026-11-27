import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReactFlowCanvas, type CanvasEdge, type CanvasNode } from './index';

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  vi.unstubAllGlobals();
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

function stopAutoPan(): void {
  vi.stubGlobal('requestAnimationFrame', () => 0);
  vi.stubGlobal('cancelAnimationFrame', () => undefined);
}

function mount(nodes: CanvasNode[], onGesture: () => Promise<void>) {
  if (root === null) {
    container = document.createElement('div');
    container.style.width = '800px';
    container.style.height = '600px';
    document.body.appendChild(container);
    root = createRoot(container);
  }
  act(() => {
    root?.render(
      <ReactFlowCanvas
        nodes={nodes}
        edges={EDGES}
        onNodeSelect={vi.fn()}
        onNodesMoved={vi.fn()}
        onGesture={onGesture}
      />,
    );
  });
}

function nodeTransform(key: string): string {
  return (container?.querySelector(`.react-flow__node[data-id="${key}"]`) as HTMLElement).style.transform;
}

function dragNode(key: string, dx: number, dy: number): void {
  const node = container?.querySelector(`.react-flow__node[data-id="${key}"]`) as HTMLElement;
  const view = node.ownerDocument.defaultView;
  const fire = (target: EventTarget, type: string, x: number, y: number): void => {
    const event = new MouseEvent(type, { bubbles: true, button: 0, clientX: x, clientY: y });
    Object.defineProperty(event, 'view', { value: view });
    target.dispatchEvent(event);
  };
  fire(node, 'mousedown', 100, 100);
  fire(window, 'mousemove', 100 + dx / 2, 100 + dy / 2);
  fire(window, 'mousemove', 100 + dx, 100 + dy);
  fire(window, 'mouseup', 100 + dx, 100 + dy);
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 50));

const BASE_TRANSFORM = 'translate(0px,0px)';

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

  it('returns a dragged node to its base position when the gesture is rejected', async () => {
    let reject: (reason: Error) => void = () => undefined;
    const onGesture = vi.fn(
      () =>
        new Promise<void>((_, rej) => {
          reject = rej;
        }),
    );
    stopAutoPan();
    mount(NODES, onGesture);
    await act(async () => {
      dragNode('s:1', 40, 0);
      await settle();
    });
    await act(async () => {
      reject(new Error('layout failed'));
      await settle();
    });
    expect(onGesture).toHaveBeenCalled();
    expect(nodeTransform('s:1')).toBe(BASE_TRANSFORM);
  });

  it('resyncs to the latest plan when an earlier gesture rejects after a newer plan published', async () => {
    let reject: (reason: Error) => void = () => undefined;
    const onGesture = vi.fn(
      () =>
        new Promise<void>((_, rej) => {
          reject = rej;
        }),
    );
    stopAutoPan();
    mount(NODES, onGesture);
    await act(async () => {
      dragNode('s:1', 40, 0);
      await settle();
    });
    const moved = NODES.map((node) => (node.key === 's:1' ? { ...node, x: 200 } : node));
    mount(moved, onGesture);
    await act(async () => {
      reject(new Error('layout failed'));
      await settle();
    });
    expect(nodeTransform('s:1')).toContain('translate(200px');
  });
});
