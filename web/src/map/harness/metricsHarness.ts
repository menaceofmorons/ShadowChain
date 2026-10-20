import { buildChainTree } from '../model/chainTree';
import type { ChainGraph } from '../model/types';
import type { LayoutEngine, LayoutMode, ManualPosition, PlacedNode } from '../layout/types';
import { applyChurn } from '../synthetic/churnScript';
import type { ChurnOperation } from '../synthetic/churnScript';
import { measureCodeSize } from './codeSize';
import type { CodeSize, SourceFile } from './codeSize';
import { countMovedNodes } from './movement';
import { summarise } from './stats';
import type { TimingStats } from './stats';

export interface HarnessInput {
  readonly label: string;
  readonly engine: LayoutEngine;
  readonly graph: ChainGraph;
  readonly rootSystemId: number;
  readonly churn: readonly ChurnOperation[];
  readonly engineSources: readonly SourceFile[];
  readonly mode?: LayoutMode;
  readonly manualPositions?: readonly ManualPosition[];
  readonly now?: () => number;
  readonly fullRepeats?: number;
}

export interface MovedPerAddition extends TimingStats {
  readonly perAddition: readonly number[];
}

export interface HarnessReport {
  readonly label: string;
  readonly mode: LayoutMode;
  readonly nodeCount: number;
  readonly churnSteps: number;
  readonly nodesMovedPerAddition: MovedPerAddition;
  readonly fullLayoutMs: TimingStats;
  readonly incrementalLayoutMs: TimingStats;
  readonly additionLayoutMs: TimingStats;
  readonly removalLayoutMs: TimingStats;
  readonly codeSize: CodeSize;
}

export async function runHarness(input: HarnessInput): Promise<HarnessReport> {
  const now = input.now ?? (() => performance.now());
  const mode = input.mode ?? 'top-down';
  const manualPositions = input.manualPositions ?? [];
  const { engine, rootSystemId } = input;

  let graph = input.graph;
  let tree = buildChainTree(graph, rootSystemId);
  const fullRepeats = input.fullRepeats ?? 1;
  if (!Number.isInteger(fullRepeats) || fullRepeats < 1) {
    throw new Error('fullRepeats must be a positive integer');
  }
  const fullDurations: number[] = [];
  let placed: readonly PlacedNode[] = [];
  for (let repeat = 0; repeat < fullRepeats; repeat += 1) {
    const fullStart = now();
    placed = await engine.layout({ type: 'full', tree, mode, manualPositions });
    fullDurations.push(now() - fullStart);
  }

  const incrementalDurations: number[] = [];
  const additionDurations: number[] = [];
  const removalDurations: number[] = [];
  const movedPerAddition: number[] = [];
  let knownKeys: ReadonlySet<string> = new Set(tree.nodes.map((node) => node.keyString));

  for (const operation of input.churn) {
    graph = applyChurn(graph, [operation]);
    tree = buildChainTree(graph, rootSystemId);
    const nextKeys = new Set(tree.nodes.map((node) => node.keyString));
    const addedNodeKeys = [...nextKeys].filter((key) => !knownKeys.has(key));
    const removedNodeKeys = [...knownKeys].filter((key) => !nextKeys.has(key));
    const start = now();
    const next = await engine.layout({
      type: 'incremental',
      tree,
      mode,
      manualPositions,
      previous: placed,
      addedNodeKeys,
      removedNodeKeys,
    });
    const duration = now() - start;
    incrementalDurations.push(duration);
    (operation.kind === 'add' ? additionDurations : removalDurations).push(duration);
    if (operation.kind === 'add') {
      movedPerAddition.push(countMovedNodes(placed, next));
    }
    placed = next;
    knownKeys = nextKeys;
  }

  return {
    label: input.label,
    mode,
    nodeCount: input.graph.systems.length,
    churnSteps: input.churn.length,
    nodesMovedPerAddition: { ...summarise(movedPerAddition), perAddition: movedPerAddition },
    fullLayoutMs: summarise(fullDurations),
    incrementalLayoutMs: summarise(incrementalDurations),
    additionLayoutMs: summarise(additionDurations),
    removalLayoutMs: summarise(removalDurations),
    codeSize: measureCodeSize(input.engineSources),
  };
}
