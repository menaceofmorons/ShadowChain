export interface EngineOptions {
  readonly nodeWidth: number;
  readonly nodeHeight: number;
  readonly aliasWidth: number;
  readonly aliasHeight: number;
  readonly siblingSpacing: number;
  readonly levelSpacing: number;
}

export const DEFAULT_ENGINE_OPTIONS: EngineOptions = {
  nodeWidth: 160,
  nodeHeight: 48,
  aliasWidth: 96,
  aliasHeight: 32,
  siblingSpacing: 32,
  levelSpacing: 64,
};

export function resolveEngineOptions(overrides: Partial<EngineOptions> = {}): EngineOptions {
  return { ...DEFAULT_ENGINE_OPTIONS, ...overrides };
}
