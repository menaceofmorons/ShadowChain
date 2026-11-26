import { describe, expect, it, vi } from 'vitest';
import type { MapSession } from '../../session';
import { applyGesture } from './applyGesture';
import { menuItemsFor, planDrag, type DraggedNode } from './gestures';
import { ALONE_DRAG_MODIFIER, MULTI_SELECTION_KEY_CODES, SELECTION_KEY_CODE, decodeModifiers } from './modifiers';
import { acrossDelta, constrainToRootAxis, rootAxisFor } from './rootAxis';

const dragged = (key: string, dx: number, dy: number, extra: Partial<DraggedNode> = {}): DraggedNode => ({
  key,
  kind: 'system',
  isRoot: false,
  start: { x: 10, y: 20 },
  end: { x: 10 + dx, y: 20 + dy },
  ...extra,
});

describe('modifier decoding', () => {
  it('Alt means a single-node drag', () => {
    expect(ALONE_DRAG_MODIFIER).toBe('altKey');
    expect(decodeModifiers({ altKey: true }).aloneDrag).toBe(true);
    expect(decodeModifiers({ shiftKey: true, ctrlKey: true }).aloneDrag).toBe(false);
  });

  it('Shift means rubber band', () => {
    expect(SELECTION_KEY_CODE).toBe('Shift');
    expect(decodeModifiers({ shiftKey: true }).rubberBand).toBe(true);
    expect(decodeModifiers({ altKey: true }).rubberBand).toBe(false);
  });

  it('Ctrl and Cmd toggle selection', () => {
    expect(MULTI_SELECTION_KEY_CODES).toEqual(['Control', 'Meta']);
    expect(decodeModifiers({ ctrlKey: true }).toggleSelection).toBe(true);
    expect(decodeModifiers({ metaKey: true }).toggleSelection).toBe(true);
    expect(decodeModifiers({}).toggleSelection).toBe(false);
  });
});

describe('root across-axis constraint', () => {
  const start = { x: 100, y: 50 };
  const proposed = { x: 160, y: 90 };

  it('top-down moves only along x', () => {
    expect(rootAxisFor('top-down')).toBe('x');
    expect(constrainToRootAxis('top-down', start, proposed)).toEqual({ x: 160, y: 50 });
    expect(acrossDelta('top-down', start, proposed)).toBe(60);
  });

  it('left-to-right moves only along y', () => {
    expect(rootAxisFor('left-to-right')).toBe('y');
    expect(constrainToRootAxis('left-to-right', start, proposed)).toEqual({ x: 100, y: 90 });
    expect(acrossDelta('left-to-right', start, proposed)).toBe(40);
  });

  it('radial does not move the root', () => {
    expect(rootAxisFor('radial')).toBeNull();
    expect(constrainToRootAxis('radial', start, proposed)).toEqual(start);
    expect(acrossDelta('radial', start, proposed)).toBe(0);
  });
});

describe('drag planning', () => {
  it('a plain drag of one node is a node drag to its end position', () => {
    expect(planDrag({ mode: 'top-down', alone: false, nodes: [dragged('s:2', 30, 5)] })).toEqual({
      type: 'drag-node',
      key: 's:2',
      to: { x: 40, y: 25 },
    });
  });

  it('an Alt drag of one node is a node-alone drag', () => {
    expect(planDrag({ mode: 'radial', alone: true, nodes: [dragged('s:2', 30, 5)] })?.type).toBe('drag-node-alone');
  });

  it('several dragged nodes become one group drag by the same delta', () => {
    const plan = planDrag({
      mode: 'top-down',
      alone: true,
      nodes: [dragged('s:2', 50, 40), dragged('s:3', 50, 40), dragged('s:4', 50, 40)],
    });
    expect(plan).toEqual({ type: 'drag-group', keys: ['s:2', 's:3', 's:4'], delta: { dx: 50, dy: 40 } });
  });

  it('root drag becomes the across-axis delta in tree modes', () => {
    const root = dragged('s:1', 30, 70, { isRoot: true });
    expect(planDrag({ mode: 'top-down', alone: false, nodes: [root] })).toEqual({ type: 'move-root', delta: 30 });
    expect(planDrag({ mode: 'left-to-right', alone: false, nodes: [root] })).toEqual({ type: 'move-root', delta: 70 });
  });

  it('the root is never part of a group and never moves in radial', () => {
    const root = dragged('s:1', 30, 70, { isRoot: true });
    expect(planDrag({ mode: 'radial', alone: false, nodes: [root] })).toBeNull();
    const plan = planDrag({
      mode: 'top-down',
      alone: false,
      nodes: [root, dragged('s:2', 5, 5), dragged('s:3', 5, 5)],
    });
    expect(plan).toMatchObject({ type: 'drag-group', keys: ['s:2', 's:3'] });
  });

  it('collapsed markers and unmoved nodes plan nothing', () => {
    expect(
      planDrag({ mode: 'top-down', alone: false, nodes: [dragged('+:s:2', 9, 9, { kind: 'collapsed' })] }),
    ).toBeNull();
    expect(planDrag({ mode: 'top-down', alone: false, nodes: [dragged('s:2', 0, 0)] })).toBeNull();
    expect(planDrag({ mode: 'top-down', alone: false, nodes: [] })).toBeNull();
  });
});

