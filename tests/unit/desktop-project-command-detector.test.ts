import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

import { detectProjectCommands } from '@localbridge/desktop-core';

let rootPath: string;

beforeEach(async () => {
  rootPath = path.join(os.tmpdir(), `localbridge-detector-test-${randomUUID()}`);
  await mkdir(rootPath, { recursive: true });
});

describe('detectProjectCommands — package.json', () => {
  it('detecta cada script como candidato, con npm por defecto', async () => {
    await writeFile(path.join(rootPath, 'package.json'), JSON.stringify({ scripts: { build: 'vite build', dev: 'vite' } }));

    const detected = await detectProjectCommands(rootPath);

    expect(detected).toContainEqual(expect.objectContaining({ name: 'build', command: ['npm', 'run', 'build'], source: 'package.json (npm)' }));
    expect(detected).toContainEqual(expect.objectContaining({ name: 'dev', command: ['npm', 'run', 'dev'], source: 'package.json (npm)' }));
    expect(detected[0]?.processProfile.source.definitionSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('usa pnpm si hay pnpm-lock.yaml', async () => {
    await writeFile(path.join(rootPath, 'package.json'), JSON.stringify({ scripts: { build: 'tsc' } }));
    await writeFile(path.join(rootPath, 'pnpm-lock.yaml'), 'lockfileVersion: 6\n');

    const detected = await detectProjectCommands(rootPath);

    expect(detected).toContainEqual(expect.objectContaining({ name: 'build', command: ['pnpm', 'run', 'build'], source: 'package.json (pnpm)' }));
  });

  it('usa yarn si hay yarn.lock', async () => {
    await writeFile(path.join(rootPath, 'package.json'), JSON.stringify({ scripts: { test: 'vitest' } }));
    await writeFile(path.join(rootPath, 'yarn.lock'), '');

    const detected = await detectProjectCommands(rootPath);

    expect(detected).toContainEqual(expect.objectContaining({ name: 'test', command: ['yarn', 'run', 'test'], source: 'package.json (yarn)' }));
  });

  it('sin package.json, no propone nada de npm', async () => {
    expect(await detectProjectCommands(rootPath)).toEqual([]);
  });

  it('un package.json inválido (JSON roto) degrada a lista vacía, no lanza', async () => {
    await writeFile(path.join(rootPath, 'package.json'), 'esto no es json');

    await expect(detectProjectCommands(rootPath)).resolves.toEqual([]);
  });

  it('un package.json sin scripts no propone nada', async () => {
    await writeFile(path.join(rootPath, 'package.json'), JSON.stringify({ name: 'x' }));

    expect(await detectProjectCommands(rootPath)).toEqual([]);
  });
});

describe('detectProjectCommands — composer.json', () => {
  it('detecta cada script de composer', async () => {
    await writeFile(path.join(rootPath, 'composer.json'), JSON.stringify({ scripts: { test: 'phpunit', lint: 'phpcs' } }));

    const detected = await detectProjectCommands(rootPath);

    expect(detected).toContainEqual(expect.objectContaining({ name: 'test', command: ['composer', 'run', 'test'], source: 'composer.json' }));
    expect(detected).toContainEqual(expect.objectContaining({ name: 'lint', command: ['composer', 'run', 'lint'], source: 'composer.json' }));
  });
});

describe('detectProjectCommands — Makefile', () => {
  it('detecta objetivos reales, ignora recetas y directivas especiales', async () => {
    const makefile = [
      '.PHONY: build test',
      '',
      'build: deps',
      '\techo "building"',
      '',
      'test:',
      '\techo "testing"',
      '',
      '# un comentario: no cuenta',
      'VAR := valor',
      'clean:',
      '\trm -rf dist',
    ].join('\n');
    await writeFile(path.join(rootPath, 'Makefile'), makefile);

    const detected = await detectProjectCommands(rootPath);
    const names = detected.map((d) => d.name).toSorted();

    expect(names).toEqual(['build', 'clean', 'test']);
    expect(detected).toContainEqual(expect.objectContaining({ name: 'build', command: ['make', 'build'], source: 'Makefile' }));
  });

  it('no duplica un objetivo que aparece dos veces', async () => {
    await writeFile(path.join(rootPath, 'Makefile'), 'build:\n\techo one\nbuild:\n\techo two\n');

    const detected = await detectProjectCommands(rootPath);

    expect(detected.filter((d) => d.name === 'build')).toHaveLength(1);
  });

  it('sin Makefile, no propone nada de make', async () => {
    expect(await detectProjectCommands(rootPath)).toEqual([]);
  });
});

describe('detectProjectCommands — combinado', () => {
  it('combina candidatos de varias fuentes a la vez', async () => {
    await writeFile(path.join(rootPath, 'package.json'), JSON.stringify({ scripts: { build: 'tsc' } }));
    await writeFile(path.join(rootPath, 'Makefile'), 'deploy:\n\techo deploy\n');

    const detected = await detectProjectCommands(rootPath);

    expect(detected.map((d) => d.name).toSorted()).toEqual(['build', 'deploy']);
  });
});
