export interface WebNavigationObservation {
  readonly currentUrl: string;
  readonly destinationUrl: string;
  readonly pageState: 'ready' | 'loading' | 'failed' | 'closed';
}

/**
 * Chromium puede rechazar loadURL con ERR_ABORTED aunque ya haya alcanzado el
 * destino, en especial al recargar la misma URL. Solo recuperamos el resultado
 * cuando la URL observable coincide exactamente y la pestaña no falló ni cerró.
 */
export function didNavigationReachDestination(observation: WebNavigationObservation): boolean {
  return observation.pageState !== 'failed' &&
    observation.pageState !== 'closed' &&
    observation.currentUrl === observation.destinationUrl;
}
