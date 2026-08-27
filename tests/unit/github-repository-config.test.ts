import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

interface Ruleset {
  name: string;
  target: string;
  enforcement: string;
  conditions: { ref_name: { include: string[]; exclude: string[] } };
  rules: Array<{ type: string; parameters?: Record<string, unknown> }>;
}

async function ruleset(name: string): Promise<Ruleset> {
  const content = await readFile(path.join(process.cwd(), '.github', 'rulesets', name), 'utf8');
  return JSON.parse(content) as Ruleset;
}

describe.skipIf(process.platform !== 'win32')('configuración del repositorio GitHub', () => {
  it('protege ramas y tags de release con reglas activas cerradas', async () => {
    const branches = await ruleset('protected-branches.json');
    const tags = await ruleset('release-tags.json');

    expect(branches).toMatchObject({
      target: 'branch',
      enforcement: 'active',
      conditions: { ref_name: { include: ['refs/heads/main', 'refs/heads/develop'], exclude: [] } },
    });
    expect(branches.rules.map(({ type }) => type)).toEqual([
      'deletion',
      'non_fast_forward',
      'pull_request',
      'required_status_checks',
    ]);
    expect(tags).toMatchObject({
      target: 'tag',
      enforcement: 'active',
      conditions: { ref_name: { include: ['refs/tags/v*'], exclude: [] } },
    });
    expect(tags.rules.map(({ type }) => type)).toEqual(['creation', 'update', 'deletion']);
  });

  it('valida el plan sin token, red ni mutaciones cuando falta -Apply', async () => {
    const { stdout } = await execFileAsync('powershell.exe', [
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-File', path.join(process.cwd(), 'scripts', 'configure-github-repository.ps1'),
      '-Repository', 'example/localbridge-mcp',
      '-ReleaseReviewer', 'maintainer',
    ]);

    expect(stdout).toContain('Validated GitHub publication plan for example/localbridge-mcp.');
    expect(stdout).toContain('Apply was not requested; no network call or repository mutation occurred.');
    expect(stdout).toContain('Protect main and develop');
    expect(stdout).toContain('Protect release tags');
  });
});
