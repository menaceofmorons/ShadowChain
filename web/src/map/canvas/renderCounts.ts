const nodeCounts = new Map<string, number>();
const edgeCounts = new Map<string, number>();

const bump = (counts: Map<string, number>, key: string): void => {
  counts.set(key, (counts.get(key) ?? 0) + 1);
};

export function recordRender(key: string): void {
  bump(nodeCounts, key);
}

export function recordEdgeRender(key: string): void {
  bump(edgeCounts, key);
}

export function renderCounts(): Record<string, number> {
  return Object.fromEntries(nodeCounts);
}

export function edgeRenderCounts(): Record<string, number> {
  return Object.fromEntries(edgeCounts);
}

export function resetRenderCounts(): void {
  nodeCounts.clear();
  edgeCounts.clear();
}
