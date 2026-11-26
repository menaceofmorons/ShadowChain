import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { connectionEncoding } from '../../encoding';
import type { ConnectionSize, LifeStage, MassStatus } from '../../model/types';
import { ReactFlowCanvas, type CanvasEdge, type CanvasNode } from '../index';

const MASSES: MassStatus[] = ['fresh', 'reduced', 'critical'];
const STAGES: LifeStage[] = [1, 2, 3, 4];
const SIZES: ConnectionSize[] = ['small', 'medium', 'large', 'freighter', 'capital', 'unknown'];

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

async function render(nodes: CanvasNode[], edges: CanvasEdge[]): Promise<HTMLDivElement> {
  container = document.createElement('div');
  container.style.width = '800px';
  container.style.height = '600px';
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(<ReactFlowCanvas nodes={nodes} edges={edges} onNodeSelect={vi.fn()} onNodesMoved={vi.fn()} />);
  });
  return container;
}

const combos = MASSES.flatMap((massStatus) =>
  STAGES.flatMap((lifeStage) => SIZES.map((size) => ({ massStatus, lifeStage, size }))),
);

describe('edge encoding on the DOM', () => {
  it('draws colour, width, dash and badge equal to the encoding for every value', async () => {
    const nodes: CanvasNode[] = [
      { key: 'root', x: 0, y: 0, isAlias: false, isRoot: true },
      ...combos.map((_, i) => ({
        key: `s:${String(i)}`,
        x: (i % 12) * 200,
        y: 200 + Math.floor(i / 12) * 100,
        isAlias: false,
      })),
    ];
    const edges: CanvasEdge[] = combos.map((attributes, i) => ({
      connectionId: i + 1,
      sourceKey: 'root',
      targetKey: `s:${String(i)}`,
      encodings: [{ connectionId: i + 1, ...connectionEncoding(attributes) }],
    }));
    const dom = await render(nodes, edges);
    combos.forEach((attributes, i) => {
      const expected = connectionEncoding(attributes);
      const group = dom.querySelector(`[data-connector="${String(i + 1)}"]`);
      const path = group?.querySelector('path');
      expect(path?.getAttribute('stroke')).toBe(expected.colour);
      expect(Number(path?.getAttribute('stroke-width'))).toBe(expected.width);
      expect(path?.getAttribute('stroke-dasharray')).toBe(expected.dash.length === 0 ? null : expected.dash.join(' '));
      const badge = group?.querySelector('[data-badge]');
      expect(badge?.getAttribute('data-badge') ?? null).toBe(expected.badge);
      expect(badge?.textContent ?? null).toBe(expected.badge);
    });
  });

  it('orders widths fresh over reduced over critical', () => {
    const [fresh, reduced, critical] = MASSES.map((massStatus) => connectionEncoding({ massStatus }).width);
    expect(fresh).toBeGreaterThan(reduced as number);
    expect(reduced).toBeGreaterThan(critical as number);
  });

  it('an edge without attributes draws the neutral default with no badge', async () => {
    const nodes: CanvasNode[] = [
      { key: 'a', x: 0, y: 0, isAlias: false },
      { key: 'b', x: 0, y: 200, isAlias: false },
    ];
    const dom = await render(nodes, [{ connectionId: 1, sourceKey: 'a', targetKey: 'b' }]);
    const neutral = connectionEncoding({});
    const path = dom.querySelector('[data-connector="1"] path');
    expect(path?.getAttribute('stroke')).toBe(neutral.colour);
    expect(dom.querySelectorAll('[data-badge]')).toHaveLength(0);
  });

  it('a parallel pair draws two paths, each with its own encoding and badge', async () => {
    const nodes: CanvasNode[] = [
      { key: 'a', x: 0, y: 0, isAlias: false },
      { key: 'b', x: 0, y: 200, isAlias: false },
    ];
    const first = connectionEncoding({ massStatus: 'fresh', lifeStage: 1, size: 'small' });
    const second = connectionEncoding({ massStatus: 'critical', lifeStage: 4, size: 'capital' });
    const dom = await render(nodes, [
      {
        connectionId: 1,
        sourceKey: 'a',
        targetKey: 'b',
        encodings: [first, second],
      },
    ]);
    const paths = [...dom.querySelectorAll('[data-connector="1"] [data-path]')];
    expect(paths).toHaveLength(2);
    expect(paths[0]?.querySelector('path')?.getAttribute('stroke')).toBe(first.colour);
    expect(paths[1]?.querySelector('path')?.getAttribute('stroke')).toBe(second.colour);
    expect(paths[0]?.querySelector('[data-badge]')?.getAttribute('data-badge')).toBe('S');
    expect(paths[1]?.querySelector('[data-badge]')?.getAttribute('data-badge')).toBe('C');
    expect(paths[0]?.querySelector('path')?.getAttribute('d')).not.toBe(
      paths[1]?.querySelector('path')?.getAttribute('d'),
    );
  });
});
