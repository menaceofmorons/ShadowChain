import ELK from 'elkjs/lib/elk.bundled.js';
import type { ElkNode, LayoutOptions } from 'elkjs/lib/elk-api';
import type { ChainNode } from '../../../model/types';
import { resolveEngineOptions } from '../../engineOptions';
import type { EngineOptions } from '../../engineOptions';
import type { LayoutEngine, LayoutMode, LayoutRequest, PlacedNode } from '../../types';

const RANDOM_SEED = '1';

function modeOptions(mode: LayoutMode, options: EngineOptions): LayoutOptions {
  const common: LayoutOptions = {
    'elk.randomSeed': RANDOM_SEED,
    'elk.spacing.nodeNode': String(options.siblingSpacing),
    'elk.edgeRouting': 'POLYLINE',
  };
  switch (mode) {
    case 'top-down':
      return { ...common, 'elk.algorithm': 'mrtree', 'elk.direction': 'DOWN' };
    case 'left-to-right':
      return { ...common, 'elk.algorithm': 'mrtree', 'elk.direction': 'RIGHT' };
    case 'radial':
      return {
        ...common,
        'elk.algorithm': 'radial',
        'elk.radial.radius': String(options.levelSpacing + 2 * options.nodeWidth),
        'elk.radial.centerOnRoot': 'true',
        'elk.radial.compactor': 'NONE',
      };
  }
}

function toElkGraph(request: LayoutRequest, options: EngineOptions): ElkNode {
  const children: ElkNode[] = [];
  const edges: { id: string; sources: string[]; targets: string[] }[] = [];
  const visit = (node: ChainNode): void => {
    const alias = node.kind === 'alias';
    children.push({
      id: node.keyString,
      width: alias ? options.aliasWidth : options.nodeWidth,
      height: alias ? options.aliasHeight : options.nodeHeight,
    });
    for (const child of node.children) {
      edges.push({ id: `${node.keyString}>${child.keyString}`, sources: [node.keyString], targets: [child.keyString] });
      visit(child);
    }
  };
  visit(request.tree.root);
  return {
    id: 'root',
    layoutOptions: modeOptions(request.mode, options),
    children,
    edges,
  };
}

function toOverlapGraph(arranged: ElkNode, options: EngineOptions): ElkNode {
  return {
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'sporeOverlap',
      'elk.randomSeed': RANDOM_SEED,
      'elk.spacing.nodeNode': String(options.siblingSpacing),
    },
    children: (arranged.children ?? []).map(({ id, x, y, width, height }) => ({ id, x, y, width, height })),
  };
}

function applyManual(placed: Map<string, PlacedNode>, request: LayoutRequest): void {
  for (const manual of request.manualPositions) {
    const node = placed.get(manual.nodeKey);
    if (node !== undefined) {
      placed.set(manual.nodeKey, { ...node, x: manual.x, y: manual.y, source: 'manual' });
    }
  }
}

export function createElkEngine(overrides: Partial<EngineOptions> = {}): LayoutEngine {
  const options = resolveEngineOptions(overrides);
  const elk = new ELK();
  return {
    async layout(request) {
      const arranged = await elk.layout(toElkGraph(request, options));
      const laidOut = request.mode === 'radial' ? await elk.layout(toOverlapGraph(arranged, options)) : arranged;
      const aliasByKey = new Map(request.tree.nodes.map((node) => [node.keyString, node.kind === 'alias']));
      const placed = new Map<string, PlacedNode>();
      for (const child of laidOut.children ?? []) {
        placed.set(child.id, {
          nodeKey: child.id,
          x: child.x ?? 0,
          y: child.y ?? 0,
          source: 'auto',
          alias: aliasByKey.get(child.id) ?? false,
        });
      }
      applyManual(placed, request);
      return [...placed.values()];
    },
  };
}
