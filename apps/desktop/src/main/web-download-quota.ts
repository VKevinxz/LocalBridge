import { DevelopmentBrokerError } from '@localbridge/development';

export interface WebDownloadQuota {
  readonly mode?: 'fixed';
  readonly maxAssetBytes: number;
  readonly maxTotalBytes: number;
  readonly downloadedBytes: number;
}

export interface AdaptiveWebDownloadQuota {
  readonly mode: 'adaptive';
  readonly downloadedBytes: number;
}

export type EffectiveWebDownloadQuota = WebDownloadQuota | AdaptiveWebDownloadQuota;

function blocked(): never {
  throw new DevelopmentBrokerError('WEB_DOWNLOAD_QUOTA_EXCEEDED', 'La descarga supera la cuota del perfil.');
}

export function remainingWebDownloadBytes(quota: EffectiveWebDownloadQuota): number | undefined {
  if (!Number.isSafeInteger(quota.downloadedBytes) || quota.downloadedBytes < 0) {
    throw new DevelopmentBrokerError('INVALID_INPUT', 'La cuota web local no es válida.');
  }
  if (quota.mode === 'adaptive') return undefined;
  if (![quota.maxAssetBytes, quota.maxTotalBytes, quota.downloadedBytes].every(Number.isSafeInteger) ||
      quota.maxAssetBytes < 1 || quota.maxTotalBytes < quota.maxAssetBytes || quota.downloadedBytes < 0) {
    throw new DevelopmentBrokerError('INVALID_INPUT', 'La cuota web local no es válida.');
  }
  return Math.max(0, quota.maxTotalBytes - quota.downloadedBytes);
}

export function assertWebDownloadFits(size: number, quota: EffectiveWebDownloadQuota): void {
  if (!Number.isSafeInteger(size) || size < 0) blocked();
  if (quota.mode === 'adaptive') return;
  const remaining = remainingWebDownloadBytes(quota);
  if (size > quota.maxAssetBytes || remaining === undefined || size > remaining) blocked();
}