describe('context menu items', () => {
  const base = { key: 's:2', kind: 'system', isRoot: false, canCollapse: true } as const;

  it('offers Collapse and Reset position for a node with children', () => {
    expect(menuItemsFor(base).map((item) => item.id)).toEqual(['collapse', 'reset']);
    expect(menuItemsFor(base)[0]?.gesture).toEqual({ type: 'set-collapsed', key: 's:2', collapsed: true });
  });

  it('offers only Reset position for a leaf, an alias and an unknown end', () => {
    expect(menuItemsFor({ ...base, canCollapse: false }).map((item) => item.id)).toEqual(['reset']);
    expect(menuItemsFor({ ...base, kind: 'alias' }).map((item) => item.id)).toEqual(['reset']);
    expect(menuItemsFor({ ...base, kind: 'unknown' }).map((item) => item.id)).toEqual(['reset']);
  });

  it('offers only Expand for a +N node', () => {
    const items = menuItemsFor({ ...base, key: '+:s:2', kind: 'collapsed' });
    expect(items.map((item) => item.id)).toEqual(['expand']);
    expect(items[0]?.gesture).toEqual({ type: 'set-collapsed', key: '+:s:2', collapsed: false });
  });

  it('offers nothing for the root', () => {
    expect(menuItemsFor({ ...base, isRoot: true })).toEqual([]);
  });
});

describe('applying gestures to the session', () => {
  const makeSession = () => {
    const session = {
      store: { rootOffset: () => 12 },
      dragNode: vi.fn(() => Promise.resolve([])),
      dragNodeAlone: vi.fn(() => Promise.resolve([])),
      dragGroup: vi.fn(() => Promise.resolve([])),
      moveRoot: vi.fn(() => Promise.resolve(true)),
      resetPosition: vi.fn(() => Promise.resolve()),
      setCollapsed: vi.fn(() => Promise.resolve()),
    };
    return { session, typed: session as unknown as MapSession };
  };

  it('calls exactly one session method per gesture', async () => {
    const { session, typed } = makeSession();
    await applyGesture(typed, { type: 'drag-node', key: 's:2', to: { x: 1, y: 2 } });
    await applyGesture(typed, { type: 'drag-node-alone', key: 's:3', to: { x: 3, y: 4 } });
    await applyGesture(typed, { type: 'drag-group', keys: ['s:2', 's:3'], delta: { dx: 5, dy: 6 } });
    await applyGesture(typed, { type: 'move-root', delta: 8 });
    await applyGesture(typed, { type: 'reset-position', key: 's:2' });
    await applyGesture(typed, { type: 'set-collapsed', key: 's:2', collapsed: true });
    expect(session.dragNode).toHaveBeenCalledExactlyOnceWith('s:2', { x: 1, y: 2 });
    expect(session.dragNodeAlone).toHaveBeenCalledExactlyOnceWith('s:3', { x: 3, y: 4 });
    expect(session.dragGroup).toHaveBeenCalledExactlyOnceWith(['s:2', 's:3'], { dx: 5, dy: 6 });
    expect(session.moveRoot).toHaveBeenCalledExactlyOnceWith(20);
    expect(session.resetPosition).toHaveBeenCalledExactlyOnceWith('s:2');
    expect(session.setCollapsed).toHaveBeenCalledExactlyOnceWith('s:2', true);
  });
});
