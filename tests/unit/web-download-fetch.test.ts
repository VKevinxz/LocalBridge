import { describe, expect, it, vi } from 'vitest';

import { buildPublicResearchProfile, buildSiteAccountProfile } from '@localbridge/desktop-core';
import { fetchObservedWebResource } from '../../apps/desktop/src/main/web-download-fetch.js';

describe('descarga web observada', () => {
  it('usa la URL observada cuando Electron entrega response.url vacío', async () => {
    const profile = { ...buildPublicResearchProfile(), enabled: true };
    const response = new Response('ok', { status: 200, headers: { 'content-type': 'text/plain' } });
    const fetch = vi.fn(async () => response);

    const result = await fetchObservedWebResource(profile, 'https://assets.example.com/file.txt', fetch, new AbortController().signal);

    expect(result.response).toBe(response);
    expect(result.finalUrl.href).toBe('https://assets.example.com/file.txt');
    expect(fetch).toHaveBeenCalledWith('https://assets.example.com/file.txt', expect.objectContaining({ redirect: 'manual' }));
  });

  it('valida cada redirect antes de seguirlo y bloquea salidas no autorizadas', async () => {
    const profile = {
      ...buildSiteAccountProfile({ name: 'Cuenta', destinations: ['example.com'], supportHosts: [] }),
      enabled: true,
    };
    const fetch = vi.fn(async () => new Response(null, { status: 302, headers: { location: 'https://outside.example.net/file.css' } }));

    await expect(fetchObservedWebResource(profile, 'https://example.com/file.css', fetch, new AbortController().signal))
      .rejects.toMatchObject({ code: 'WEB_DESTINATION_BLOCKED' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('sigue redirects HTTPS relativos con un límite cerrado', async () => {
    const profile = { ...buildPublicResearchProfile(), enabled: true };
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: '/final.css' } }))
      .mockResolvedValueOnce(new Response('body{}', { status: 200, headers: { 'content-type': 'text/css' } }));

    const result = await fetchObservedWebResource(profile, 'https://example.com/source.css', fetch, new AbortController().signal);

    expect(result.finalUrl.href).toBe('https://example.com/final.css');
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
