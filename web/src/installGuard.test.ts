// REQUIRED: vitest environment directive; the guard shells out to npm and reads files
// @vitest-environment node
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const npmrcPath = fileURLToPath(new URL('../.npmrc', import.meta.url));
const created: string[] = [];

afterEach(() => {
  for (const directory of created.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const dryRunInstall = (enginesNode: string): { status: number | null; output: string } => {
  const directory = mkdtempSync(join(tmpdir(), 'install-guard-'));
  created.push(directory);
  writeFileSync(join(directory, '.npmrc'), readFileSync(npmrcPath, 'utf8'));
  writeFileSync(
    join(directory, 'package.json'),
    JSON.stringify({ name: 'install-guard', version: '1.0.0', private: true, engines: { node: enginesNode } }),
  );
  const result = spawnSync('npm install --dry-run --offline --no-audit --no-fund', {
    cwd: directory,
    encoding: 'utf8',
    shell: true,
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
};

const NPM_TIMEOUT_MS = 90_000;

describe('install guard', () => {
  it('commits engine-strict=true in web/.npmrc', () => {
    expect(readFileSync(npmrcPath, 'utf8')).toMatch(/^engine-strict=true\s*$/m);
  });

  it(
    'rejects an install whose Node range is unsatisfiable',
    () => {
      const { status, output } = dryRunInstall('>=999');
      expect(status).not.toBe(0);
      expect(output).toMatch(/EBADENGINE/);
    },
    NPM_TIMEOUT_MS,
  );

  it(
    'accepts the same install when the Node range is satisfiable',
    () => {
      const { status, output } = dryRunInstall('>=1');
      expect(output).not.toMatch(/EBADENGINE/);
      expect(status).toBe(0);
    },
    NPM_TIMEOUT_MS,
  );
});
