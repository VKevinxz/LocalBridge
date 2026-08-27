/**
 * Decide la red disponible para una sesión aislada sin ampliar su allowlist.
 *
 * Un WebSocket same-origin usa `ws:` aunque la página aprobada use `http:`. Electron
 * lo identifica además como `webSocket`; solo esa combinación puede reutilizar la
 * autoridad (IP + puerto) de un origen HTTP ya aprobado.
 */
export function isAllowedBrowserRequest(
  requestUrl: string,
  resourceType: string,
  allowedOrigins: ReadonlySet<string>,
): boolean {
  try {
    const url = new URL(requestUrl);
    if (allowedOrigins.has(url.origin)) return true;
    if (resourceType !== 'webSocket' || url.protocol !== 'ws:') return false;
    if (url.username !== '' || url.password !== '') return false;

    url.protocol = 'http:';
    return allowedOrigins.has(url.origin);
  } catch {
    return false;
  }
}
