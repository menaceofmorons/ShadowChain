import { buildChainTree } from '../model/chainTree';
import { movedPlacedNodes, nodesOverlap, wanderer553 } from '../fixtures/wanderer';
import { runHarness } from '../harness/metricsHarness';
import type { LayoutMode, PlacedNode } from '../layout/types';
import { generateChain, generateChurnScript, SYNTHETIC_ROOT_SYSTEM_ID } from '../synthetic';
import type { BakeoffCandidate, StabilityRow, WandererRow } from './types';

export interface StabilityOptions {
  readonly seed: number;
  readonly churnSteps: number;
  readonly determinismRepeats: number;
}

export const DEFAULT_STABILITY_OPTIONS: StabilityOptions = { seed: 7, churnSteps: 30, determinismRepeats: 3 };

const sortedByKey = (nodes: readonly PlacedNode[]): readonly PlacedNode[] =>
  [...nodes].sort((a, b) => (a.nodeKey < b.nodeKey ? -1 : a.nodeKey > b.nodeKey ? 1 : 0));

const samePlacement = (a: readonly PlacedNode[], b: readonly PlacedNode[]): boolean =>
  a.length === b.length &&
  a.every((node, index) => {
    const other = b[index];
    return (
      other !== undefined &&
      other.nodeKey === node.nodeKey &&
      other.x === node.x &&
      other.y === node.y &&
      other.source === node.source &&
      other.alias === node.alias
    );
  });

async function isDeterministic(
  candidate: BakeoffCandidate,
  mode: LayoutMode,
  size: number,
  options: StabilityOptions,
): Promise<boolean> {
  const tree = buildChainTree(generateChain({ nodeCount: size, seed: options.seed }), SYNTHETIC_ROOT_SYSTEM_ID);
  const request = { type: 'full', tree, mode, manualPositions: [] } as const;
  const shared = candidate.createEngine();
  const first = sortedByKey(await shared.layout(request));
  for (let repeat = 1; repeat < options.determinismRepeats; repeat += 1) {
    const again = sortedByKey(await shared.layout(request));
    const fresh = sortedByKey(await candidate.createEngine().layout(request));
    if (!samePlacement(first, again) || !samePlacement(first, fresh)) {
      return false;
    }
  }
  return true;
}

export async function measureStability(
  candidate: BakeoffCandidate,
  mode: LayoutMode,
  size: number,
  options: StabilityOptions = DEFAULT_STABILITY_OPTIONS,
): Promise<StabilityRow> {
  const graph = generateChain({ nodeCount: size, seed: options.seed });
  const report = await runHarness({
    label: candidate.name,
    engine: candidate.createEngine(),
    graph,
    rootSystemId: SYNTHETIC_ROOT_SYSTEM_ID,
    churn: generateChurnScript(graph, { seed: options.seed + 1, operationCount: options.churnSteps }),
    engineSources: [],
    mode,
  });
  const { count, median, p95, max } = report.nodesMovedPerAddition;
  return {
    candidate: candidate.name,
    mode,
    size,
    churnSteps: options.churnSteps,
    moved: { count, median, p95, max },
    deterministic: await isDeterministic(candidate, mode, size, options),
  };
}

export async function measureWanderer553(candidate: BakeoffCandidate, mode: LayoutMode): Promise<WandererRow> {
  const { graph, startPositions, newNodeKey } = wanderer553;
  const previous: readonly PlacedNode[] = startPositions.map((position) => ({
    ...position,
    source: 'auto',
    alias: false,
    collapsed: false,
    hiddenCount: null,
  }));
  const outcome = await candidate.createEngine().layout({
    type: 'incremental',
    tree: buildChainTree(graph, SYNTHETIC_ROOT_SYSTEM_ID),
    mode,
    manualPositions: [],
    previous,
    addedNodeKeys: [newNodeKey],
    removedNodeKeys: [],
  });
  const added = outcome.find((node) => node.nodeKey === newNodeKey);
  const newNodeOverlaps =
    added === undefined || outcome.some((node) => node.nodeKey !== newNodeKey && nodesOverlap(added, node));
  const placedNodesMoved = movedPlacedNodes(startPositions, outcome).length;
  return {
    candidate: candidate.name,
    mode,
    newNodeOverlaps,
    placedNodesMoved,
    pass: !newNodeOverlaps && placedNodesMoved === 0,
  };
}

export async function runStability(
  candidates: readonly BakeoffCandidate[],
  sizes: readonly number[],
  options: StabilityOptions = DEFAULT_STABILITY_OPTIONS,
): Promise<{ readonly stability: readonly StabilityRow[]; readonly wanderer: readonly WandererRow[] }> {
  const stability: StabilityRow[] = [];
  const wanderer: WandererRow[] = [];
  for (const candidate of candidates) {
    for (const mode of candidate.modes) {
      wanderer.push(await measureWanderer553(candidate, mode));
      for (const size of sizes) {
        stability.push(await measureStability(candidate, mode, size, options));
      }
    }
  }
  return { stability, wanderer };
}
