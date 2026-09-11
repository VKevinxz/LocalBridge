import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { app } from 'electron';

import { buildPublicResearchProfile, type WebProfile } from '@localbridge/desktop-core';
import { ProcessSupervisor } from '@localbridge/development';
import type { AuthorizedWorkspace } from '@localbridge/workspace';

import { BrowserController } from '../apps/desktop/src/main/browser-controller.js';
import { LiveViewerCoordinator } from '../apps/desktop/src/main/live-viewer-coordinator.js';
import { WebController } from '../apps/desktop/src/main/web-controller.js';
import { HumanControlCoordinator } from '../apps/desktop/src/main/human-control-coordinator.js';

app.on('window-all-closed', () => { /* el navegador gestionado es deliberadamente invisible */ });

for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (error: NodeJS.ErrnoException) => {
    // Un verificador Electron puede finalizar después del shell que capturaba su salida.
    // EPIPE solo significa que el canal diagnóstico ya cerró; no debe abrir un diálogo.
    if (error.code !== 'EPIPE') throw error;
  });
}

const port = 47_840;
const helperPath = process.env['LOCALBRIDGE_PROCESS_HELPER_BINARY'] ?? path.resolve('vendor/process-host/localbridge-process-host.exe');
const nodeBinaryPath = process.env['LOCALBRIDGE_PROCESS_NODE_BINARY'] ?? path.resolve('vendor/node/node.exe');
const viteCliPath = process.env['LOCALBRIDGE_VITE_CLI'] ?? path.resolve('apps/desktop/node_modules/vite/bin/vite.js');
const definition = `node ${JSON.stringify(viteCliPath)} --host 127.0.0.1 --port ${port} --strictPort`;
const source = (version: number): string =>
  `console.log('LOCALBRIDGE_HMR_VERSION_${version}');\nif (import.meta.hot) import.meta.hot.accept();\n// ${'changed-'.repeat(version)}\n`;
const stage = (message: string): void => { process.stderr.write(`[electron-vite-test] ${message}\n`); };

function workspace(rootPath: string): AuthorizedWorkspace {
  return {
    id: 'ws_electron_process',
    name: 'Electron process',
    rootPath,
    enabled: true,
    createdAt: new Date().toISOString(),
    permissions: {
      read: true,
      write: false,
      overwrite: false,
      gitRead: false,
      validations: false,
      gitWrite: false,
      processes: true,
      browserRead: true,
      browserInteract: false,
      browserHumanControl: true,
    },
    limits: { maxFileBytes: 1024, maxTreeEntries: 30, maxTreeDepth: 2 },
    denyPatterns: ['.env'],
    validationProfiles: {},
    processProfiles: {
      dev: {
        command: ['npm', 'run', 'dev'],
        cwd: '.',
        source: {
          kind: 'package-script',
          manifestPath: 'package.json',
          script: 'dev',
          definitionSha256: createHash('sha256').update(JSON.stringify(definition)).digest('hex'),
        },
        maxRuntimeSeconds: 60,
      },
    },
    browserProfiles: {},
    automationReviewRequired: false,
  };
}

async function waitForListener(supervisor: ProcessSupervisor, workspaceId: string, processId: string) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const listeners = (await supervisor.listeners(workspaceId, processId)).listeners;
    if (listeners.length > 0) return listeners;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Electron runtime did not start a verified listener with bundled Node');
}

async function waitForConsole(
  controller: BrowserController,
  workspaceId: string,
  sessionId: string,
  message: string,
): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const events = await controller.events(workspaceId, sessionId, 0, 65_536);
    if (events.events.some((entry) => entry.type === 'console' && entry.message.includes(message))) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const diagnostic = await controller.events(workspaceId, sessionId, 0, 65_536);
  stage(`browser-events:${JSON.stringify(diagnostic.events)}`);
  throw new Error(`Electron browser did not observe ${message}`);
}

