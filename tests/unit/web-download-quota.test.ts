import { describe, expect, it } from 'vitest';

import {
  assertWebDownloadFits,
  remainingWebDownloadBytes,
} from '../../apps/desktop/src/main/web-download-quota.js';

describe('cuota acumulada de descargas web', () => {
  const mib = 1024 * 1024;
  const quota = { maxAssetBytes: 100 * mib, maxTotalBytes: 1024 * mib, downloadedBytes: 950 * mib };

  it('permite un asset por encima de maxFileBytes mientras cabe en los dos presupuestos web', () => {
    expect(() => assertWebDownloadFits(50 * mib, quota)).not.toThrow();
    expect(remainingWebDownloadBytes(quota)).toBe(74 * mib);
  });

  it('rechaza por asset o por acumulado antes de guardar', () => {
    expect(() => assertWebDownloadFits(101 * mib, { ...quota, downloadedBytes: 0 }))
      .toThrowError(expect.objectContaining({ code: 'WEB_DOWNLOAD_QUOTA_EXCEEDED' }));
    expect(() => assertWebDownloadFits(75 * mib, quota))
      .toThrowError(expect.objectContaining({ code: 'WEB_DOWNLOAD_QUOTA_EXCEEDED' }));
  });

  it('falla cerrado si la contabilidad local es inválida', () => {
    expect(() => remainingWebDownloadBytes({ ...quota, downloadedBytes: -1 }))
      .toThrowError(expect.objectContaining({ code: 'INVALID_INPUT' }));
  });

  it('adaptive no impone una cuota numérica de producto y conserva la contabilidad válida', () => {
    const adaptive = { mode: 'adaptive' as const, downloadedBytes: 5 * mib };
    expect(remainingWebDownloadBytes(adaptive)).toBeUndefined();
    expect(() => assertWebDownloadFits(Number.MAX_SAFE_INTEGER, adaptive)).not.toThrow();
    expect(() => remainingWebDownloadBytes({ ...adaptive, downloadedBytes: -1 }))
      .toThrowError(expect.objectContaining({ code: 'INVALID_INPUT' }));
  });
});
