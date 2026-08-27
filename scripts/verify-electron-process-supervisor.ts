import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { app } from 'electron';

import { ProcessSupervisor } from '@localbridge/development';
import type { AuthorizedWorkspace } from '@localbridge/workspace';

import { BrowserController } from '../apps/desktop/src/main/browser-controller.js';

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
  });
  try {
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
    process.stdout.write(`${JSON.stringify({ electronExecPath: process.execPath, nodeBinaryPath, bundledNodeLauncher: true, npmProfileStarted: true, verifiedListener: true, viteHmrRoundTrip: true, externalWebSocketBlockedByPolicyTest: true })}\n`);
  } finally {
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
