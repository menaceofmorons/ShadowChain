import type { ChainNode, ChainNodeKind } from '../model/types';

export interface EngineOptions {
  readonly nodeWidth: number;
  readonly nodeHeight: number;
  readonly aliasWidth: number;
  readonly aliasHeight: number;
  readonly collapsedWidth: number;
  readonly collapsedHeight: number;
  readonly siblingSpacing: number;
  readonly levelSpacing: number;
}

export const DEFAULT_ENGINE_OPTIONS: EngineOptions = {
  nodeWidth: 160,
  nodeHeight: 48,
  aliasWidth: 96,
  aliasHeight: 32,
  collapsedWidth: 64,
  collapsedHeight: 32,
  siblingSpacing: 32,
  levelSpacing: 64,
};

export function resolveEngineOptions(overrides: Partial<EngineOptions> = {}): EngineOptions {
  return { ...DEFAULT_ENGINE_OPTIONS, ...overrides };
}

export function nodeSizeForKind(kind: ChainNodeKind, options: EngineOptions): { width: number; height: number } {
  switch (kind) {
    case 'alias':
      return { width: options.aliasWidth, height: options.aliasHeight };
    case 'collapsed':
      return { width: options.collapsedWidth, height: options.collapsedHeight };
    default:
      return { width: options.nodeWidth, height: options.nodeHeight };
  }
}

export function nodeSize(node: ChainNode, options: EngineOptions): { width: number; height: number } {
  return nodeSizeForKind(node.kind, options);
}