async function main(): Promise<void> {
  await app.whenReady();
  stage('electron-ready');
  const rootPath = await mkdtemp(path.join(os.tmpdir(), 'localbridge-electron-process-'));
  await writeFile(path.join(rootPath, 'package.json'), JSON.stringify({ scripts: { dev: definition } }));
  await writeFile(path.join(rootPath, 'index.html'), '<!doctype html><script type="module" src="/src.js"></script>');
  await writeFile(path.join(rootPath, 'src.js'), source(1));
  const authorizedWorkspace = workspace(rootPath);
  const supervisor = new ProcessSupervisor({
    helperPath,
    nodeBinaryPath,
    parentPid: process.pid,
    loadWorkspace: async (workspaceId) => workspaceId === authorizedWorkspace.id ? authorizedWorkspace : undefined,
  });
  const humanControlCoordinator = new HumanControlCoordinator();
  const controller = new BrowserController({
    loadWorkspace: async (workspaceId) => workspaceId === authorizedWorkspace.id ? authorizedWorkspace : undefined,
    resolveProcessListener: async (workspaceId, processId, listenerRef) => {
      try {
        return await supervisor.resolveListener(workspaceId, processId, listenerRef);
      } catch (error) {
        stage(`listener-resolution-failed:${error instanceof Error && 'code' in error ? String(error.code) : 'unknown'}`);
        throw error;
      }
    },
    reserveHumanControl: (sessionId) => humanControlCoordinator.reserve({ kind: 'development', sessionId }),
    releaseHumanControl: (sessionId) => humanControlCoordinator.release({ kind: 'development', sessionId }),
    confirmHumanControlHandoff: async () => true,
  });
  const webProfile: WebProfile = {
    ...buildPublicResearchProfile(new Date('2026-09-06T00:00:00.000Z'), 'Coexistence fixture'),
    enabled: true,
  };
  const webController = new WebController({
    loadProfile: async (id) => id === webProfile.id ? webProfile : undefined,
    listProfiles: async () => [webProfile],
    reconciliationIntervalMs: 50,
    reserveHumanControl: (sessionId) => humanControlCoordinator.reserve({ kind: 'web', sessionId }),
    releaseHumanControl: (sessionId) => humanControlCoordinator.release({ kind: 'web', sessionId }),
  });
  const viewerCoordinator = new LiveViewerCoordinator({
    hideDevelopment: (sessionId) => controller.hideLiveViewerLocally(sessionId),
    hideWeb: (sessionId) => webController.hideLiveViewerLocally(sessionId),
    hasHumanControl: () => humanControlCoordinator.current() !== undefined,
  });
  try {
    const web = await webController.start(webProfile.id, 'coexistence_web_start_1');
    stage('external-web-started');
    const started = await supervisor.start(authorizedWorkspace.id, 'dev', 'electron_process_start');
    stage(`process-started:${started.state}`);
    const listeners = await waitForListener(supervisor, authorizedWorkspace.id, started.processId);
    stage(`listeners-ready:${listeners.length}`);
    if (listeners.length !== 1 || listeners[0]?.origin !== `http://127.0.0.1:${port}`) {
      throw new Error(`unexpected listeners: ${JSON.stringify(listeners)}`);
    }
    const listener = await supervisor.resolveListener(
      authorizedWorkspace.id,
      started.processId,
      listeners[0]!.listenerRef,
    );
    const browser = await controller.startFromProcess(
      authorizedWorkspace.id,
      listener,
      'electron_vite_browser_start',
    ).catch(async (error: unknown) => {
      const current = (await supervisor.list(authorizedWorkspace.id)).find((entry) => entry.processId === started.processId);
      stage(`process-after-browser-failure:${current?.state ?? 'missing'}:${current?.exitCode ?? 'none'}`);
      const logs = await supervisor.logs(authorizedWorkspace.id, started.processId, 0, 65_536);
      for (const entry of logs.entries) {
        stage(`process-log:${entry.text.replaceAll(rootPath, '<temp>').replaceAll(viteCliPath, '<vite>').trim()}`);
      }
      throw error;
    });
    stage('browser-started');
    const viewerArea = { x: 0, y: 0, width: 1920, height: 1080 };
    await viewerCoordinator.show(
      { kind: 'development', sessionId: browser.sessionId },
      () => controller.showLiveViewerLocally(browser.sessionId, viewerArea),
    );
    if (controller.getLocalLiveViewerSessionId() !== browser.sessionId || webController.getLocalLiveViewerState().visible) {
      throw new Error('el coordinador no presentó exclusivamente desarrollo');
    }
    await viewerCoordinator.show(
      { kind: 'web', sessionId: web.session.sessionId },
      () => webController.showLiveViewerLocally(web.session.sessionId, 'follow', viewerArea),
    );
    if (controller.getLocalLiveViewerSessionId() !== undefined || !webController.getLocalLiveViewerState().visible) {
      throw new Error('el coordinador no alternó exclusivamente a investigación web');
    }
    await viewerCoordinator.show(
      { kind: 'development', sessionId: browser.sessionId },
      () => controller.showLiveViewerLocally(browser.sessionId, viewerArea),
    );
    if (controller.getLocalLiveViewerSessionId() !== browser.sessionId || webController.getLocalLiveViewerState().visible) {
      throw new Error('el coordinador no volvió exclusivamente a desarrollo');
    }
    await waitForConsole(controller, authorizedWorkspace.id, browser.sessionId, 'LOCALBRIDGE_HMR_VERSION_1');
    stage('hmr-version-1');
    await new Promise((resolve) => setTimeout(resolve, 750));
    await writeFile(path.join(rootPath, 'src.js'), source(2));
    await waitForConsole(controller, authorizedWorkspace.id, browser.sessionId, 'LOCALBRIDGE_HMR_VERSION_2');
    stage('hmr-version-2');
    const browserEvents = await controller.events(authorizedWorkspace.id, browser.sessionId, 0, 65_536);
    if (browserEvents.events.some((entry) => entry.message.toLowerCase().includes('failed to connect to websocket'))) {
      throw new Error(`Vite reported an HMR WebSocket failure: ${JSON.stringify(browserEvents.events)}`);
    }
    await controller.takeHumanControlLocally(browser.sessionId);
    let concurrentHumanControlBlocked = false;
    try { await webController.takeHumanControlLocally(web.session.sessionId); }
    catch (error) { concurrentHumanControlBlocked = error instanceof Error && 'code' in error && error.code === 'HUMAN_CONTROL_BUSY'; }
    if (!concurrentHumanControlBlocked || humanControlCoordinator.current()?.kind !== 'development') {
      throw new Error('la reserva humana global permitió una segunda intervención web');
    }
    await controller.completeHumanControlLocally(browser.sessionId);
    if (humanControlCoordinator.current() !== undefined) throw new Error('la devolución local no liberó la reserva humana global');
    await webController.stop(web.session.sessionId, 'coexistence_web_stop_1');
    const developmentStillRunning = (await supervisor.list(authorizedWorkspace.id)).some((entry) => entry.processId === started.processId && entry.state === 'running') &&
      (await controller.list(authorizedWorkspace.id)).some((entry) => entry.sessionId === browser.sessionId && entry.state === 'running');
    if (!developmentStillRunning) throw new Error('detener web externo terminó recursos de desarrollo');

    const secondWeb = await webController.start(webProfile.id, 'coexistence_web_start_2');
    await controller.stop(authorizedWorkspace.id, browser.sessionId);
    await supervisor.stop(authorizedWorkspace.id, started.processId);
    if (!(await webController.list()).some((entry) => entry.sessionId === secondWeb.session.sessionId && entry.state === 'running')) {
      throw new Error('detener desarrollo terminó la sesión web externa');
    }
    await webController.stop(secondWeb.session.sessionId, 'coexistence_web_stop_2');
    process.stdout.write(`${JSON.stringify({ electronExecPath: process.execPath, nodeBinaryPath, bundledNodeLauncher: true, npmProfileStarted: true, verifiedListener: true, viteHmrRoundTrip: true, externalWebSocketBlockedByPolicyTest: true, externalWebAndDevelopmentCoexist: true, exclusiveLiveViewerCoexistence: true, globalHumanControlExclusive: true, independentStopScopes: true })}\n`);
  } finally {
    await webController.close();
    await controller.close();
    await supervisor.close();
    await rm(rootPath, { recursive: true, force: true });
    app.quit();
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  app.exit(1);
});
