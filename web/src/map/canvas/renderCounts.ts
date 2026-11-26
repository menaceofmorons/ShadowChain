const counts = new Map<string, number>();

export function recordRender(key: string): void {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

export function renderCounts(): Record<string, number> {
  return Object.fromEntries(counts);
}

export function resetRenderCounts(): void {
  counts.clear();
}
