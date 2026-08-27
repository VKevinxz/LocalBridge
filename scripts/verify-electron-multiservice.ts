import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { app } from 'electron';

import { ApplicationSupervisor, ProcessSupervisor } from '@localbridge/development';
import type { AuthorizedWorkspace, LocalApplication, WorkspaceRegistry } from '@localbridge/workspace';

import { BrowserController } from '../apps/desktop/src/main/browser-controller.js';

for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (error: NodeJS.ErrnoException) => {
    // Un verificador Electron puede finalizar después del shell que capturaba su salida.
    // EPIPE solo significa que el canal diagnóstico ya cerró; no debe abrir un diálogo.
    if (error.code !== 'EPIPE') throw error;
  });
}

const frontendPort = 47_841;
const apiPort = 47_842;
const workspaceRoot = path.basename(process.cwd()).toLowerCase() === 'desktop' && path.basename(path.dirname(process.cwd())).toLowerCase() === 'apps'
  ? path.resolve(process.cwd(), '..', '..')
  : process.cwd();
const helperPath = process.env['LOCALBRIDGE_PROCESS_HELPER_BINARY'] ?? path.join(workspaceRoot, 'apps/desktop/vendor/process-host/localbridge-process-host.exe');
const nodeBinaryPath = process.env['LOCALBRIDGE_PROCESS_NODE_BINARY'] ?? path.join(workspaceRoot, 'apps/desktop/vendor/node/node.exe');
const viteCliPath = process.env['LOCALBRIDGE_VITE_CLI'] ?? path.join(workspaceRoot, 'apps/desktop/node_modules/vite/bin/vite.js');
const frontendDefinition = `node ${JSON.stringify(viteCliPath)} --host localhost --port ${frontendPort} --strictPort`;
const apiDefinition = 'node api.cjs';
const stage = (message: string): void => { process.stderr.write(`[electron-multiservice-test] ${message}\n`); };
app.on('window-all-closed', () => { /* el navegador gestionado es deliberadamente invisible */ });

function processProfile(definition: string) {
  return {
    command: ['npm', 'run', 'dev'],
    cwd: '.' as const,
    source: {
      kind: 'package-script' as const,
      manifestPath: 'package.json' as const,
      script: 'dev',
      definitionSha256: createHash('sha256').update(JSON.stringify(definition)).digest('hex'),
    },
    maxRuntimeSeconds: 60,
  };
}

function permissions() {
  return {
    read: true,
    write: false,
    overwrite: false,
    gitRead: false,
    validations: false,
    gitWrite: false,
    processes: true,
    browserRead: true,
    browserInteract: false,
    browserHumanControl: false,
  };
}

function frontendWorkspace(rootPath: string): AuthorizedWorkspace {
  return {
    id: 'ws_multiservice_frontend',
    name: 'Multiservice frontend',
    rootPath,
    enabled: true,
    createdAt: new Date().toISOString(),
    permissions: permissions(),
    limits: { maxFileBytes: 1024, maxTreeEntries: 30, maxTreeDepth: 2 },
    denyPatterns: ['.env'],
    validationProfiles: {},
    processProfiles: { dev: processProfile(frontendDefinition) },
    browserProfiles: {},
    automationReviewRequired: false,
  };
}

function apiWorkspace(rootPath: string): AuthorizedWorkspace {
  return {
    id: 'ws_multiservice_api',
    name: 'Multiservice API',
    rootPath,
    enabled: true,
    createdAt: new Date().toISOString(),
    permissions: permissions(),
    limits: { maxFileBytes: 1024, maxTreeEntries: 30, maxTreeDepth: 2 },
    denyPatterns: ['.env'],
    validationProfiles: {},
    processProfiles: { dev: processProfile(apiDefinition) },
    browserProfiles: {},
    automationReviewRequired: false,
  };
}

function frontendSource(version: number): string {
  return `console.log('MULTISERVICE_FRONTEND_VERSION_${version}');\n` +
    `fetch('http://localhost:${apiPort}/login',{method:'POST',credentials:'include',headers:{'content-type':'application/x-www-form-urlencoded'},body:'credential=synthetic-electron-secret'})\n` +
    `.then((response)=>response.json()).then(()=>fetch('http://localhost:${apiPort}/session',{credentials:'include'}))\n` +
    `.then((response)=>response.json()).then((value)=>console.log(value.authenticated?'MULTISERVICE_LOGIN_OK':'MULTISERVICE_LOGIN_FAILED'))\n` +
    `.catch(()=>console.log('MULTISERVICE_LOGIN_FAILED'));\n` +
    `if(import.meta.hot)import.meta.hot.accept();\n// version-${version}\n`;
}

