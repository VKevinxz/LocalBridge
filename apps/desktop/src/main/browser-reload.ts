import type { WebContents } from 'electron';

export type BrowserReloadMode = 'normal' | 'ignore-cache';

/** Espera una navegación principal terminada sin alterar partición, viewport ni storage. */
export async function reloadManagedWebContents(
  contents: WebContents,
  mode: BrowserReloadMode,
  timeoutMs = 20_000,
): Promise<void> {
  if (contents.isDestroyed()) throw new Error('web contents destroyed');
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      contents.off('did-finish-load', onFinish);
      contents.off('did-fail-load', onFail);
      contents.off('render-process-gone', onGone);
      contents.off('destroyed', onDestroyed);
      if (error === undefined) resolve(); else reject(error);
    };
    const onFinish = (): void => finish();
    const onFail = (_event: Electron.Event, errorCode: number, errorDescription: string, _url: string, isMainFrame: boolean): void => {
      if (isMainFrame && errorCode !== -3) finish(new Error(errorDescription || `reload failed (${errorCode})`));
    };
    const onGone = (): void => finish(new Error('renderer process unavailable'));
    const onDestroyed = (): void => finish(new Error('web contents destroyed'));
    const timer = setTimeout(() => finish(new Error('reload timed out')), timeoutMs);
    timer.unref();
    contents.once('did-finish-load', onFinish);
    contents.on('did-fail-load', onFail);
    contents.once('render-process-gone', onGone);
    contents.once('destroyed', onDestroyed);
    try {
      if (mode === 'ignore-cache') contents.reloadIgnoringCache();
      else contents.reload();
    } catch (error) {
      finish(error instanceof Error ? error : new Error('reload failed'));
    }
  });
}
