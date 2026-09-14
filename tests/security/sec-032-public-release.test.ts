import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

async function source(relativePath: string): Promise<string> {
  return readFile(path.join(process.cwd(), relativePath), 'utf8');
}

function actionReferences(workflow: string): string[] {
  return [...workflow.matchAll(/^\s*uses:\s*(\S+)\s*(?:#.*)?$/gm)].map((match) => match[1] ?? '');
}

describe('SEC-032 — publicación fail-closed', () => {
  it('CI usa permisos mínimos, lockfile y suite de seguridad', async () => {
    const workflow = await source('.github/workflows/ci.yml');

    expect(workflow).toContain('permissions:\n  contents: read');
    expect(workflow).not.toContain('pull_request_target');
    expect(workflow).toContain('pnpm install --frozen-lockfile');
    expect(workflow).toContain('pnpm test:sec');
    expect(workflow).toContain('pnpm build:native:test');
    expect(workflow).toContain('./scripts/export-public-source.ps1');
    expect(workflow).toContain('./scripts/check-github-workflows.ps1');
    expect(workflow).toContain('./scripts/audit-public-history.ps1');
    expect(actionReferences(workflow).every((reference) => /@[a-f0-9]{40}$/.test(reference))).toBe(true);
  });

  it('la release exige firma, timestamp, checksum, SBOM y atestación', async () => {
    const workflow = await source('.github/workflows/release.yml');
    const readiness = await source('scripts/check-publication-readiness.ps1');

    expect(workflow).toContain("'^v\\d+\\.\\d+\\.\\d+$'");
    expect(workflow).toContain('git merge-base --is-ancestor HEAD origin/main');
    expect(workflow).toContain('./scripts/check-publication-readiness.ps1');
    expect(readiness).toContain('UNLICENSED');
    expect(readiness).toContain('COPYRIGHT.md');
    expect(readiness).toContain('VKevinXZ');
    expect(readiness).toContain('LICENSE must be absent');
    expect(workflow).toContain('pnpm build:native:test');
    expect(workflow).toContain('WIN_CSC_LINK');
    expect(workflow).toContain('package:win:signed');
    expect(workflow).toContain('Get-AuthenticodeSignature');
    expect(workflow).toContain('TimeStamperCertificate');
    expect(workflow).toContain('generate-release-checksums.ps1');
    expect(workflow).not.toContain("'.yml', '.json', '.txt'");
    expect(workflow).toContain("'SHA256SUMS.txt'");
    expect(workflow).toContain('anchore/sbom-action/download-syft@');
    expect(workflow).toContain('syft-version: v1.51.0');
    expect(workflow).toContain("--source-name 'localbridge-desktop-windows'");
    expect(workflow).toContain('--source-version $version');
    expect(workflow).toContain('spdx-json=apps/desktop/release/localbridge-$env:GITHUB_REF_NAME.spdx.json');
    expect(workflow).toContain('actions/attest@');
    expect(workflow).toContain('gh release create $tag');
    expect(workflow).not.toContain('--prerelease');
    expect(actionReferences(workflow).every((reference) => /@[a-f0-9]{40}$/.test(reference))).toBe(true);
  });

  it('el prerelease sin firma está aislado, rotulado y conserva evidencias', async () => {
    const workflow = await source('.github/workflows/preview-release.yml');
    const notes = await source('docs/releases/preview-v1.1.0.3.md');
    const stableWorkflow = await source('.github/workflows/release.yml');
    const checksums = await source('scripts/generate-release-checksums.ps1');

    expect(workflow).toContain('preview-v*.*.*.*');
    expect(workflow).toContain("'^preview-v(?<version>\\d+\\.\\d+\\.\\d+)\\.(?<sequence>[1-9]\\d*)$'");
    expect(workflow).toContain('git merge-base --is-ancestor HEAD origin/main');
    expect(workflow).toContain('pnpm --filter @localbridge/desktop vendor:prepare');
    expect(workflow).toContain('pnpm --filter @localbridge/desktop build');
    expect(workflow).toContain(
      'pnpm --filter @localbridge/desktop exec electron-builder --win --publish never',
    );
    expect(workflow).not.toContain('package:win:signed');
    expect(workflow).not.toContain('WIN_CSC_LINK');
    expect(workflow).not.toContain('WIN_CSC_KEY_PASSWORD');
    expect(workflow).toContain("$signature.Status -ne 'NotSigned'");
    expect(workflow).toContain('smoke-packaged-desktop.ps1');
    expect(workflow).toContain('generate-release-checksums.ps1');
    expect(checksums).toContain("$artifact.Name.Replace(' ', '.')");
    expect(workflow).toContain('anchore/sbom-action/download-syft@');
    expect(workflow).toContain('actions/attest@');
    expect(workflow).toContain('gh release create $tag');
    expect(workflow).toContain('--prerelease');
    expect(notes).toContain('prerelease de evaluación sin firma Authenticode');
    expect(notes).toContain('No es una release estable');
    expect(stableWorkflow).toContain('package:win:signed');
    expect(stableWorkflow).not.toContain('--prerelease');
    expect(actionReferences(workflow).every((reference) => /@[a-f0-9]{40}$/.test(reference))).toBe(true);
  });

  it('la auditoría nunca imprime el contenido potencialmente secreto', async () => {
    const script = await source('scripts/audit-public-history.ps1');
    const snapshotAudit = await source('scripts/audit-public-snapshot.ps1');
    const manifest = await source('public-snapshot.json');

    expect(script).toContain('git grep -I -l');
    expect(script).not.toContain('git grep -I -n');
    expect(script).toContain('Findings list file names only');
    expect(script).toContain('tunnel-keys/[^/]+\\.enc$');
    expect(snapshotAudit).toContain("'.enc'");
    expect(manifest).toContain('".enc"');
  });

  it('fija por blob exacto el único secreto sintético permitido', async () => {
    const script = await source('scripts/audit-public-history.ps1');
    const fixture = await readFile(path.join(process.cwd(), 'tests/helpers/fixtures.ts'));
    const blob = createHash('sha1')
      .update(`blob ${fixture.length}\0`)
      .update(fixture)
      .digest('hex');

    const allowlist = script.match(/'tests\/helpers\/fixtures\.ts'\s*=\s*@\(([\s\S]*?)\r?\n\s*\)/)?.[1] ?? '';
    expect(allowlist).toContain(`'${blob}'`);
    const allowedBlobs = [...allowlist.matchAll(/'([^']+)'/g)].map((match) => match[1] ?? '');
    expect(allowedBlobs.length).toBeGreaterThan(0);
    expect(allowedBlobs.every((value) => /^[a-f0-9]{40}$/.test(value))).toBe(true);
  });

  it('actionlint se descarga de una versión y hash cerrados', async () => {
    const script = await source('scripts/check-github-workflows.ps1');

    expect(script).toContain("$version = '1.7.12'");
    expect(script).toContain("$expectedSha256 = '6e7241b51e6817ea6a047693d8e6fed13b31819c9a0dd6c5a726e1592d22f6e9'");
    expect(script).toContain('https://github.com/rhysd/actionlint/releases/download/');
    expect(script).toContain("$archive.GetEntry('actionlint.exe')");
    expect(script).not.toContain('Expand-Archive');
  });

  it('la preparación remota es explícita, idempotente y no recibe tokens por argumentos', async () => {
    const script = await source('scripts/configure-github-repository.ps1');
    const parameterBlock = script.match(/param\(([\s\S]*?)\n\)/)?.[1] ?? '';

    expect(parameterBlock).toContain('[switch]$Apply');
    expect(parameterBlock).not.toMatch(/token/i);
    expect(script.indexOf('if (-not $Apply)')).toBeLessThan(script.indexOf('LOCALBRIDGE_GITHUB_ADMIN_TOKEN'));
    expect(script).toContain("[Environment]::GetEnvironmentVariable('LOCALBRIDGE_GITHUB_ADMIN_TOKEN', 'Process')");
    expect(script).toContain("$apiRoot = 'https://api.github.com'");
    expect(script).toContain("$apiVersion = '2026-03-10'");
    expect(script).toContain('/private-vulnerability-reporting');
    expect(script).toContain('/immutable-releases');
    expect(script).not.toContain('Write-Output $token');
  });
});
