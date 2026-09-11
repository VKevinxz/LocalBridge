import { createHash } from "node:crypto";

import { app, BrowserWindow, type WebContentsView } from "electron";

import { buildPublicResearchProfile, buildSiteAccountProfile, webProfileRevision, type WebProfile } from "@localbridge/desktop-core";
import { LocalBridgeError } from "@localbridge/shared";
import { WebController } from "../apps/desktop/src/main/web-controller.js";

for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code !== 'EPIPE') throw error;
  });
}

app.disableHardwareAcceleration();
app.commandLine.appendSwitch("force-webrtc-ip-handling-policy", "disable_non_proxied_udp");
app.commandLine.appendSwitch("disable-quic");
app.on("window-all-closed", () => { /* sesiones secuenciales del verificador */ });
const stage = (message: string): void => { process.stderr.write(`[electron-web-test] ${message}\n`); };

async function main(): Promise<void> {
  await app.whenReady();
  let profile: WebProfile = {
    ...buildPublicResearchProfile(new Date("2026-09-05T00:00:00.000Z"), "Public test"),
    enabled: true,
    permissions: { read: true, interact: false, download: false, humanControl: false },
  };
  const captureDiagnostics: Array<Record<string, unknown>> = [];
  const savedEvidence: Array<{ path: string; mimeType: string; bytes: Buffer }> = [];
  let savedMotionBundles = 0;
  const controller = new WebController({
    loadProfile: async (id) => id === profile.id ? profile : undefined,
    listProfiles: async () => [profile],
    reconciliationIntervalMs: 50,
    onCaptureDiagnostic: (event) => captureDiagnostics.push({ ...event }),
    saveDownload: async (input) => {
      if (input.path === "evidence/too-large.png") throw new LocalBridgeError("FILE_TOO_LARGE");
      const bytes = Buffer.from(input.bytes);
      savedEvidence.push({ path: input.path, mimeType: input.mimeType, bytes });
      return { path: input.path, sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length, created: true };
    },
    saveMotionBundle: async ({ path: destinationPath, produce }) => {
      const files: Array<{ path: string; sha256: string; size: number }> = [];
      let totalSize = 0;
      const value = await produce({
        get totalSize() { return totalSize; },
        get fileCount() { return files.length; },
        get maxFileBytes() { return 256 * 1024 * 1024; },
        get maxTotalBytes() { return 1024 * 1024 * 1024; },
        ensureCapacity: async (requiredBytes) => {
          if (totalSize + requiredBytes > 1024 * 1024 * 1024) throw new LocalBridgeError("FILE_TOO_LARGE");
        },
        write: async (relativePath, input) => {
          const bytes = Buffer.from(input);
          if (bytes.length > 256 * 1024 * 1024 || totalSize + bytes.length > 1024 * 1024 * 1024) {
            throw new LocalBridgeError("FILE_TOO_LARGE");
          }
          const receipt = { path: relativePath, sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length };
          files.push(receipt);
          totalSize += bytes.length;
          return receipt;
        },
      });
      savedMotionBundles += 1;
      return { path: destinationPath, created: true, totalSize, fileCount: files.length, files, value };
    },
  });

  try {
    const downloadQueue = controller as unknown as {
      acquireDownloadSlot(signal?: AbortSignal): Promise<() => void>;
    };
    const releaseFirstDownload = await downloadQueue.acquireDownloadSlot();
    let secondDownloadStarted = false;
    const secondDownload = downloadQueue.acquireDownloadSlot().then((release) => {
      secondDownloadStarted = true;
      return release;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    if (secondDownloadStarted) throw new Error('la cola admitió dos descargas pesadas simultáneas');
    releaseFirstDownload();
    const releaseSecondDownload = await secondDownload;
    releaseSecondDownload();
    const cancelledDownload = new AbortController();
    const releaseQueueOwner = await downloadQueue.acquireDownloadSlot();
    const cancelledWaiter = downloadQueue.acquireDownloadSlot(cancelledDownload.signal);
    cancelledDownload.abort();
    let cancelledWhileQueued = false;
    try { await cancelledWaiter; }
    catch (error) { cancelledWhileQueued = error instanceof Error && 'code' in error && error.code === 'ANALYSIS_CANCELLED'; }
    releaseQueueOwner();
    if (!cancelledWhileQueued) throw new Error('una descarga en cola no respondió a cancelación');
    stage('download-queue-verified');

    const viewerOnly = await controller.start(profile.id, "viewer_read_only");
    stage("viewer-read-only-started");
    const viewerInternals = controller as unknown as {
      entries: Map<string, { tabs: Map<string, { tabId: string; window: BrowserWindow; content: WebContentsView }> }>;
    };
    const viewerTab = viewerInternals.entries.get(viewerOnly.session.sessionId)?.tabs.get(viewerOnly.tab.tabId);
    if (viewerTab === undefined) throw new Error("no se recuperó la pestaña de investigación de solo lectura");
    const remoteContentsId = viewerTab.content.webContents.id;
    const remotePartition = viewerTab.content.webContents.session;
    const remoteContentY = viewerTab.content.getBounds().y;
    const windowCount = BrowserWindow.getAllWindows().length;
    const workArea = { x: 0, y: 0, width: 1920, height: 1080 };
    await controller.showLiveViewerLocally(viewerOnly.session.sessionId, "follow", workArea);
    const shownState = controller.getLocalLiveViewerState();
    if (!shownState.visible || shownState.tabId !== viewerOnly.tab.tabId || !viewerTab.window.isVisible() || viewerTab.window.isFocusable()) {
      throw new Error("la vista pública de solo lectura no se mostró pasiva");
    }
    const fittedBounds = viewerTab.window.getBounds();
    const fittedContent = viewerTab.content.getBounds();
    const viewerCapture = await controller.screenshot(viewerOnly.session.sessionId, viewerOnly.tab.tabId);
    if (fittedBounds.width >= 1920 || fittedBounds.height !== workArea.height ||
        Math.abs(fittedContent.width / fittedContent.height - 16 / 9) > 0.01 ||
        viewerCapture.width !== 1920 || viewerCapture.height !== 1080) {
      throw new Error(`el visor web no encajó 1920x1080 sin alterar la evidencia: ${JSON.stringify({ fittedBounds, fittedContent, screenshot: [viewerCapture.width, viewerCapture.height] })}`);
    }
    if (!viewerTab.window.webContents.getTitle().includes("Solo observación")) {
      throw new Error("la banda local confiable no identifica la vista pasiva");
    }
    const viewerHeader = await viewerTab.window.webContents.executeJavaScript("document.body.innerText", true) as string;
    if (!viewerHeader.includes("Pestaña nueva · sin destino") || !viewerHeader.includes("Render 1920×1080")) {
      throw new Error("la banda local no identifica el contexto de la pestaña visible");
    }
    const fitHash = createHash("sha256").update(Buffer.from(viewerCapture.dataBase64, "base64")).digest("hex");
    await controller.setLiveViewerPresentationLocally(viewerOnly.session.sessionId, "actual", 500, 200);
    const actualState = controller.getLocalLiveViewerState();
    const actualContent = viewerTab.content.getBounds();
    const actualCapture = await controller.screenshot(viewerOnly.session.sessionId, viewerOnly.tab.tabId);
    const actualHash = createHash("sha256").update(Buffer.from(actualCapture.dataBase64, "base64")).digest("hex");
    if (actualState.presentation?.mode !== "actual" || actualState.presentation.scale !== 1 ||
        actualState.presentation.panX <= 0 || actualState.presentation.panY <= 0 || actualContent.x >= 0 || actualContent.y >= 0 ||
        fitHash !== actualHash || actualCapture.width !== 1920 || actualCapture.height !== 1080) {
      throw new Error(`el modo web 1:1 alteró el render, no aplicó pan local o cambió la captura: ${JSON.stringify({ actualState, actualContent, fitHash, actualHash })}`);
    }
    await controller.setLiveViewerPresentationLocally(viewerOnly.session.sessionId, "fit");
    await viewerTab.content.webContents.executeJavaScript("document.title = 'Título remoto falso'", true);
    if (viewerTab.window.webContents.getTitle().includes("Título remoto falso")) {
      throw new Error("el contenido remoto modificó la identificación local");
    }
    await viewerTab.content.webContents.debugger.sendCommand("Runtime.evaluate", {
      expression: "void document.documentElement.requestFullscreen().catch(() => undefined)",
      awaitPromise: false,
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (viewerTab.window.isFullScreen() || viewerTab.content.getBounds().y !== remoteContentY ||
        !viewerTab.window.webContents.getTitle().includes("Solo observación")) {
      throw new Error("el fullscreen remoto cubrió o alteró la banda local");
    }
    await viewerTab.content.webContents.debugger.sendCommand("Runtime.evaluate", {
      expression: "void (document.fullscreenElement ? document.exitFullscreen() : undefined)",
      awaitPromise: false,
    });
    await controller.moveLiveViewerLocally(viewerOnly.session.sessionId, { x: 100, y: 50, width: 1600, height: 900 });
    const movedState = controller.getLocalLiveViewerState();
    if (!movedState.visible || movedState.tabId !== viewerOnly.tab.tabId) throw new Error("mover ocultó o sustituyó la pestaña");
    const movedBounds = viewerTab.window.getBounds();
    if (movedBounds.x < 100 || movedBounds.y < 50 || movedBounds.width > 1600 || movedBounds.height > 900) {
      throw new Error("el visor web no cabe en el work area elegido");
    }
    viewerTab.window.close();
    await new Promise((resolve) => setTimeout(resolve, 50));
    if (viewerTab.window.isDestroyed() || controller.getLocalLiveViewerState().visible) {
      throw new Error("cerrar la vista pasiva destruyó la pestaña o no la ocultó");
    }
    for (let index = 0; index < 50; index += 1) {
      await controller.showLiveViewerLocally(viewerOnly.session.sessionId, "follow", workArea);
      await controller.hideLiveViewerLocally(viewerOnly.session.sessionId);
    }
    if (viewerTab.content.webContents.id !== remoteContentsId || viewerTab.content.webContents.session !== remotePartition ||
        BrowserWindow.getAllWindows().length !== windowCount ||
        (await controller.tabs(viewerOnly.session.sessionId)).length !== 1) {
      throw new Error("abrir y ocultar recreó recursos o cambió la identidad web");
    }
    const viewerSummary = (await controller.tabs(viewerOnly.session.sessionId))[0];
    if (viewerSummary?.viewport.width !== 1920 || viewerSummary.viewport.height !== 1080 || viewerSummary.viewport.mobile) {
      throw new Error("la sesión web no inició con render 1920x1080");
    }
    await controller.stop(viewerOnly.session.sessionId, "stop_viewer_read_only");
    if (controller.listAll().find((item) => item.sessionId === viewerOnly.session.sessionId)?.closeReason !== "agent") {
      throw new Error("web.stop no registró que el cliente cerró la sesión");
    }
    stage("viewer-read-only-verified");

    profile = {
      ...profile,
      permissions: { read: true, interact: true, download: true, humanControl: false },
      updatedAt: "2026-09-05T00:00:30.000Z",
    };
    const first = await controller.start(profile.id, "start_1");
    stage("interactive-session-started");
    const repeated = await controller.start(profile.id, "start_1");
    if (first.session.sessionId !== repeated.session.sessionId) throw new Error("web.start no fue idempotente");
    if ((await controller.list()).length !== 1 || (await controller.tabs(first.session.sessionId)).length !== 1) {
      throw new Error("la sesión o su pestaña no se redescubren");
    }

    let privateBlocked = false;
    try { await controller.navigate(first.session.sessionId, first.tab.tabId, "https://127.0.0.1/private", "nav_1"); }
    catch (error) { privateBlocked = error instanceof Error && "code" in error && error.code === "WEB_DESTINATION_BLOCKED"; }
    if (!privateBlocked) throw new Error("se aceptó una navegación privada");

    let crossIdBlocked = false;
    try { await controller.tabs("session_aaaaaaaaaaaaaaaaaaaaaaaa"); }
    catch (error) { crossIdBlocked = error instanceof Error && "code" in error && error.code === "WEB_SESSION_NOT_FOUND"; }
    if (!crossIdBlocked) throw new Error("se aceptó un ID de browser.* en web.*");

    const internals = controller as unknown as {
      entries: Map<string, { activeAgentOperations: number; delegatedExpiresAt?: number; tabs: Map<string, { tabId: string; window: BrowserWindow; content: WebContentsView; currentViewport: { width: number; height: number; mobile: boolean } }> }>;
      createTab(entry: unknown, destination?: URL, humanMode?: boolean): Promise<{ tabId: string; window: BrowserWindow; content: WebContentsView }>;
      installDebugger(contents: Electron.WebContents, viewport: { width: number; height: number; mobile: boolean }): Promise<void>;
    };
    const entry = internals.entries.get(first.session.sessionId);
    const firstManagedTab = entry?.tabs.get(first.tab.tabId);
    if (entry === undefined || firstManagedTab === undefined) throw new Error("no se recuperó la pestaña administrada");
    await firstManagedTab.content.webContents.executeJavaScript(`
      document.body.innerHTML = '<img src="https://example.com/hero.png?token=secret#fragment" alt="Hero firmado"><video aria-label="Vídeo fixture" style="display:block;width:1px;height:1px" poster="data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%221920%22 height=%221080%22%3E%3Crect width=%221920%22 height=%221080%22 fill=%22%23123456%22/%3E%3C/svg%3E"></video><button id="once">Ejecutar una vez</button><button id="uncertain">Efecto incierto</button><input id="upload" type="file" aria-label="Archivo directo"><label for="upload">Elegir archivo</label><button id="indirect">Archivo indirecto</button><button id="delayed-file">Archivo tardío</button><a id="download" href="data:text/plain,ok" download="fixture.txt">Descarga nativa</a>';
      globalThis.__once = 0; globalThis.__uncertain = 0;
      document.querySelector('#once').addEventListener('click', () => { globalThis.__once += 1; });
      document.querySelector('#uncertain').addEventListener('click', () => { globalThis.__uncertain += 1; });
      document.querySelector('#indirect').addEventListener('click', () => document.querySelector('#upload').click());
      document.querySelector('#delayed-file').addEventListener('click', () => setTimeout(() => document.querySelector('#upload').click(), 250));
    `, true);
    const listedAssets = await controller.assets(first.session.sessionId, first.tab.tabId, 50);
    const signedAsset = listedAssets.assets.find((asset) => asset.label === "Hero firmado");
    if (signedAsset === undefined || signedAsset.url.includes("token=secret") || signedAsset.url.includes("#fragment")) {
      throw new Error("web.assets expuso parámetros firmados de un recurso");
    }
    for (let index = 0; index < 3; index += 1) {
      const captured = await controller.screenshot(first.session.sessionId, first.tab.tabId);
      if (captured.width !== 1920 || captured.height !== 1080 || !["image/png", "image/jpeg"].includes(captured.mimeType) || captured.dataBase64.length === 0) {
        throw new Error(`la captura web con vídeo no respetó el viewport o no entregó imagen (${captured.width}x${captured.height}, ${captured.mimeType}, ${captured.dataBase64.length})`);
      }
    }
    await firstManagedTab.content.webContents.executeJavaScript(`(() => {
      const canvas = document.createElement('canvas'); canvas.id = 'noise'; canvas.width = 1920; canvas.height = 1080;
      canvas.style.cssText = 'position:fixed;inset:0;width:1920px;height:1080px;z-index:2147483647'; document.body.append(canvas);
      const context = canvas.getContext('2d'); const image = context.createImageData(1920, 1080); let state = 0x87654321;
      for (let index = 0; index < image.data.length; index += 4) {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        image.data[index] = state & 255; image.data[index + 1] = (state >>> 8) & 255; image.data[index + 2] = (state >>> 16) & 255; image.data[index + 3] = 255;
      }
      context.putImageData(image, 0, 0);
    })()`, true);
    const largeWebCapture = await controller.screenshot(first.session.sessionId, first.tab.tabId);
    await firstManagedTab.content.webContents.executeJavaScript("document.querySelector('#noise')?.remove()", true);
    if (largeWebCapture.mimeType !== "image/jpeg" || !largeWebCapture.fallbackUsed || largeWebCapture.width !== 1920 || largeWebCapture.height !== 1080) {
      throw new Error(`la captura web grande no usó fallback JPEG acotado: ${largeWebCapture.mimeType} ${largeWebCapture.width}x${largeWebCapture.height}`);
    }
    const mobileViewport = await controller.setViewport(first.session.sessionId, first.tab.tabId, 390, 844, true, "viewport_mobile");
    const mobileCapture = await controller.screenshot(first.session.sessionId, first.tab.tabId);
    if (mobileViewport.width !== 390 || mobileViewport.height !== 844 || !mobileViewport.mobile ||
        mobileCapture.width !== 390 || mobileCapture.height !== 844) {
      throw new Error("web.viewport no aplicó una resolución solicitada distinta de 1920x1080");
    }
    await controller.setViewport(first.session.sessionId, first.tab.tabId, 1920, 1080, false, "viewport_desktop");
    let staleViewportReplayBlocked = false;
    try { await controller.setViewport(first.session.sessionId, first.tab.tabId, 390, 844, true, "viewport_mobile"); }
    catch (error) { staleViewportReplayBlocked = error instanceof Error && "code" in error && error.code === "IDEMPOTENCY_CONFLICT"; }
    if (!staleViewportReplayBlocked) throw new Error("web.viewport devolvió un recibo idempotente obsoleto");
    await firstManagedTab.content.webContents.executeJavaScript(`(() => {
      document.body.style.minHeight = '3000px';
      const style = document.createElement('style');
      style.textContent = '@keyframes lbpulse{from{opacity:.3;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}#lb-motion{animation:lbpulse 700ms ease-in-out infinite alternate}.lb-sticky{position:sticky;top:0}';
      document.head.append(style);
      const animated = document.createElement('div'); animated.id = 'lb-motion'; animated.textContent = 'Motion fixture'; document.body.prepend(animated);
      const sticky = document.createElement('div'); sticky.className = 'lb-sticky'; sticky.textContent = 'Sticky fixture'; document.body.prepend(sticky);
      animated.animate([{filter:'brightness(.6)'},{filter:'brightness(1)'}],{duration:850,iterations:Infinity,direction:'alternate'});
      const canvas = document.createElement('canvas'); canvas.width=64; canvas.height=32; document.body.append(canvas); const context=canvas.getContext('2d'); context.fillStyle='#0cf'; context.fillRect(0,0,64,32);
    })()`, true);
    const motionInspection = await controller.inspectMotion(first.session.sessionId, first.tab.tabId, 100) as {
      capabilities?: { screencast?: boolean }; viewport?: { width?: number; height?: number };
      animations?: Array<{ source?: string }>; stickyCandidates?: unknown[];
    };
    if (motionInspection.viewport?.width !== 1920 || motionInspection.viewport.height !== 1080 || !motionInspection.capabilities?.screencast ||
        !motionInspection.animations?.some((item) => item.source === "document-getAnimations") || (motionInspection.stickyCandidates?.length ?? 0) === 0) {
      throw new Error(`web.motion.inspect no detectó el viewport o screencast: ${JSON.stringify(motionInspection)}`);
    }
    const webMotion = await controller.captureMotion(
      first.session.sessionId, first.tab.tabId, "ws_evidence", "evidence/reference-scroll.lbmotion",
      { axis: "y", startY: 0, distancePx: 500, durationMs: 500, sampleCount: 3 }, 0, "auto", "motion_web_1",
    );
    const webMotionReplay = await controller.captureMotion(
      first.session.sessionId, first.tab.tabId, "ws_evidence", "evidence/reference-scroll.lbmotion",
      { axis: "y", startY: 0, distancePx: 500, durationMs: 500, sampleCount: 3 }, 0, "auto", "motion_web_1",
    );
    if (savedMotionBundles !== 1 || webMotion.frameCount !== 3 || webMotion.width !== 1920 || webMotion.height !== 1080 ||
        JSON.stringify(webMotionReplay) !== JSON.stringify(webMotion)) {
      throw new Error(`web.motion.capture no produjo evidencia temporal idempotente: ${JSON.stringify(webMotion)}`);
    }
    await controller.setViewport(first.session.sessionId, first.tab.tabId, 3840, 2160, false, "viewport_motion_4k");
    const maximumMotion = await controller.captureMotion(
      first.session.sessionId, first.tab.tabId, "ws_evidence", "evidence/reference-scroll-4k.lbmotion",
      { axis: "y", startY: 0, distancePx: 240, durationMs: 250, sampleCount: 24 }, 0, "stepped", "motion_web_4k_24",
    );
    if (savedMotionBundles !== 2 || maximumMotion.frameCount !== 24 || maximumMotion.width !== 3840 || maximumMotion.height !== 2160) {
      throw new Error(`web.motion.capture no cubrió 4K con 24 muestras: ${JSON.stringify(maximumMotion)}`);
    }
    await controller.setViewport(first.session.sessionId, first.tab.tabId, 1920, 1080, false, "viewport_after_motion_4k");
    await controller.scroll(first.session.sessionId, first.tab.tabId, "up", 500, "motion_reset_scroll");
    const savedCapture = await controller.saveScreenshot(first.session.sessionId, first.tab.tabId, "ws_evidence", "evidence/reference.png", "save_reference");
    const savedCaptureReplay = await controller.saveScreenshot(first.session.sessionId, first.tab.tabId, "ws_evidence", "evidence/reference.png", "save_reference");
    if (savedEvidence.length !== 1 || savedCapture.mimeType !== "image/png" || savedCapture.fallbackUsed ||
        savedEvidence[0]?.mimeType !== "image/png" || savedEvidence[0]?.path !== "evidence/reference.png" ||
        !savedEvidence[0]?.bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) ||
        JSON.stringify(savedCaptureReplay) !== JSON.stringify(savedCapture)) {
      throw new Error("web.screenshot.save no conservó PNG sin pérdida o no fue idempotente");
    }
    if (captureDiagnostics.some((event) => Object.keys(event).some((key) => /data|content|url/i.test(key)))) {
      throw new Error("la telemetría de captura incluyó contenido o URL");
    }
    let deterministicSaveErrorPreserved = false;
    try {
      await controller.saveScreenshot(first.session.sessionId, first.tab.tabId, "ws_evidence", "evidence/too-large.png", "save_too_large");
    } catch (error) {
      deterministicSaveErrorPreserved = error instanceof Error && "code" in error && error.code === "FILE_TOO_LARGE";
    }
    if (!deterministicSaveErrorPreserved) throw new Error("web.screenshot.save enmascaró un rechazo determinista");
    const clickSnapshot = await controller.snapshot(first.session.sessionId, first.tab.tabId, 12, 100);
    const directFileRef = clickSnapshot.nodes.find((node) => node.name === "Archivo directo")?.elementRef;
    const indirectFileRef = clickSnapshot.nodes.find((node) => node.name === "Archivo indirecto")?.elementRef;
    const nativeDownloadRef = clickSnapshot.nodes.find((node) => node.name === "Descarga nativa")?.elementRef;
    if (directFileRef === undefined || indirectFileRef === undefined || nativeDownloadRef === undefined) throw new Error("snapshot no produjo referencias para archivos y descarga");
    let directHumanRequired = false;
    try { await controller.click(first.session.sessionId, first.tab.tabId, clickSnapshot.snapshotId, directFileRef, "file_direct"); }
    catch (error) { directHumanRequired = error instanceof Error && "code" in error && error.code === "HUMAN_ACTION_REQUIRED"; }
    if (!directHumanRequired) throw new Error("el input de archivo directo no exigió control humano");
    const nativeDownload = await controller.click(first.session.sessionId, first.tab.tabId, clickSnapshot.snapshotId, nativeDownloadRef, "native_download");
    if (nativeDownload.applied || nativeDownload.effect !== "native_download_blocked") throw new Error("la descarga nativa se reportó como aplicada");
    const onceRef = clickSnapshot.nodes.find((node) => node.name === "Ejecutar una vez")?.elementRef;
    if (onceRef === undefined) throw new Error("snapshot no produjo referencia para el botón");
    const firstClick = await controller.click(first.session.sessionId, first.tab.tabId, clickSnapshot.snapshotId, onceRef, "click_once");
    const repeatedClick = await controller.click(first.session.sessionId, first.tab.tabId, clickSnapshot.snapshotId, onceRef, "click_once");
    const onceCount = await firstManagedTab.content.webContents.executeJavaScript("globalThis.__once", true) as number;
    if (JSON.stringify(firstClick) !== JSON.stringify(repeatedClick) || onceCount !== 1) {
      throw new Error("el reintento de clic repitió el efecto");
    }

    const indirectSnapshot = await controller.snapshot(first.session.sessionId, first.tab.tabId, 12, 100);
    const currentIndirectFileRef = indirectSnapshot.nodes.find((node) => node.name === "Archivo indirecto")?.elementRef;
    if (currentIndirectFileRef === undefined) throw new Error("snapshot no produjo la referencia indirecta");
    let indirectHumanRequired = false;
    try { await controller.click(first.session.sessionId, first.tab.tabId, indirectSnapshot.snapshotId, currentIndirectFileRef, "file_indirect"); }
    catch (error) { indirectHumanRequired = error instanceof Error && "code" in error && error.code === "HUMAN_ACTION_REQUIRED"; }
    if (!indirectHumanRequired) throw new Error("la activación indirecta de archivo no exigió control humano");

    const delayedSnapshot = await controller.snapshot(first.session.sessionId, first.tab.tabId, 12, 100);
    const delayedFileRef = delayedSnapshot.nodes.find((node) => node.name === "Archivo tardío")?.elementRef;
    if (delayedFileRef === undefined) throw new Error("snapshot no produjo la referencia tardía");
    const blockedBefore = (await controller.tabs(first.session.sessionId))[0]?.blockedFileChoosers ?? 0;
    const delayedClick = await controller.click(first.session.sessionId, first.tab.tabId, delayedSnapshot.snapshotId, delayedFileRef, "file_delayed");
    if (delayedClick.effect !== "effect_pending") throw new Error("un clic sin efecto observado se reportó como definitivo");
    await new Promise((resolve) => setTimeout(resolve, 400));
    const blockedAfter = (await controller.tabs(first.session.sessionId))[0]?.blockedFileChoosers ?? 0;
    if (blockedAfter <= blockedBefore) throw new Error("el selector tardío bloqueado no quedó observable en web.tabs");

    const uncertainSnapshot = await controller.snapshot(first.session.sessionId, first.tab.tabId, 12, 100);
    const uncertainRef = uncertainSnapshot.nodes.find((node) => node.name === "Efecto incierto")?.elementRef;
    if (uncertainRef === undefined) throw new Error("snapshot no produjo referencia para el caso incierto");
    const debuggerApi = firstManagedTab.content.webContents.debugger;
    const originalSendCommand = debuggerApi.sendCommand.bind(debuggerApi);
    let loseReply = true;
    debuggerApi.sendCommand = (async (...args: Parameters<typeof debuggerApi.sendCommand>) => {
      const result = await originalSendCommand(...args);
      const declaration = String((args[1] as { functionDeclaration?: unknown } | undefined)?.functionDeclaration ?? "");
      if (loseReply && args[0] === "Runtime.callFunctionOn" && declaration.includes("this.click()")) {
        loseReply = false;
        throw new Error("respuesta de efecto perdida por fixture");
      }
      return result;
    }) as typeof debuggerApi.sendCommand;
    let uncertainReported = false;
    try {
      await controller.click(first.session.sessionId, first.tab.tabId, uncertainSnapshot.snapshotId, uncertainRef, "click_uncertain");
    } catch (error) {
      uncertainReported = error instanceof Error && "code" in error && error.code === "WEB_EFFECT_UNCERTAIN";
    } finally {
      debuggerApi.sendCommand = originalSendCommand;
    }
    if (!uncertainReported) throw new Error("un clic con respuesta perdida no informó incertidumbre");
    let uncertainRetryBlocked = false;
    try {
      await controller.click(first.session.sessionId, first.tab.tabId, uncertainSnapshot.snapshotId, uncertainRef, "click_uncertain");
    } catch (error) {
      uncertainRetryBlocked = error instanceof Error && "code" in error && error.code === "WEB_EFFECT_UNCERTAIN";
    }
    const uncertainCount = await firstManagedTab.content.webContents.executeJavaScript("globalThis.__uncertain", true) as number;
    if (!uncertainRetryBlocked || uncertainCount !== 1) throw new Error("se repitió un efecto web incierto");

    const secondTab = await internals.createTab(entry);
    await secondTab.content.webContents.executeJavaScript("document.body.innerHTML = '<button>Segunda pestaña</button>'", true);
    const secondSnapshot = await controller.snapshot(first.session.sessionId, secondTab.tabId, 12, 100);
    const secondRef = secondSnapshot.nodes.find((node) => node.name === "Segunda pestaña")?.elementRef;
    if (secondRef === undefined || (await controller.tabs(first.session.sessionId)).length !== 2) {
      throw new Error("las pestañas web no conservaron estado independiente");
    }
    let crossTabRefBlocked = false;
    try {
      await controller.click(first.session.sessionId, first.tab.tabId, secondSnapshot.snapshotId, secondRef, "cross_tab");
    } catch (error) {
      crossTabRefBlocked = error instanceof Error && "code" in error && error.code === "STALE_SNAPSHOT";
    }
    if (!crossTabRefBlocked) throw new Error("una referencia cruzó entre pestañas");
    await controller.showLiveViewerLocally(first.session.sessionId, "follow", workArea);
    if (controller.getLocalLiveViewerState().tabId !== secondTab.tabId) {
      throw new Error("seguir actividad no eligió la última pestaña administrada");
    }
    await controller.scroll(first.session.sessionId, first.tab.tabId, "down", 1, "follow_first_tab");
    const followDeadline = Date.now() + 2_000;
    while (controller.getLocalLiveViewerState().tabId !== first.tab.tabId && Date.now() < followDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    if (controller.getLocalLiveViewerState().tabId !== first.tab.tabId) throw new Error("seguir actividad no cambió a la pestaña usada");
    const firstDebugger = firstManagedTab.content.webContents.debugger;
    const originalFirstCommand = firstDebugger.sendCommand.bind(firstDebugger);
    let signalSlowScrollStarted!: () => void;
    const slowScrollStarted = new Promise<void>((resolve) => { signalSlowScrollStarted = resolve; });
    let releaseSlowScroll!: () => void;
    const slowScrollReply = new Promise<void>((resolve) => { releaseSlowScroll = resolve; });
    firstDebugger.sendCommand = (async (...args: Parameters<typeof firstDebugger.sendCommand>) => {
      const result = await originalFirstCommand(...args);
      const expression = String((args[1] as { expression?: unknown } | undefined)?.expression ?? "");
      if (args[0] === "Runtime.evaluate" && expression.includes("globalThis.scrollBy")) {
        signalSlowScrollStarted();
        await slowScrollReply;
      }
      return result;
    }) as typeof firstDebugger.sendCommand;
    const slowFirstAction = controller.scroll(first.session.sessionId, first.tab.tabId, "down", 1, "concurrent_first");
    await Promise.race([
      slowScrollStarted,
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error("no comenzó la acción concurrente lenta")), 2_000);
      }),
    ]);
    await controller.scroll(first.session.sessionId, secondTab.tabId, "down", 1, "concurrent_second");
    releaseSlowScroll();
    await slowFirstAction;
    firstDebugger.sendCommand = originalFirstCommand;
    const concurrentViewerDeadline = Date.now() + 2_000;
    while (controller.getLocalLiveViewerState().tabId !== secondTab.tabId && Date.now() < concurrentViewerDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    if (controller.getLocalLiveViewerState().tabId !== secondTab.tabId) {
      throw new Error("una respuesta tardía sustituyó la última acción admitida");
    }
    await controller.showLiveViewerLocally(first.session.sessionId, "pinned", workArea, secondTab.tabId);
    await controller.scroll(first.session.sessionId, first.tab.tabId, "down", 1, "pinned_first_tab");
    if (controller.getLocalLiveViewerState().tabId !== secondTab.tabId || controller.getLocalLiveViewerState().mode !== "pinned") {
      throw new Error("una acción del agente sustituyó la pestaña fijada");
    }
    const closed = await controller.closeTab(first.session.sessionId, secondTab.tabId, "close_second");
    const closedAgain = await controller.closeTab(first.session.sessionId, secondTab.tabId, "close_second");
    if (closed.state !== "closed" || closedAgain.state !== "closed" || (await controller.tabs(first.session.sessionId)).length !== 1) {
      throw new Error("cerrar pestaña no fue idempotente o afectó otra pestaña");
    }
    if (controller.getLocalLiveViewerState().visible) throw new Error("cerrar una pestaña fijada mostró otra página");
    stage("follow-pin-verified");

    profile = {
      ...profile,
      name: "Public changed",
      limits: { ...profile.limits, transferPolicy: { mode: 'adaptive' } },
      updatedAt: "2026-09-05T00:01:00.000Z",
    };
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (controller.listAll().find((item) => item.sessionId === first.session.sessionId)?.state !== "running") {
      throw new Error("un cambio de consumo o presentación cerró la sesión");
    }
    profile = {
      ...profile,
      permissions: { ...profile.permissions, interact: false },
      updatedAt: "2026-09-05T00:01:01.000Z",
    };
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (controller.listAll().find((item) => item.sessionId === first.session.sessionId)?.state !== "stopped") {
      throw new Error("un cambio real de autoridad no cerró la sesión");
    }
    if (controller.listAll().find((item) => item.sessionId === first.session.sessionId)?.closeReason !== "policy") {
      throw new Error("un cambio de autoridad no registró su causa de cierre");
    }

    profile = {
      ...buildSiteAccountProfile({ name: "Account test", destinations: ["example.com"] }, new Date("2026-09-05T00:02:00.000Z")),
      enabled: true,
      permissions: { read: true, interact: true, download: true, humanControl: true },
    };
    const humanSession = await controller.start(profile.id, "start_2");
    stage("human-session-started");
    const humanEntry = internals.entries.get(humanSession.session.sessionId);
    const humanTab = humanEntry?.tabs.get(humanSession.tab.tabId);
    if (humanEntry === undefined || humanTab === undefined) throw new Error("no se recuperó la sesión humana");
    const humanContentsId = humanTab.content.webContents.id;
    await controller.setViewport(humanSession.session.sessionId, humanSession.tab.tabId, 1440, 900, false, "human_viewport");
    await controller.showLiveViewerLocally(humanSession.session.sessionId, "follow", workArea);
    stage("human-viewer-shown");
    if (!controller.getLocalLiveViewerState().visible) throw new Error("no se abrió la vista previa al handoff");
    await humanTab.content.webContents.executeJavaScript("setTimeout(() => { document.body.textContent = 'operación drenada'; }, 50)", true);
    stage("human-fixture-ready");
    const pendingObservation = controller.wait(humanSession.session.sessionId, humanSession.tab.tabId, {
      kind: "text", value: "operación drenada", state: "present",
    }, 1_000);
    while (humanEntry.activeAgentOperations === 0) await new Promise((resolve) => setTimeout(resolve, 5));
    const requested = await controller.requestHumanControl(humanSession.session.sessionId, "manual_step", "human_1");
    stage("human-requested");
    if (requested.state !== "waiting_for_human") throw new Error("handoff no quedó pendiente");
    if (controller.getLocalLiveViewerState().visible) throw new Error("el handoff dejó visible la página");
    if (!(await pendingObservation).satisfied || humanEntry.activeAgentOperations !== 0) {
      throw new Error("handoff no drenó operaciones del agente");
    }
    const repeatedRequest = await controller.requestHumanControl(humanSession.session.sessionId, "manual_step", "human_1");
    if (repeatedRequest.requestId !== requested.requestId) throw new Error("solicitud humana no fue idempotente");
    let agentExcluded = false;
    try { await controller.tabs(humanSession.session.sessionId); }
    catch (error) { agentExcluded = error instanceof Error && "code" in error && error.code === "HUMAN_CONTROL_ACTIVE"; }
    if (!agentExcluded) throw new Error("el agente listó pestañas durante handoff");
    await controller.takeHumanControlLocally(humanSession.session.sessionId);
    stage("human-control-taken");
    if (!humanTab.window.isVisible() || !humanTab.window.isFocusable() || !humanTab.window.webContents.getTitle().includes("Intervención web privada")) {
      throw new Error("el control humano no presentó la misma página con identificación privada");
    }
    try { await controller.extract(humanSession.session.sessionId, humanSession.tab.tabId, 1_000); agentExcluded = false; }
    catch (error) { agentExcluded = error instanceof Error && "code" in error && error.code === "HUMAN_CONTROL_ACTIVE"; }
    if (!agentExcluded) throw new Error("el agente observó durante control humano real");
    await controller.completeHumanControlLocally(humanSession.session.sessionId);
    stage("human-control-returned");
    if ((await controller.humanControlStatus(humanSession.session.sessionId)).state !== "ready") {
      throw new Error("la devolución humana no restauró al agente");
    }
    if (controller.getLocalLiveViewerState().visible || humanTab.window.isFocusable() || humanTab.content.webContents.id !== humanContentsId) {
      throw new Error("la devolución reabrió el visor, dejó entrada humana o sustituyó la página");
    }
    const restoredCapture = await controller.screenshot(humanSession.session.sessionId, humanSession.tab.tabId);
    if (restoredCapture.width !== 1440 || restoredCapture.height !== 900 ||
        humanTab.currentViewport.width !== 1440 || humanTab.currentViewport.height !== 900) {
      throw new Error("la devolución humana no restauró el viewport lógico elegido");
    }
    stage("human-return-screenshot-verified");
    await controller.requestHumanControl(humanSession.session.sessionId, "manual_step", "human_2");
    await controller.takeHumanControlLocally(humanSession.session.sessionId);
    await controller.declineHumanControlLocally(humanSession.session.sessionId);
    if ((await controller.humanControlStatus(humanSession.session.sessionId)).state !== "declined" ||
        controller.listAll().find((item) => item.sessionId === humanSession.session.sessionId)?.closeReason !== "user") {
      throw new Error("la cancelación local no fue visible");
    }
    await controller.stop(humanSession.session.sessionId, "stop_1");

    const failedReturn = await controller.start(profile.id, "start_failed_return");
    await controller.requestHumanControl(failedReturn.session.sessionId, "manual_step", "failed_return_request");
    await controller.takeHumanControlLocally(failedReturn.session.sessionId);
    const originalInstallDebugger = internals.installDebugger.bind(controller);
    internals.installDebugger = async () => { throw new Error("fixture debugger restore failure"); };
    let failedReturnClosed = false;
    try {
      await controller.completeHumanControlLocally(failedReturn.session.sessionId);
    } catch (error) {
      failedReturnClosed = error instanceof Error && "code" in error && error.code === "WEB_SESSION_NOT_FOUND";
    } finally {
      internals.installDebugger = originalInstallDebugger;
    }
    const failedReturnSummary = controller.listAll().find((item) => item.sessionId === failedReturn.session.sessionId);
    if (!failedReturnClosed || failedReturnSummary?.state !== "stopped" || failedReturnSummary.closeReason !== "failed") {
      throw new Error("un fallo al devolver control dejó una sesión parcialmente observable");
    }

    profile = {
      ...buildPublicResearchProfile(new Date("2026-09-05T00:03:00.000Z"), "Public handoff"),
      enabled: true,
      permissions: { read: true, interact: true, download: false, humanControl: false },
    };
    const publicHuman = await controller.start(profile.id, "public_human_start");
    const publicEntry = internals.entries.get(publicHuman.session.sessionId);
    const publicTab = publicEntry?.tabs.get(publicHuman.tab.tabId);
    if (publicEntry === undefined || publicTab === undefined) throw new Error("no se recuperó la sesión pública para control local");
    const publicContentsId = publicTab.content.webContents.id;
    await controller.takeHumanControlLocally(publicHuman.session.sessionId, publicHuman.tab.tabId);
    if ((await controller.humanControlStatus(publicHuman.session.sessionId)).state !== "human_control") {
      throw new Error("la toma pública local exigió una solicitud MCP previa");
    }
    const additionalHumanTab = await internals.createTab(publicEntry, undefined, true);
    if (!additionalHumanTab.window.isVisible() || publicTab.window.isVisible()) {
      throw new Error("la pestaña humana adicional mostró más de una ventana interactiva");
    }
    await controller.cycleHumanTabLocally(publicHuman.session.sessionId, "previous");
    if (!publicTab.window.isVisible() || additionalHumanTab.window.isVisible()) {
      throw new Error("el selector humano no alternó una sola pestaña visible");
    }
    const publicContents = publicTab.content.webContents as unknown as {
      getURL: () => string;
      loadURL: (url: string) => Promise<void>;
    };
    const originalPublicGetUrl = publicContents.getURL.bind(publicContents);
    const originalPublicLoadUrl = publicContents.loadURL.bind(publicContents);
    let virtualPublicUrl = "https://account.example/private?token=secret#fragment";
    let delegatedReloadUrl: string | undefined;
    publicContents.getURL = () => virtualPublicUrl;
    publicContents.loadURL = async (url) => {
      delegatedReloadUrl = url;
      virtualPublicUrl = url;
      await originalPublicLoadUrl("about:blank");
    };
    try {
      await controller.completeHumanControlLocally(publicHuman.session.sessionId);
    } finally {
      publicContents.getURL = originalPublicGetUrl;
      publicContents.loadURL = originalPublicLoadUrl;
    }
    const delegated = controller.listAll().find((item) => item.sessionId === publicHuman.session.sessionId);
    if (delegated?.controlState !== "agent_control" || delegated.delegatedSite !== "account.example" ||
        delegated.delegatedExpiresAt === undefined || delegated.tabCount !== 1 || !additionalHumanTab.window.isDestroyed() ||
        publicTab.content.webContents.id !== publicContentsId) {
      throw new Error("la devolución pública no quedó limitada a una pestaña, hostname y caducidad");
    }
    if (delegatedReloadUrl !== "https://account.example/private?token=secret") {
      throw new Error("la devolución pública no recargó el contenido bajo la autoridad exacta");
    }
    const delegatedTabs = await controller.tabs(publicHuman.session.sessionId);
    if (delegatedTabs[0]?.url.includes("token=secret") || delegatedTabs[0]?.url.includes("#fragment")) {
      throw new Error("la sesión delegada expuso consulta o fragmento privado");
    }
    let crossSiteAfterHandoffBlocked = false;
    try {
      await controller.navigate(publicHuman.session.sessionId, publicHuman.tab.tabId, "https://other.example/", "delegated_cross_site");
    } catch (error) {
      crossSiteAfterHandoffBlocked = error instanceof Error && "code" in error && error.code === "WEB_DESTINATION_BLOCKED";
    }
    if (!crossSiteAfterHandoffBlocked) throw new Error("la concesión pública permitió navegar a otro hostname");
    publicEntry.delegatedExpiresAt = Date.now() - 1;
    let delegatedExpiryClosed = false;
    try { await controller.tabs(publicHuman.session.sessionId); }
    catch (error) { delegatedExpiryClosed = error instanceof Error && "code" in error && error.code === "HUMAN_CONTROL_EXPIRED"; }
    if (!delegatedExpiryClosed || controller.listAll().find((item) => item.sessionId === publicHuman.session.sessionId)?.state !== "stopped") {
      throw new Error("la concesión pública no caducó con cierre fail-closed");
    }
    if (controller.listAll().find((item) => item.sessionId === publicHuman.session.sessionId)?.closeReason !== "expired") {
      throw new Error("la concesión caducada no registró su causa de cierre");
    }

    process.stdout.write(`${JSON.stringify({
      electronWebController: true,
      defaultWebViewport1920x1080: true,
      customWebViewport: true,
      viewportRestoredAfterHuman: true,
      webVideoScreenshotThreeRuns: true,
      largeWebCaptureTransportFallback: true,
      signedAssetUrlRedacted: true,
      delayedEffectsObservable: true,
      staleViewportReceiptRejected: true,
      fileSelectionIntercepted: true,
      nativeDownloadReceipt: true,
      safeCaptureDiagnostics: true,
      losslessEvidenceSaved: true,
      motionInspectAndCapture: true,
      maximumWebMotion4k24Samples: true,
      fullLogicalViewportFittedInViewer: true,
      deterministicSaveErrorPreserved: true,
      publicReadOnlyLiveViewer: true,
      trustedLocalToolbar: true,
      viewerTabContext: true,
      remoteFullscreenBlocked: true,
      passiveCloseOnlyHides: true,
      stableWebContentsIdentity: true,
      repeatedViewerCycles: 50,
      followAndPinnedModes: true,
      concurrentFollowUsesLatestStart: true,
      privateHandoffClosesViewer: true,
      noAutomaticViewerRestore: true,
      failedReturnClosesSession: true,
      failedReturnReportsReason: true,
      ephemeralSession: true,
      idempotentStart: true,
      privateDestinationBlocked: true,
      browserIdsSeparated: true,
      tabReferencesSeparated: true,
      idempotentEffects: true,
      uncertainEffectsNotRepeated: true,
      profileRevisionRevoked: true,
      humanControlExclusive: true,
      handoffDrainsAgentOperations: true,
      humanReturnRestoredAgent: true,
      publicDirectHumanControl: true,
      humanTabSelectorPrivate: true,
      delegatedExactHostname: true,
      delegatedContentReloaded: true,
      delegatedPrivateUrlRedacted: true,
      delegatedOtherTabsDestroyed: true,
      delegatedExpiryClosesSession: true,
      closeReasonsHonest: true,
      quicDisabled: true,
      profileRevision: webProfileRevision(profile),
    })}\n`);
  } finally {
    await controller.close();
    app.quit();
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  app.exit(1);
});
