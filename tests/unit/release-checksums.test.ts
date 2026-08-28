import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const roots: string[] = [];

afterEach(async () => Promise.all(roots.splice(0).map((target) => rm(target, { recursive: true, force: true }))));

describe.skipIf(process.platform !== 'win32')('checksums de release', () => {
  it('genera hashes SHA-256 deterministas solo para artefactos permitidos', async () => {
    const root = path.join(os.tmpdir(), `localbridge-checksums-${randomUUID()}`);
    roots.push(root);
    await mkdir(root, { recursive: true });
    await writeFile(path.join(root, 'LocalBridge MCP Setup 0.2.0.exe'), 'installer', 'utf8');
    await writeFile(path.join(root, 'LocalBridge MCP Setup 0.2.0.exe.blockmap'), 'blockmap', 'utf8');
    await writeFile(path.join(root, 'localbridge-v0.2.0.spdx.json'), '{}', 'utf8');
    await writeFile(path.join(root, 'builder-debug.yml'), 'private build paths', 'utf8');
    await writeFile(path.join(root, 'private.log'), 'not-an-asset', 'utf8');

    await execFileAsync('powershell.exe', [
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-File', path.join(process.cwd(), 'scripts', 'generate-release-checksums.ps1'),
      '-ReleaseDirectory', root,
      '-Version', '0.2.0',
    ]);

    const lines = (await readFile(path.join(root, 'SHA256SUMS.txt'), 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^[a-f0-9]{64}  LocalBridge\.MCP\.Setup\.0\.2\.0\.exe\r?$/);
    expect(lines[1]).toMatch(/^[a-f0-9]{64}  LocalBridge\.MCP\.Setup\.0\.2\.0\.exe\.blockmap\r?$/);
    expect(lines[2]).toMatch(/^[a-f0-9]{64}  localbridge-v0\.2\.0\.spdx\.json\r?$/);
    expect(lines.join('\n')).not.toContain('private.log');
    expect(lines.join('\n')).not.toContain('builder-debug.yml');
  });
});
