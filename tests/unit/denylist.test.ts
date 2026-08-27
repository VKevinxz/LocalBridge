import { describe, expect, it } from 'vitest';

import { DEFAULT_DENY_PATTERNS, isPathDenied } from '@localbridge/workspace';

describe('isPathDenied — denylist por defecto (SECURITY.md §5)', () => {
  it.each([
    '.env',
    'nested/.env',
    '.env.local',
    'secrets.pem',
    'nested/deep/secrets.pem',
    'private.key',
    'id_rsa',
    'id_ed25519',
    'credentials.json',
    '.npmrc',
    '.netrc',
    '.git/config',
  ])('deniega "%s"', (candidate) => {
    expect(isPathDenied(candidate, DEFAULT_DENY_PATTERNS)).toBe(true);
  });

  it.each(['src/index.ts', 'README.md', 'package.json', '.gitignore', 'envs.ts', 'my.pem.txt'])(
    'permite "%s"',
    (candidate) => {
      expect(isPathDenied(candidate, DEFAULT_DENY_PATTERNS)).toBe(false);
    },
  );

  it('".git/config" no deniega otros archivos dentro de .git', () => {
    expect(isPathDenied('.git/HEAD', DEFAULT_DENY_PATTERNS)).toBe(false);
  });
});

describe('isPathDenied — patrones personalizados', () => {
  it('un patrón con "/" al final deniega el directorio y todo su contenido', () => {
    const patterns = ['secrets/'];
    expect(isPathDenied('secrets', patterns)).toBe(true);
    expect(isPathDenied('secrets/token.txt', patterns)).toBe(true);
    expect(isPathDenied('secrets/nested/deep.txt', patterns)).toBe(true);
    expect(isPathDenied('not-secrets/token.txt', patterns)).toBe(false);
  });

  it('separadores de Windows se normalizan antes de comparar', () => {
    expect(isPathDenied('.git\\config', ['.git/config'])).toBe(true);
  });

  it('una lista vacía no deniega nada', () => {
    expect(isPathDenied('.env', [])).toBe(false);
  });
});
