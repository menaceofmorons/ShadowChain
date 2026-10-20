import { describe, expect, it } from 'vitest';

const sources = import.meta.glob('../**/*.{ts,tsx}', { query: '?raw', import: 'default', eager: true }) as Record<
  string,
  string
>;

const ENTRY = './workerBootstrap.ts';
const IMPORT_PATTERN = /(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]|import\s+['"]([^'"]+)['"]/g;

function specifiersOf(source: string): string[] {
  return [...source.matchAll(IMPORT_PATTERN)].map((match) => match[1] ?? match[2] ?? '');
}

function resolve(from: string, specifier: string): string {
  const parts = from.split('/').slice(0, -1);
  for (const part of specifier.split('/')) {
    if (part === '..') {
      const last = parts[parts.length - 1];
      if (last === undefined || last === '..') {
        parts.push('..');
      } else if (last === '.') {
        parts[parts.length - 1] = '..';
      } else {
        parts.pop();
      }
    } else if (part !== '.') {
      parts.push(part);
    }
  }
  const base = parts.join('/');
  return [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`].find((candidate) => candidate in sources) ?? base;
}

function walk(): { files: string[]; specifiers: string[] } {
  const files: string[] = [];
  const specifiers: string[] = [];
  const queue = [ENTRY];
  while (queue.length > 0) {
    const file = queue.pop();
    if (file === undefined || files.includes(file)) {
      continue;
    }
    files.push(file);
    for (const specifier of specifiersOf(sources[file] ?? '')) {
      specifiers.push(specifier);
      if (specifier.startsWith('.')) {
        queue.push(resolve(file, specifier));
      }
    }
  }
  return { files, specifiers };
}

describe('worker bootstrap import graph', () => {
  const graph = walk();

  it('reaches the bootstrap and its layout sources', () => {
    expect(graph.files).toContain(ENTRY);
    expect(graph.files).toContain('./workerHost.ts');
    expect(graph.files.length).toBeGreaterThan(3);
  });

  it('imports only from map/layout and map/model', () => {
    for (const file of graph.files) {
      expect(file.startsWith('./') || file.startsWith('../model/')).toBe(true);
    }
  });

  it('imports nothing from canvas, xyflow, CSS or the map barrel', () => {
    for (const specifier of graph.specifiers) {
      expect(specifier).not.toMatch(/canvas/);
      expect(specifier).not.toMatch(/@xyflow/);
      expect(specifier).not.toMatch(/\.css$/);
    }
    expect(graph.files).not.toContain('../index.ts');
  });
});
