import type { WebProfile } from '@localbridge/desktop-core';
import { DevelopmentBrokerError } from '@localbridge/development';

import { isWebEgressHostAllowed, normalizePublicHttpsUrl } from './web-network-policy.js';

const MAX_WEB_DOWNLOAD_REDIRECTS = 8;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export type WebResourceFetch = (
  url: string,
  init: { readonly redirect: 'manual'; readonly signal: AbortSignal },
) => Promise<Response>;

function fail(code: string, message: string): never {
  throw new DevelopmentBrokerError(code, message);
}

function allowedUrl(profile: WebProfile, value: string): URL {
  const parsed = normalizePublicHttpsUrl(value);
  if (parsed === undefined || !isWebEgressHostAllowed(profile, parsed.hostname)) {
    fail('WEB_DESTINATION_BLOCKED', 'La descarga redirigió fuera del perfil web.');
  }
  return parsed;
}

/**
 * Sigue redirects de forma explícita. Electron puede omitir `Response.url` en
 * `session.fetch`; la URL observada sigue siendo la fuente demostrada cuando no
 * hubo redirect, mientras que cada `Location` se valida antes del siguiente I/O.
 */
export async function fetchObservedWebResource(
  profile: WebProfile,
  sourceUrl: string,
  fetchResource: WebResourceFetch,
  signal: AbortSignal,
): Promise<{ readonly response: Response; readonly finalUrl: URL }> {
  let current = allowedUrl(profile, sourceUrl);

  for (let redirectCount = 0; redirectCount <= MAX_WEB_DOWNLOAD_REDIRECTS; redirectCount += 1) {
    // eslint-disable-next-line no-await-in-loop -- cada Location depende de la respuesta anterior y se valida antes del siguiente I/O
    const response = await fetchResource(current.href, { redirect: 'manual', signal });
    if (!REDIRECT_STATUSES.has(response.status)) {
      const reported = response.url.trim();
      return {
        response,
        finalUrl: reported === '' ? current : allowedUrl(profile, reported),
      };
    }

    if (redirectCount === MAX_WEB_DOWNLOAD_REDIRECTS) {
      fail('WEB_DOWNLOAD_BLOCKED', 'La descarga superó el límite de redirecciones.');
    }
    const location = response.headers.get('location');
    if (location === null || location.trim() === '') {
      fail('WEB_DOWNLOAD_BLOCKED', 'La descarga devolvió una redirección inválida.');
    }
    let redirected: URL;
    try {
      redirected = new URL(location, current);
    } catch {
      fail('WEB_DESTINATION_BLOCKED', 'La descarga redirigió fuera del perfil web.');
    }
    current = allowedUrl(profile, redirected.href);
  }

  fail('WEB_DOWNLOAD_BLOCKED', 'La descarga superó el límite de redirecciones.');
}
