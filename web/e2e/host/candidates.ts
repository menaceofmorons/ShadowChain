export const CANDIDATE_NAMES = ['tidy-tree', 'elkjs'] as const;

export type CandidateName = (typeof CANDIDATE_NAMES)[number];

export const isCandidateName = (value: string): value is CandidateName =>
  (CANDIDATE_NAMES as readonly string[]).includes(value);

export const CANDIDATE_WORKER_ENTRIES: Readonly<Record<CandidateName, string>> = {
  'tidy-tree': 'src/map/layout/engines/tidyTree/tidyTreeWorker.ts',
  elkjs: 'src/map/layout/engines/elk/elkWorker.ts',
};

export const CANDIDATE_SOURCES: Readonly<Record<CandidateName, readonly string[]>> = {
  'tidy-tree': [
    'src/map/layout/engines/tidyTree/tidyTreeEngine.ts',
    'src/map/layout/engines/tidyTree/tidyTreeWorker.ts',
    'src/map/layout/engines/tidyTree/index.ts',
  ],
  elkjs: [
    'src/map/layout/engines/elk/elkEngine.ts',
    'src/map/layout/engines/elk/elkWorker.ts',
    'src/map/layout/engines/elk/index.ts',
  ],
};
