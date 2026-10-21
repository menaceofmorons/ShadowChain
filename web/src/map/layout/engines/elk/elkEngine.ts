import ELK from 'elkjs/lib/elk.bundled.js';
import type { ElkNode, LayoutOptions } from 'elkjs/lib/elk-api';
import type { ChainNode } from '../../../model/types';
import { resolveEngineOptions } from '../../engineOptions';
import type { EngineOptions } from '../../engineOptions';
import type { LayoutEngine, LayoutMode, LayoutRequest, PlacedNode } from '../../types';

const RANDOM_SEED = '1';
const RADIAL_COMPACTION_STEP = '8';
const RADIAL_RADIUS_GROWTH = 1.5;
const MAX_RADIAL_ATTEMPTS = 5;

// TUNE: initial radial radius per sqrt(node count), chosen so 150, 250 and 500-node chains lay out clean on the first attempt.
const RADIAL_RADIUS_PER_SQRT_NODE = 100;

const initialRadialRadius = (nodeCount: number, options: EngineOptions): number =>
  Math.max(options.levelSpacing + 2 * options.nodeWidth, Math.ceil(RADIAL_RADIUS_PER_SQRT_NODE * Math.sqrt(nodeCount)));

function modeOptions(mode: LayoutMode, options: EngineOptions, radialRadius: number): LayoutOptions {
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
        'elk.radial.radius': String(radialRadius),
        'elk.radial.centerOnRoot': 'true',
        'elk.radial.wedgeCriteria': 'LEAF_NUMBER',
        'elk.radial.compactor': 'RADIAL_COMPACTION',
        'elk.radial.compactionStepSize': RADIAL_COMPACTION_STEP,
      };
  }
}

function toElkGraph(request: LayoutRequest, options: EngineOptions, radialRadius: number): ElkNode {
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
    layoutOptions: modeOptions(request.mode, options, radialRadius),
    children,
    edges,
  };
}

function depthsOf(root: ChainNode): Map<string, number> {
  const depths = new Map<string, number>();
  const visit = (node: ChainNode, depth: number): void => {
    depths.set(node.keyString, depth);
    node.children.forEach((child) => {
      visit(child, depth + 1);
    });
  };
  visit(root, 0);
  return depths;
}

function isRadialLayoutClean(arranged: ElkNode, depths: Map<string, number>, gap: number): boolean {
  const boxes = (arranged.children ?? []).map(({ id, x = 0, y = 0, width = 0, height = 0 }) => ({
    depth: depths.get(id) ?? 0,
    x,
    y,
    width,
    height,
  }));
  const innermostByDepth = new Map<number, number>();
  const outermostByDepth = new Map<number, number>();
  const root = boxes.find((box) => box.depth === 0);
  const centreX = root === undefined ? 0 : root.x + root.width / 2;
  const centreY = root === undefined ? 0 : root.y + root.height / 2;
  for (const box of boxes) {
    const distance = Math.hypot(box.x + box.width / 2 - centreX, box.y + box.height / 2 - centreY);
    innermostByDepth.set(box.depth, Math.min(innermostByDepth.get(box.depth) ?? distance, distance));
    outermostByDepth.set(box.depth, Math.max(outermostByDepth.get(box.depth) ?? distance, distance));
  }
  for (const [depth, outermost] of outermostByDepth) {
    const next = innermostByDepth.get(depth + 1);
    if (next !== undefined && next <= outermost) {
      return false;
    }
  }
  for (let i = 0; i < boxes.length; i += 1) {
    const a = boxes[i] as (typeof boxes)[number];
    for (let j = i + 1; j < boxes.length; j += 1) {
      const b = boxes[j] as (typeof boxes)[number];
      if (
        a.x < b.x + b.width + gap &&
        b.x < a.x + a.width + gap &&
        a.y < b.y + b.height + gap &&
        b.y < a.y + a.height + gap
      ) {
        return false;
      }
    }
  }
  return true;
}

async function layoutRadial(
  elk: InstanceType<typeof ELK>,
  request: LayoutRequest,
  options: EngineOptions,
): Promise<ElkNode> {
  const depths = depthsOf(request.tree.root);
  let radius = initialRadialRadius(request.tree.nodes.length, options);
  let arranged = await elk.layout(toElkGraph(request, options, radius));
  for (let attempt = 1; attempt < MAX_RADIAL_ATTEMPTS; attempt += 1) {
    if (isRadialLayoutClean(arranged, depths, options.siblingSpacing / 2)) {
      break;
    }
    radius *= RADIAL_RADIUS_GROWTH;
    arranged = await elk.layout(toElkGraph(request, options, radius));
  }
  return arranged;
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
      const laidOut =
        request.mode === 'radial'
          ? await layoutRadial(elk, request, options)
          : await elk.layout(toElkGraph(request, options, 0));
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