const apiSource = `const http=require('node:http');
const expectedOrigin='http://localhost:${frontendPort}';
const server=http.createServer((request,response)=>{
  const origin=String(request.headers.origin||'');
  const host=String(request.headers.host||'');
  response.setHeader('access-control-allow-origin',expectedOrigin);
  response.setHeader('access-control-allow-credentials','true');
  response.setHeader('content-type','application/json; charset=utf-8');
  if(request.url==='/login'&&request.method==='POST'){
    let body='';request.setEncoding('utf8');request.on('data',(chunk)=>{body+=chunk.slice(0,256)});request.on('end',()=>{
      if(origin!==expectedOrigin||host!=='localhost:${apiPort}'||body!=='credential=synthetic-electron-secret'){response.statusCode=400;response.end('{"ok":false}');return}
      console.log('API_MANUAL_ORIGIN_OK');console.log('API_MANUAL_HOST_OK');
      response.setHeader('set-cookie','localbridge_session=synthetic; Path=/; SameSite=Lax');response.end('{"ok":true}');
    });return;
  }
  if(request.url==='/session'){
    const authenticated=String(request.headers.cookie||'').includes('localbridge_session=synthetic');
    if(authenticated)console.log('API_CROSS_PORT_COOKIE_OK');
    response.end(JSON.stringify({authenticated}));return;
  }
  response.statusCode=404;response.end('{"error":"not-found"}');
});
server.listen(${apiPort},()=>console.log('API_WILDCARD_READY'));
`;

