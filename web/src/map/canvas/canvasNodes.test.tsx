import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_ENGINE_OPTIONS } from '../layout/engineOptions';
import {
  canvasNodeKind,
  createHighlightStore,
  highlightGroups,
  movedNodes,
  ReactFlowCanvas,
  renderCounts,
  resetRenderCounts,
  type CanvasEdge,
  type CanvasNode,
  type MovedNode,
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
  { key: 'a:2:7', x: 200, y: 100, isAlias: true },
  { key: 'a:2:8', x: 400, y: 100, isAlias: true },
  { key: 'u:9', x: 0, y: 200, isAlias: false },
  { key: '+:s:3', x: 200, y: 200, isAlias: false, hiddenCount: 4 },
  { key: 's:5', x: 400, y: 200, isAlias: false },
];

const EDGES: CanvasEdge[] = [
  { connectionId: 1, sourceKey: 's:1', targetKey: 's:2' },
  { connectionId: 2, sourceKey: 's:1', targetKey: 'a:2:7' },
];

async function mount(nodes: readonly CanvasNode[], onNodeSelect = vi.fn()): Promise<void> {
  container = document.createElement('div');
  container.style.width = '800px';
  container.style.height = '600px';
  document.body.appendChild(container);
  root = createRoot(container);
  await show(nodes, onNodeSelect);
}

async function show(nodes: readonly CanvasNode[], onNodeSelect = vi.fn()): Promise<void> {
  await act(async () => {
    root?.render(<ReactFlowCanvas nodes={nodes} edges={EDGES} onNodeSelect={onNodeSelect} onNodesMoved={vi.fn()} />);
  });
}

const nodeEl = (key: string) => container?.querySelector<HTMLElement>(`.react-flow__node[data-id="${key}"]`);
const boxEl = (key: string) => nodeEl(key)?.querySelector<HTMLElement>(':scope > div');

async function click(key: string): Promise<void> {
  await act(async () => {
    nodeEl(key)?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

const highlighted = (): string[] =>
  [...(container?.querySelectorAll<HTMLElement>('.react-flow__node') ?? [])]
    .filter((el) => el.querySelector('[data-highlighted="true"]') !== null)
    .map((el) => el.dataset.id ?? '')
    .sort();

describe('node kinds', () => {
  it.each([
    ['s:1', 'system', 's:1', DEFAULT_ENGINE_OPTIONS.nodeWidth, DEFAULT_ENGINE_OPTIONS.nodeHeight],
    ['a:2:7', 'alias', 'a:2:7', DEFAULT_ENGINE_OPTIONS.aliasWidth, DEFAULT_ENGINE_OPTIONS.aliasHeight],
    ['u:9', 'unknown', '?', DEFAULT_ENGINE_OPTIONS.nodeWidth, DEFAULT_ENGINE_OPTIONS.nodeHeight],
    ['+:s:3', 'collapsed', '+4', DEFAULT_ENGINE_OPTIONS.collapsedWidth, DEFAULT_ENGINE_OPTIONS.collapsedHeight],
  ] as const)('%s renders as %s with label %s at the engine size', async (key, kind, label, width, height) => {
    await mount(SCENE);
    const box = boxEl(key);
    expect(box?.dataset.kind).toBe(kind);
    expect(box?.textContent).toBe(label);
    expect(box?.style.width).toBe(`${String(width)}px`);
    expect(box?.style.height).toBe(`${String(height)}px`);
  });

  it('draws the alias round and the system box square-cornered', async () => {
    await mount(SCENE);
    expect(boxEl('a:2:7')?.style.borderRadius).toBe('50%');
    expect(boxEl('s:2')?.style.borderRadius).toBe('3px');
  });

  it('styles the root differently from other system nodes', async () => {
    await mount(SCENE);
    expect(boxEl('s:1')?.style.borderTopWidth).not.toBe(boxEl('s:2')?.style.borderTopWidth);
  });

  it('classifies kinds from the node', () => {
    expect(canvasNodeKind({ key: 's:1', isAlias: false })).toBe('system');
    expect(canvasNodeKind({ key: 'a:1:2', isAlias: true })).toBe('alias');
    expect(canvasNodeKind({ key: 'u:3', isAlias: false })).toBe('unknown');
    expect(canvasNodeKind({ key: '+:s:3', isAlias: false, hiddenCount: 2 })).toBe('collapsed');
  });
});

describe('highlight groups', () => {
  it('groups a primary with its two aliases and leaves ? and +N out', () => {
    const groups = highlightGroups(SCENE);
    expect(groups.get('s:2')).toEqual(['s:2', 'a:2:7', 'a:2:8']);
    expect(groups.get('a:2:8')).toEqual(['s:2', 'a:2:7', 'a:2:8']);
    expect(groups.has('u:9')).toBe(false);
    expect(groups.has('+:s:3')).toBe(false);
  });

  it('highlights the primary and both aliases when an alias is selected', async () => {
    const onSelect = vi.fn();
    await mount(SCENE, onSelect);
    await click('a:2:7');
    expect(onSelect).toHaveBeenCalledWith('a:2:7');
    expect(highlighted()).toEqual(['a:2:7', 'a:2:8', 's:2']);
    expect(boxEl('a:2:7')?.dataset.selected).toBe('true');
    expect(boxEl('s:2')?.dataset.selected).toBeUndefined();
  });

  it('moves the highlight when another system is selected', async () => {
    await mount(SCENE);
    await click('a:2:7');
    await click('s:5');
    expect(highlighted()).toEqual(['s:5']);
  });

  it('selects a ? node or a +N node on its own', async () => {
    await mount(SCENE);
    await click('u:9');
    expect(highlighted()).toEqual(['u:9']);
    await click('+:s:3');
    expect(highlighted()).toEqual(['+:s:3']);
  });

  it('notifies only nodes whose mark changed', () => {
    const store = createHighlightStore();
    const listeners = new Map(['a', 'b', 'c'].map((key) => [key, vi.fn()]));
    listeners.forEach((listener, key) => store.subscribe(key, listener));
    store.set('a', ['a', 'b']);
    listeners.forEach((listener) => listener.mockClear());
    store.set('b', ['a', 'b']);
    expect(listeners.get('a')).toHaveBeenCalledTimes(1);
    expect(listeners.get('b')).toHaveBeenCalledTimes(1);
    expect(listeners.get('c')).not.toHaveBeenCalled();
  });
});

describe('movedNodes', () => {
  it('returns the exported MovedNode type', () => {
    const moved: MovedNode[] = movedNodes([{ id: 's:1', position: { x: 1, y: 2 } }]);
    expect(moved).toEqual([{ key: 's:1', x: 1, y: 2 }]);
  });
});

describe('memoisation', () => {
  it('does not re-render nodes when equal props arrive in new objects', async () => {
    await mount(SCENE);
    resetRenderCounts();
    await show(SCENE.map((node) => ({ ...node })));
    expect(renderCounts()).toEqual({});
  });

  it('re-renders only the node that moved', async () => {
    await mount(SCENE);
    resetRenderCounts();
    await show(SCENE.map((node) => (node.key === 's:5' ? { ...node, x: node.x + 40 } : { ...node })));
    expect(Object.keys(renderCounts())).toEqual(['s:5']);
  });

  it('re-renders only nodes whose highlight changed on selection', async () => {
    await mount(SCENE);
    resetRenderCounts();
    await click('s:2');
    expect(Object.keys(renderCounts()).sort()).toEqual(['a:2:7', 'a:2:8', 's:2']);
  });
});
