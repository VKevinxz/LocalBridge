import { describe, expect, it } from 'vitest';

import { didNavigationReachDestination } from '../../apps/desktop/src/main/web-navigation-outcome.js';

describe('didNavigationReachDestination', () => {
  it('recupera el rechazo tardío al recargar exactamente la URL actual', () => {
    const url = 'https://example.com/product?view=full';
    expect(didNavigationReachDestination({
      currentUrl: url,
      destinationUrl: url,
      pageState: 'ready',
    })).toBe(true);
  });

  it('no confunde otro destino ni una pestaña fallida con navegación completada', () => {
    expect(didNavigationReachDestination({
      currentUrl: 'https://example.com/a',
      destinationUrl: 'https://example.com/b',
      pageState: 'ready',
    })).toBe(false);
    expect(didNavigationReachDestination({
      currentUrl: 'https://example.com/a',
      destinationUrl: 'https://example.com/a',
      pageState: 'failed',
    })).toBe(false);
  });
});