async function waitForApplication(supervisor: ApplicationSupervisor, runId: string) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const current = await supervisor.status(runId);
    if (current.state === 'ready') return current;
    if (current.state === 'failed' || current.state === 'failed_cleanup') throw new Error(`application failed: ${current.errorCode ?? current.state}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('application readiness timeout');
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
    if (events.events.some((event) => event.type === 'console' && event.message.includes(message))) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`browser console did not observe ${message}`);
}

async function main(): Promise<void> {
  await app.whenReady();
  const testRoot = await mkdtemp(path.join(os.tmpdir(), 'localbridge-electron-multiservice-'));
  const frontendRoot = path.join(testRoot, 'frontend');
  const apiRoot = path.join(testRoot, 'api');
  await Promise.all([mkdir(frontendRoot), mkdir(apiRoot)]);
  await Promise.all([
    writeFile(path.join(frontendRoot, 'package.json'), JSON.stringify({ scripts: { dev: frontendDefinition } })),
    writeFile(path.join(frontendRoot, 'index.html'), '<!doctype html><title>Multiservice</title><h1>Multiservice</h1><script type="module" src="/src.js"></script>'),
    writeFile(path.join(frontendRoot, 'src.js'), frontendSource(1)),
    writeFile(path.join(apiRoot, 'package.json'), JSON.stringify({ scripts: { dev: apiDefinition } })),
    writeFile(path.join(apiRoot, 'api.cjs'), apiSource),
  ]);
  const frontend = frontendWorkspace(frontendRoot);
  const api = apiWorkspace(apiRoot);
  const workspaces = new Map([[frontend.id, frontend], [api.id, api]]);
  let application: LocalApplication = {
    id: `app_${'a'.repeat(24)}`,
    name: 'System',
    description: 'Electron multiservice verifier',
    primaryServiceId: `service_${'f'.repeat(24)}`,
    services: [
      { id: `service_${'a'.repeat(24)}`, alias: 'api', workspaceId: api.id, processProfile: 'dev', startupOrder: 0, hostMode: 'manual-localhost', allowManagedWildcard: true },
      { id: `service_${'f'.repeat(24)}`, alias: 'frontend', workspaceId: frontend.id, processProfile: 'dev', startupOrder: 1, hostMode: 'manual-localhost', allowManagedWildcard: false },
    ],
    viewport: { width: 1000, height: 700 },
    reviewState: 'needs-review',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const registry = (): WorkspaceRegistry => ({ schemaVersion: 3, workspaces: [...workspaces.values()], applications: [application] });
  const supervisor = new ProcessSupervisor({
    helperPath,
    nodeBinaryPath,
    parentPid: process.pid,
    loadWorkspace: async (workspaceId) => workspaces.get(workspaceId),
  });
  const applications = new ApplicationSupervisor({ processes: supervisor, loadRegistry: async () => registry() });
  const controller = new BrowserController({
    loadWorkspace: async (workspaceId) => workspaces.get(workspaceId),
    loadApplication: async (applicationIdOrName) => applicationIdOrName === application.id || applicationIdOrName === application.name ? application : undefined,
    resolveProcessListener: (workspaceId, processId, listenerRef) => supervisor.resolveListener(workspaceId, processId, listenerRef),
  });
  try {
    const reviewStarted = await applications.startForLocalReview(application.id);
    const reviewReady = await waitForApplication(applications, reviewStarted.runId);
    const reviewResolved = await applications.resolveReadyRunForLocalReview(application.id, reviewReady.runId);
    const reviewBrowser = await controller.startApplicationForLocalReview(frontend.id, application, reviewResolved.services.map((service) => ({
      service: service.service, processId: service.processId, listenerRef: service.listenerRef,
    })));
    if ((await controller.list(frontend.id)).some((entry) => entry.sessionId === reviewBrowser.sessionId)) {
      throw new Error('local review browser leaked into the MCP-visible session list');
    }
    let reviewSessionRejected = false;
    try {
      await controller.events(frontend.id, reviewBrowser.sessionId, 0, 1024);
    } catch (error) {
      reviewSessionRejected = error instanceof Error && 'code' in error && error.code === 'SESSION_NOT_FOUND';
    }
    if (!reviewSessionRejected) throw new Error('local review browser accepted an agent operation');
    await controller.stopLocalReviewSession(reviewBrowser.sessionId);
    await applications.stop(reviewReady.runId);
    application = { ...application, reviewState: 'reviewed', updatedAt: new Date().toISOString() };
    stage('local-review-isolated');

    const started = await applications.start(application.id, 'multiservice_application_start');
    const ready = await waitForApplication(applications, started.runId);
    const resolved = await applications.resolveReadyRun(application.id, ready.runId);
    const apiListener = resolved.services.find((service) => service.service === 'api')?.listener;
    const frontendListener = resolved.services.find((service) => service.service === 'frontend')?.listener;
    if (apiListener?.port !== apiPort || apiListener.bindScope !== 'wildcard' || !apiListener.exclusive) {
      throw new Error(`API wildcard listener was not exclusively verified: ${JSON.stringify(ready.services)}`);
    }
    if (frontendListener?.port !== frontendPort || frontendListener.bindScope !== 'loopback' || !frontendListener.exclusive) {
      throw new Error(`frontend loopback listener was not exclusively verified: ${JSON.stringify(ready.services)}`);
    }
    stage('native-listeners-verified');
    const browser = await controller.startApplication(frontend.id, application.id, resolved.services.map((service) => ({
      service: service.service, processId: service.processId, listenerRef: service.listenerRef,
    })), 'multiservice_browser_start');
    await waitForConsole(controller, frontend.id, browser.sessionId, 'MULTISERVICE_LOGIN_OK');
    await waitForConsole(controller, frontend.id, browser.sessionId, '[vite] connected.');
    const apiProcess = resolved.services.find((service) => service.service === 'api');
    if (apiProcess === undefined) throw new Error('resolved API service missing');
    const apiLogs = await supervisor.logs(api.id, apiProcess.processId, 0, 65_536);
    const logText = apiLogs.entries.map((entry) => entry.text).join('');
    if (!logText.includes('API_MANUAL_ORIGIN_OK') || !logText.includes('API_MANUAL_HOST_OK') ||
        !logText.includes('API_CROSS_PORT_COOKIE_OK') || logText.includes('synthetic-electron-secret')) {
      throw new Error('API did not preserve manual localhost/CORS/cookie semantics or leaked the synthetic credential');
    }
    await writeFile(path.join(frontendRoot, 'src.js'), frontendSource(2));
    await waitForConsole(controller, frontend.id, browser.sessionId, 'MULTISERVICE_FRONTEND_VERSION_2');
    const browserEvents = await controller.events(frontend.id, browser.sessionId, 0, 65_536);
    if (JSON.stringify(browserEvents).includes('synthetic-electron-secret') ||
        browserEvents.events.some((event) => event.message.toLowerCase().includes('failed to connect to websocket'))) {
      throw new Error('browser events leaked the synthetic credential or HMR failed');
    }
    await controller.stop(frontend.id, browser.sessionId);
    await applications.stop(ready.runId);
    if (controller.listAll().some((entry) => entry.state === 'running') ||
        supervisor.listAll().some((entry) => entry.state === 'running') ||
        applications.listAll().some((entry) => entry.state === 'ready' || entry.state === 'starting')) {
      throw new Error('managed development resources remained active');
    }
    process.stdout.write(`${JSON.stringify({
      nativeFrontendListener: true,
      nativeManagedWildcard: true,
      applicationOrchestrated: true,
      multiserviceLocalhost: true,
      differentPorts: true,
      corsOriginPreserved: true,
      hostPreserved: true,
      crossPortCookiePreserved: true,
      viteHmrRoundTrip: true,
      syntheticCredentialNotObserved: true,
      localReviewIsolated: true,
      cleanShutdown: true,
    })}\n`);
  } finally {
    await controller.close();
    await applications.close();
    await supervisor.close();
    await rm(testRoot, { recursive: true, force: true });
    app.quit();
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  app.exit(1);
});
