import { createHash } from 'node:crypto';
import http from 'node:http';
import type { Socket } from 'node:net';

import { BrowserWindow, WebContentsView, app, webContents } from 'electron';

import { BrowserController } from '../apps/desktop/src/main/browser-controller.js';
import type { AuthorizedWorkspace, LocalApplication } from '@localbridge/workspace';

for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (error: NodeJS.ErrnoException) => {
    // Electron para Windows puede sobrevivir al shell que lanzó el verificador. Un pipe
    // diagnóstico cerrado no debe convertirse en un diálogo de error del proceso main.
    if (error.code !== 'EPIPE') throw error;
  });
}

let pagePort = 0;
let blockedPort = 0;
let alternatePort = 0;
let applicationPort = 0;
let apiPort = 0;
let blockedRequests = 0;
let blockedWebSockets = 0;
let sameOriginWebSockets = 0;
let alternateRequests = 0;
let applicationWebSockets = 0;
let apiLoginRequests = 0;
let apiSessionRequests = 0;
let apiObservedOrigin = '';
let apiObservedHost = '';
let apiObservedCookie = '';
let browserAllowed = true;
let humanControlAllowed = true;
let dynamicListenerAllowed = true;
let projectTerminalListenersAllowed = true;
let handoffConfirmation: () => Promise<boolean> = async () => true;
const pageSockets = new Set<Socket>();
const applicationSockets = new Set<Socket>();
const stage = (name: string): void => { process.stderr.write(`[browser-test] ${name}\n`); };
app.on('window-all-closed', () => { /* el verificador crea varias sesiones secuenciales */ });

const pageServer = http.createServer((request, response) => {
  if (request.url?.startsWith('/sw.js') === true) {
    response.setHeader('content-type', 'text/javascript; charset=utf-8');
    response.end("self.addEventListener('fetch',()=>{});");
    return;
  }
  if (request.url?.startsWith('/redirect-alt') === true) {
    response.statusCode = 302;
    response.setHeader('location', `http://127.0.0.1:${alternatePort}/login`);
    response.end();
    return;
  }
  response.setHeader('content-type', 'text/html; charset=utf-8');
  response.end(`<!doctype html><html><head><title>Local test</title></head><body>
    <h1>${request.url === '/next' ? 'Next page' : 'Development page'}</h1>
    <label>Query <input id="query" name="query"></label>
    <label>Password <input id="password" name="password" type="password"></label>
    <label for="fixture">Upload fixture</label><input id="fixture" name="fixture" type="file" multiple>
    <button id="open-fixture">Choose fixture indirectly</button><span id="upload-state">No fixture</span>
    <button id="action">Run action</button>
    <script>document.querySelector('#action').onclick=()=>{document.querySelector('h1').textContent='Applied: '+document.querySelector('#query').value};document.querySelector('#fixture').addEventListener('change',(event)=>{document.querySelector('#upload-state').textContent=event.target.files.length+' fixture(s) selected'});document.querySelector('#open-fixture').onclick=()=>document.querySelector('#fixture').click();document.querySelector('#password').addEventListener('input',(event)=>{const value=event.target.value;document.title='leak:'+value;document.body.dataset.leak=value;console.log('HOSTILE_PASSWORD_ECHO',value)});console.log('LOCALBRIDGE_BROWSER_READY');fetch('http://127.0.0.1:${blockedPort}/blocked').catch(()=>{});const hmr=new WebSocket('ws://127.0.0.1:${pagePort}/hmr');hmr.addEventListener('open',()=>console.log('LOCALBRIDGE_HMR_SOCKET_OPEN'));new WebSocket('ws://127.0.0.1:${blockedPort}/blocked');</script>
  </body></html>`);
});
pageServer.on('upgrade', (request, socket) => {
  const key = request.headers['sec-websocket-key'];
  if (typeof key !== 'string') {
    socket.destroy();
    return;
  }
  sameOriginWebSockets += 1;
  pageSockets.add(socket);
  socket.on('close', () => pageSockets.delete(socket));
  const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
});
const blockedServer = http.createServer((_request, response) => {
  blockedRequests += 1;
  response.end('blocked');
});
const alternateServer = http.createServer((_request, response) => {
  alternateRequests += 1;
  response.setHeader('content-type', 'text/html; charset=utf-8');
  response.end('<!doctype html><title>Alternate login</title><h1>Alternate login</h1>');
});
const applicationServer = http.createServer((_request, response) => {
  stage('multiservice-page-request');
  response.setHeader('content-type', 'text/html; charset=utf-8');
  response.end(`<!doctype html><html><head><title>Multiservice</title></head><body><h1>Multiservice ready</h1><script>
    const socket=new WebSocket('ws://localhost:${applicationPort}/hmr');
    socket.addEventListener('open',()=>console.log('MULTISERVICE_HMR_OPEN'));
    fetch('http://localhost:${apiPort}/login',{method:'POST',credentials:'include',headers:{'content-type':'application/x-www-form-urlencoded'},body:'credential=synthetic-login-secret'})
      .then((response)=>response.json())
      .then(()=>fetch('http://localhost:${apiPort}/session',{credentials:'include'}))
      .then((response)=>response.json())
      .then((value)=>console.log(value.authenticated?'MULTISERVICE_LOGIN_OK':'MULTISERVICE_LOGIN_FAILED'))
      .catch(()=>console.log('MULTISERVICE_LOGIN_FAILED'));
  </script></body></html>`);
});
applicationServer.on('upgrade', (request, socket) => {
  const key = request.headers['sec-websocket-key'];
  if (typeof key !== 'string') { socket.destroy(); return; }
  applicationWebSockets += 1;
  applicationSockets.add(socket);
  socket.on('close', () => applicationSockets.delete(socket));
  const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
});
const apiServer = http.createServer((request, response) => {
  stage(`multiservice-api-request:${request.method ?? 'unknown'}:${request.url ?? '/'}`);
  apiObservedOrigin = String(request.headers.origin ?? '');
  apiObservedHost = String(request.headers.host ?? '');
  response.setHeader('access-control-allow-origin', `http://localhost:${applicationPort}`);
  response.setHeader('access-control-allow-credentials', 'true');
  response.setHeader('content-type', 'application/json; charset=utf-8');
  if (request.url === '/login' && request.method === 'POST') {
    apiLoginRequests += 1;
    request.resume();
    request.on('end', () => {
      response.setHeader('set-cookie', 'localbridge_session=synthetic; Path=/; SameSite=Lax');
      response.end('{"ok":true}');
    });
    return;
  }
  if (request.url === '/session') {
    apiSessionRequests += 1;
    apiObservedCookie = String(request.headers.cookie ?? '');
    response.end(JSON.stringify({ authenticated: apiObservedCookie.includes('localbridge_session=synthetic') }));
    return;
  }
  response.statusCode = 404;
  response.end('{"error":"not-found"}');
});
blockedServer.on('upgrade', (_request, socket) => {
  blockedWebSockets += 1;
  socket.destroy();
});

async function waitForConsole(
  controller: BrowserController,
  workspaceId: string,
  sessionId: string,
  message: string,
): Promise<void> {
  stage(`waiting-console:${message}`);
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const events = await controller.events(workspaceId, sessionId, 0, 65_536);
    if (events.events.some((entry) => entry.type === 'console' && entry.message.includes(message))) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const diagnostic = await controller.events(workspaceId, sessionId, 0, 65_536);
  throw new Error(`Electron browser did not observe ${message}: ${JSON.stringify(diagnostic.events)}`);
}

async function main(): Promise<void> {
await Promise.all([
  new Promise<void>((resolve) => pageServer.listen(0, '127.0.0.1', resolve)),
  new Promise<void>((resolve) => blockedServer.listen(0, '127.0.0.1', resolve)),
  new Promise<void>((resolve) => alternateServer.listen(0, '127.0.0.1', resolve)),
  new Promise<void>((resolve) => applicationServer.listen(0, resolve)),
  new Promise<void>((resolve) => apiServer.listen(0, resolve)),
]);
const pageAddress = pageServer.address();
const blockedAddress = blockedServer.address();
const alternateAddress = alternateServer.address();
const applicationAddress = applicationServer.address();
const apiAddress = apiServer.address();
if (pageAddress === null || typeof pageAddress === 'string' || blockedAddress === null || typeof blockedAddress === 'string' ||
    alternateAddress === null || typeof alternateAddress === 'string' || applicationAddress === null || typeof applicationAddress === 'string' ||
    apiAddress === null || typeof apiAddress === 'string') {
  throw new Error('dynamic test listeners unavailable');
}
pagePort = pageAddress.port;
blockedPort = blockedAddress.port;
alternatePort = alternateAddress.port;
applicationPort = applicationAddress.port;
apiPort = apiAddress.port;
stage('servers-ready');
await app.whenReady();
stage('electron-ready');

const workspace = (): AuthorizedWorkspace => ({
  id: 'ws_browser',
  name: 'Browser',
  rootPath: process.cwd(),
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
    browserRead: browserAllowed,
    browserInteract: browserAllowed,
    browserHumanControl: humanControlAllowed,
  },
  limits: { maxFileBytes: 1024, maxTreeEntries: 30, maxTreeDepth: 2 },
  denyPatterns: ['.env'],
  validationProfiles: {},
  processProfiles: {
    dev: {
      command: ['npm', 'run', 'dev'],
      cwd: '.',
      source: { kind: 'package-script', manifestPath: 'package.json', script: 'dev', definitionSha256: 'a'.repeat(64) },
      maxRuntimeSeconds: 300,
    },
  },
  browserProfiles: {
    app: {
      origin: `http://127.0.0.1:${pagePort}`,
      allowedOrigins: [`http://127.0.0.1:${pagePort}`, `http://127.0.0.1:${alternatePort}`],
      viewport: { width: 1000, height: 700 },
    },
  },
  automationReviewRequired: false,
});

const apiWorkspace = (): AuthorizedWorkspace => ({
  ...workspace(),
  id: 'ws_api',
  name: 'API',
  browserProfiles: {},
});

const multiserviceApplication: LocalApplication = {
  id: `app_${'b'.repeat(24)}`,
  name: 'multiservice',
  description: '',
  primaryServiceId: `service_${'b'.repeat(24)}`,
  services: [
    { id: `service_${'b'.repeat(24)}`, alias: 'frontend', workspaceId: 'ws_browser', processProfile: 'dev', startupOrder: 1, hostMode: 'manual-localhost', allowManagedWildcard: true },
    { id: `service_${'a'.repeat(24)}`, alias: 'api', workspaceId: 'ws_api', processProfile: 'dev', startupOrder: 0, hostMode: 'manual-localhost', allowManagedWildcard: true },
  ],
  viewport: { width: 1000, height: 700 },
  reviewState: 'reviewed',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

const controller = new BrowserController({
  loadWorkspace: async (workspaceId) => workspaceId === 'ws_browser' ? workspace() : workspaceId === 'ws_api' ? apiWorkspace() : undefined,
  loadApplication: async (applicationIdOrName) => applicationIdOrName === multiserviceApplication.id || applicationIdOrName === multiserviceApplication.name ? multiserviceApplication : undefined,
  resolveProcessListener: async (workspaceId, processId, listenerRef) => {
    if (workspaceId === 'ws_browser' && processId === 'process_cccccccccccccccccccccccc' &&
        listenerRef === 'listener_cccccccccccccccccccccccc') {
      return {
        processId, listenerRef, profile: 'dev', origin: `http://localhost:${applicationPort}`,
        addressFamily: 'ipv6', bindScope: 'wildcard', exclusive: true, port: applicationPort,
        observedAt: new Date().toISOString(),
      };
    }
    if (workspaceId === 'ws_api' && processId === 'process_dddddddddddddddddddddddd' &&
        listenerRef === 'listener_dddddddddddddddddddddddd') {
      return {
        processId, listenerRef, profile: 'dev', origin: `http://localhost:${apiPort}`,
        addressFamily: 'ipv6', bindScope: 'wildcard', exclusive: true, port: apiPort,
        observedAt: new Date().toISOString(),
      };
    }
    if (!dynamicListenerAllowed || workspaceId !== 'ws_browser' || processId !== 'process_aaaaaaaaaaaaaaaaaaaaaaaa' ||
        listenerRef !== 'listener_aaaaaaaaaaaaaaaaaaaaaaaa') {
      throw new Error('listener unavailable');
    }
    return {
      processId,
      listenerRef,
      profile: 'dev',
      origin: `http://127.0.0.1:${pagePort}`,
      addressFamily: 'ipv4',
      port: pagePort,
      bindScope: 'loopback',
      exclusive: true,
      observedAt: new Date().toISOString(),
    };
  },
  resolveTerminalListener: async (projectId, terminalSessionId, listenerRef, workspaceId) => {
    if (!projectTerminalListenersAllowed || projectId !== `project_${'a'.repeat(24)}` || workspaceId !== 'ws_browser') {
      throw new Error('project terminal listener unavailable');
    }
    if (terminalSessionId === `terminal_${'e'.repeat(24)}` && listenerRef === `listener_${'e'.repeat(24)}`) {
      return {
        projectId, processId: terminalSessionId, listenerRef, profile: 'terminal', trustMode: 'full-host',
        origin: `http://localhost:${applicationPort}`, technicalOrigin: `http://[::]:${applicationPort}`,
        browserOrigin: `http://localhost:${applicationPort}`, addressFamily: 'ipv6', bindScope: 'wildcard',
        exclusive: true, port: applicationPort, observedAt: new Date().toISOString(),
      };
    }
    if (terminalSessionId === `terminal_${'f'.repeat(24)}` && listenerRef === `listener_${'f'.repeat(24)}`) {
      return {
        projectId, processId: terminalSessionId, listenerRef, profile: 'terminal', trustMode: 'full-host',
        origin: `http://localhost:${apiPort}`, technicalOrigin: `http://[::]:${apiPort}`,
        browserOrigin: `http://localhost:${apiPort}`, addressFamily: 'ipv6', bindScope: 'wildcard',
        exclusive: true, port: apiPort, observedAt: new Date().toISOString(),
      };
    }
    throw new Error('project terminal listener mismatch');
  },
  confirmHumanControlHandoff: async () => handoffConfirmation(),
});

try {
  stage('starting-session');
  const started = await controller.start('ws_browser', 'app', 'browser_start_1');
  stage('session-started');
  const repeated = await controller.start('ws_browser', 'app', 'browser_start_1');
  if (started.sessionId !== repeated.sessionId) throw new Error('browser start was not idempotent');
  const snapshot = await controller.snapshot('ws_browser', started.sessionId, 12, 500);
  stage('snapshot');
  if (!snapshot.nodes.some((node) => node['role'] === 'button' && typeof node['elementRef'] === 'string')) {
    throw new Error('interactive accessibility reference missing');
  }
  const query = snapshot.nodes.find((node) => node['role'] === 'textbox' && node['name'] === 'Query')?.['elementRef'];
  const password = snapshot.nodes.find((node) => node['role'] === 'textbox' && node['name'] === 'Password')?.['elementRef'];
  const oldButton = snapshot.nodes.find((node) => node['role'] === 'button' && node['name'] === 'Run action')?.['elementRef'];
  if (typeof query !== 'string' || typeof password !== 'string' || typeof oldButton !== 'string') {
    throw new Error(`expected form references missing: ${JSON.stringify(snapshot.nodes)}`);
  }
  await controller.fill('ws_browser', started.sessionId, snapshot.snapshotId, query, 'hello', 'fill_1');
  await controller.fill('ws_browser', started.sessionId, snapshot.snapshotId, query, 'hello', 'fill_1');
  let staleRejected = false;
  try {
    await controller.click('ws_browser', started.sessionId, snapshot.snapshotId, oldButton, 'stale_click');
  } catch (error) {
    staleRejected = error instanceof Error && 'code' in error && error.code === 'STALE_SNAPSHOT';
  }
  if (!staleRejected) throw new Error('stale snapshot was accepted');
  const interactionSnapshot = await controller.snapshot('ws_browser', started.sessionId, 12, 500);
  const currentPassword = interactionSnapshot.nodes.find((node) => node['role'] === 'textbox' && node['name'] === 'Password')?.['elementRef'];
  const currentButton = interactionSnapshot.nodes.find((node) => node['role'] === 'button' && node['name'] === 'Run action')?.['elementRef'];
  if (typeof currentPassword !== 'string' || typeof currentButton !== 'string') throw new Error('current form references missing');
  let sensitiveRejected = false;
  try {
    await controller.fill('ws_browser', started.sessionId, interactionSnapshot.snapshotId, currentPassword, 'never-store', 'fill_sensitive');
  } catch (error) {
    sensitiveRejected = error instanceof Error && 'code' in error && error.code === 'SENSITIVE_INPUT_BLOCKED';
  }
  if (!sensitiveRejected) throw new Error('password field was not rejected');
  await controller.click('ws_browser', started.sessionId, interactionSnapshot.snapshotId, currentButton, 'click_1');
  await controller.click('ws_browser', started.sessionId, interactionSnapshot.snapshotId, currentButton, 'click_1');
  const appliedSnapshot = await controller.snapshot('ws_browser', started.sessionId, 12, 500);
  if (!appliedSnapshot.nodes.some((node) => node['name'] === 'Applied: hello')) throw new Error(`controlled interaction did not update DOM: ${JSON.stringify(appliedSnapshot.nodes)}`);
  const screenshot = await controller.screenshot('ws_browser', started.sessionId);
  stage('screenshot');
  if (Buffer.from(screenshot.dataBase64, 'base64').length < 1000) throw new Error('screenshot is unexpectedly empty');
  await controller.navigate('ws_browser', started.sessionId, '/next');
  stage('navigated');
  const nextSnapshot = await controller.snapshot('ws_browser', started.sessionId, 12, 500);
  if (!nextSnapshot.nodes.some((node) => node['name'] === 'Next page')) throw new Error('navigation did not update the page');
  await new Promise((resolve) => setTimeout(resolve, 250));
  const events = await controller.events('ws_browser', started.sessionId, 0, 65_536);
  if (!events.events.some((event) => event.type === 'console' && event.message.includes('LOCALBRIDGE_BROWSER_READY'))) {
    throw new Error('console event missing');
  }
  if (!events.events.some((event) => event.type === 'console' && event.message.includes('LOCALBRIDGE_HMR_SOCKET_OPEN'))) {
    throw new Error('same-origin HMR WebSocket was blocked');
  }
  if (sameOriginWebSockets === 0) throw new Error('same-origin WebSocket did not reach the approved listener');
  if (blockedRequests !== 0) throw new Error('request escaped the approved origin');
  if (blockedWebSockets !== 0) throw new Error('WebSocket escaped to an unapproved origin');
  stage('viewer-capture-start');
  const viewerFrames = await Promise.all([
    controller.captureForLocalViewer(started.sessionId),
    controller.captureForLocalViewer(started.sessionId),
  ]);
  if (viewerFrames.some((frame) => frame.state !== 'ready' || !frame.dataUrl.startsWith('data:image/png;base64,'))) {
    throw new Error(`local viewer did not return in-memory PNG frames: ${JSON.stringify(viewerFrames.map((frame) => frame.state))}`);
  }
  stage('viewer-capture-ready');
  const liveProjectContents = webContents.getAllWebContents().find((candidate) => candidate.getURL().startsWith(`http://127.0.0.1:${pagePort}`));
  if (liveProjectContents === undefined) throw new Error('isolated project WebContentsView missing before live view');
  const originalContentsId = liveProjectContents.id;
  const originalWindowCount = BrowserWindow.getAllWindows().length;
  const visibilityBeforeLive = await liveProjectContents.executeJavaScript('document.visibilityState') as string;
  await liveProjectContents.executeJavaScript("window.__localBridgeLiveTicks=0;window.__localBridgeLiveTimer=setInterval(()=>{window.__localBridgeLiveTicks+=1},20)");
  const firstWorkArea = { x: 80, y: 70, width: 1920, height: 1040 };
  const secondWorkArea = { x: 2080, y: 120, width: 2560, height: 1400 };
  await controller.showLiveViewerLocally(started.sessionId, firstWorkArea);
  const liveWindow = BrowserWindow.getAllWindows().find((candidate) => candidate.getTitle() === 'Vista en vivo — LocalBridge');
  if (liveWindow === undefined || !liveWindow.isVisible() || liveWindow.isFocusable()) {
    throw new Error('live view was not visible and non-focusable');
  }
  const [liveX, liveY] = liveWindow.getPosition();
  if (liveX <= -9_000 || liveY <= -9_000) throw new Error('live view remained off-screen');
  if (controller.getLocalLiveViewerSessionId() !== started.sessionId) throw new Error('live view state was not exposed locally');
  if (BrowserWindow.getAllWindows().length !== originalWindowCount) throw new Error('live view created a duplicate BrowserWindow');
  const liveContents = webContents.getAllWebContents().filter((candidate) => candidate.getURL().startsWith(`http://127.0.0.1:${pagePort}`));
  if (liveContents.length !== 1 || liveContents[0]?.id !== originalContentsId) throw new Error('live view duplicated or replaced the controlled page');
  await new Promise((resolve) => setTimeout(resolve, 180));
  const liveTicks = await liveProjectContents.executeJavaScript('window.__localBridgeLiveTicks') as number;
  const visibilityDuringLive = await liveProjectContents.executeJavaScript('document.visibilityState') as string;
  if (liveTicks < 2 || !liveWindow.isVisible()) {
    throw new Error(`live page stopped executing or was not visible: ${JSON.stringify({ liveTicks, visibilityBeforeLive, visibilityDuringLive })}`);
  }
  const liveSnapshot = await controller.snapshot('ws_browser', started.sessionId, 12, 500);
  if (!liveSnapshot.nodes.some((node) => node['name'] === 'Next page')) throw new Error('agent control stopped while live view was open');
  const beforeMoveBounds = liveWindow.getBounds();
  const urlBeforeMove = liveProjectContents.getURL();
  await controller.moveLiveViewerLocally(started.sessionId, secondWorkArea);
  const afterMoveBounds = liveWindow.getBounds();
  if (afterMoveBounds.x === beforeMoveBounds.x && afterMoveBounds.y === beforeMoveBounds.y) throw new Error('live view did not move to another display area');
  if (afterMoveBounds.width !== beforeMoveBounds.width || afterMoveBounds.height !== beforeMoveBounds.height) throw new Error('moving live view changed its viewport');
  if (liveProjectContents.id !== originalContentsId || liveProjectContents.getURL() !== urlBeforeMove) throw new Error('moving live view replaced or navigated the controlled page');
  if (liveWindow.isFocusable()) throw new Error('moving live view enabled focus');
  const movedSnapshot = await controller.snapshot('ws_browser', started.sessionId, 12, 500);
  if (!movedSnapshot.nodes.some((node) => node['name'] === 'Next page')) throw new Error('agent control stopped after moving live view');
  await controller.hideLiveViewerLocally(started.sessionId);
  if (controller.getLocalLiveViewerSessionId() !== undefined) throw new Error('live view state survived explicit hide');
  const [hiddenX, hiddenY] = liveWindow.getPosition();
  if (hiddenX > -9_000 || hiddenY > -9_000) throw new Error('hidden live view remained on-screen');
  await controller.showLiveViewerLocally(started.sessionId, firstWorkArea);
  stage('live-view-ready');
  const fileSnapshot = await controller.snapshot('ws_browser', started.sessionId, 12, 500);
  const fileInput = fileSnapshot.nodes.find((node) => node['name'] === 'Upload fixture')?.['elementRef'];
  const indirectFileButton = fileSnapshot.nodes.find((node) => node['name'] === 'Choose fixture indirectly')?.['elementRef'];
  if (typeof fileInput !== 'string' || typeof indirectFileButton !== 'string') {
    throw new Error(`file chooser references missing: ${JSON.stringify(fileSnapshot.nodes)}`);
  }
  let directFileChooserBlocked = false;
  try {
    await controller.click('ws_browser', started.sessionId, fileSnapshot.snapshotId, fileInput, 'file_direct');
  } catch (error) {
    directFileChooserBlocked = error instanceof Error && 'code' in error && error.code === 'SENSITIVE_INPUT_BLOCKED';
  }
  if (!directFileChooserBlocked) throw new Error('agent opened a direct file input');
  stage('direct-file-blocked');
  let indirectFileChooserBlocked = false;
  try {
    await controller.click('ws_browser', started.sessionId, fileSnapshot.snapshotId, indirectFileButton, 'file_indirect');
  } catch (error) {
    indirectFileChooserBlocked = error instanceof Error && 'code' in error && error.code === 'SENSITIVE_INPUT_BLOCKED';
  }
  if (!indirectFileChooserBlocked) throw new Error('agent opened an indirect file chooser');
  stage('indirect-file-blocked');
  const humanRequested = await controller.requestHumanControl('ws_browser', started.sessionId, 'file_selection', 'human_1');
  const humanRepeated = await controller.requestHumanControl('ws_browser', started.sessionId, 'file_selection', 'human_1');
  if (humanRequested.state !== 'waiting_for_human' || humanRepeated.requestId !== humanRequested.requestId) {
    throw new Error('human control request was not queued idempotently');
  }
  if (controller.getLocalLiveViewerSessionId() !== undefined) throw new Error('human request did not close the live view');
  const [humanPendingX, humanPendingY] = liveWindow.getPosition();
  if (humanPendingX > -9_000 || humanPendingY > -9_000) throw new Error('live view remained visible during human handoff');
  const privateBeforeOpen = await controller.captureForLocalViewer(started.sessionId);
  if (privateBeforeOpen.state !== 'private' || 'dataUrl' in privateBeforeOpen) throw new Error('viewer exposed a pending human interval');
  let humanAgentBlocked = false;
  try {
    await controller.snapshot('ws_browser', started.sessionId, 12, 500);
  } catch (error) {
    humanAgentBlocked = error instanceof Error && 'code' in error && error.code === 'HUMAN_CONTROL_ACTIVE';
  }
  if (!humanAgentBlocked) throw new Error('agent observed while human control was pending');
  stage('human-pending-private');
  await controller.openHumanControlLocally(started.sessionId);
  const privateDuringControl = await controller.captureForLocalViewer(started.sessionId);
  if (privateDuringControl.state !== 'private' || 'dataUrl' in privateDuringControl) throw new Error('viewer exposed active human control');
  stage('human-open-private');
  await liveWindow.webContents.executeJavaScript(`for(const link of document.querySelectorAll('a'))link.setAttribute('aria-disabled','true');document.querySelector('#status').textContent='Procesando de forma segura…'`);
  handoffConfirmation = async () => false;
  await controller.completeHumanControlLocally(started.sessionId);
  const declinedHandoff = await controller.humanControlStatus('ws_browser', started.sessionId);
  const restoredControls = await liveWindow.webContents.executeJavaScript(`({disabled:[...document.querySelectorAll('a')].some((link)=>link.getAttribute('aria-disabled')==='true'),status:document.querySelector('#status')?.textContent??''})`) as { disabled: boolean; status: string };
  if (declinedHandoff.state !== 'human_control' || restoredControls.disabled || restoredControls.status.includes('Procesando')) {
    throw new Error(`declined handoff did not restore human controls: ${JSON.stringify({ declinedHandoff, restoredControls })}`);
  }
  handoffConfirmation = async () => true;
  stage('human-handoff-declined-restored');
  await controller.completeHumanControlLocally(started.sessionId);
  const humanReady = await controller.humanControlStatus('ws_browser', started.sessionId);
  if (humanReady.state !== 'ready') throw new Error('human control was not handed back');
  let preHandoffRefRejected = false;
  try {
    await controller.click('ws_browser', started.sessionId, fileSnapshot.snapshotId, indirectFileButton, 'stale_after_manual');
  } catch (error) {
    preHandoffRefRejected = error instanceof Error && 'code' in error && error.code === 'STALE_SNAPSHOT';
  }
  if (!preHandoffRefRejected) throw new Error('pre-handoff browser reference survived human control');
  const viewerAfterHandoff = await controller.captureForLocalViewer(started.sessionId);
  if (viewerAfterHandoff.state !== 'ready') throw new Error('viewer did not resume after human control');
  const signInRequested = await controller.requestHumanControl('ws_browser', started.sessionId, 'sign_in', 'human_sign_in_1');
  if (signInRequested.state !== 'waiting_for_human') throw new Error('sign-in intervention was not queued');
  let agentBlocked = false;
  try {
    await controller.snapshot('ws_browser', started.sessionId, 12, 500);
  } catch (error) {
    agentBlocked = error instanceof Error && 'code' in error && error.code === 'HUMAN_CONTROL_ACTIVE';
  }
  if (!agentBlocked) throw new Error('agent could observe while sign-in intervention was pending');
  const competing = await controller.start('ws_browser', 'app', 'browser_start_competing');
  await controller.requestHumanControl('ws_browser', competing.sessionId, 'manual_step', 'human_competing');
  await controller.openHumanControlLocally(started.sessionId);
  let listBlocked = false;
  try {
    await controller.list('ws_browser');
  } catch (error) {
    listBlocked = error instanceof Error && 'code' in error && error.code === 'HUMAN_CONTROL_ACTIVE';
  }
  if (!listBlocked) throw new Error('browser.list exposed a session during human control');
  let secondHumanBlocked = false;
  try {
    await controller.openHumanControlLocally(competing.sessionId);
  } catch (error) {
    secondHumanBlocked = error instanceof Error && 'code' in error && error.code === 'HUMAN_CONTROL_BUSY';
  }
  if (!secondHumanBlocked) throw new Error('a second human-control window was allowed');
  await controller.declineHumanControlLocally(competing.sessionId);
  const projectContents = webContents.getAllWebContents().find((candidate) => candidate.getURL().startsWith(`http://127.0.0.1:${pagePort}`));
  if (projectContents === undefined) throw new Error('isolated project WebContentsView missing');
  await projectContents.executeJavaScript("location.href='/redirect-alt'");
  await new Promise((resolve) => setTimeout(resolve, 250));
  if (alternateRequests !== 0) throw new Error('manual main-frame redirect reached another allowed origin');
  stage('manual-redirect-blocked');
  await projectContents.loadURL(`http://127.0.0.1:${pagePort}/next`);
  const authenticatedSession = projectContents.session;
  await projectContents.executeJavaScript(`(async()=>{const password=document.querySelector('#password');password.value='secret-value';password.dispatchEvent(new Event('input',{bubbles:true}));document.cookie='auth_test=secret-value';localStorage.setItem('auth_test','secret-value');await new Promise((resolve,reject)=>{const request=indexedDB.open('auth_test',1);request.onupgradeneeded=()=>request.result.createObjectStore('values');request.onsuccess=()=>resolve();request.onerror=()=>reject(request.error)});await caches.open('auth-test');await navigator.serviceWorker.register('/sw.js');history.replaceState({},'', '/next?credential=secret-value#token');password.value='';document.title='Local test';delete document.body.dataset.leak})()`);
  await controller.completeHumanControlLocally(started.sessionId);
  stage('sign-in-handed-off');
  const ready = await controller.humanControlStatus('ws_browser', started.sessionId);
  if (ready.state !== 'ready') throw new Error('sign-in session was not handed back');
  const afterAuth = await controller.snapshot('ws_browser', started.sessionId, 12, 500);
  if (afterAuth.path !== '/next') throw new Error(`query or fragment leaked from path: ${afterAuth.path}`);
  await controller.requestHumanControl('ws_browser', started.sessionId, 'manual_step', 'human_after_sign_in_1');
  await controller.openHumanControlLocally(started.sessionId);
  await controller.completeHumanControlLocally(started.sessionId);
  const afterRepeatedHumanControl = (await controller.list('ws_browser')).find((entry) => entry.sessionId === started.sessionId);
  if (afterRepeatedHumanControl?.controlState !== 'agent_control') {
    throw new Error('repeated human control did not return authority to the agent');
  }
  const postAuthEvents = await controller.events('ws_browser', started.sessionId, 0, 65_536);
  if (JSON.stringify(postAuthEvents).includes('secret-value')) throw new Error('manual credentials leaked into browser events');
  humanControlAllowed = false;
  let humanControlRevoked = false;
  try {
    await controller.snapshot('ws_browser', started.sessionId, 12, 500);
  } catch (error) {
    humanControlRevoked = error instanceof Error && 'code' in error && error.code === 'HUMAN_CONTROL_NOT_ALLOWED';
  }
  if (!humanControlRevoked) throw new Error('post-handoff session survived immediate permission revocation');
  stage('human-control-revoked');
  humanControlAllowed = true;
  await new Promise((resolve) => setTimeout(resolve, 250));
  const probeWindow = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } });
  const probeView = new WebContentsView({ webPreferences: { session: authenticatedSession, nodeIntegration: false, contextIsolation: true, sandbox: true } });
  probeWindow.contentView.addChildView(probeView);
  await probeView.webContents.loadURL(`http://127.0.0.1:${pagePort}`);
  const previousPartition = await probeView.webContents.executeJavaScript(`(async()=>({cookie:document.cookie,local:localStorage.getItem('auth_test'),databases:(await indexedDB.databases()).map((entry)=>entry.name),caches:await caches.keys(),workers:(await navigator.serviceWorker.getRegistrations()).length}))()`) as { cookie: string; local: string | null; databases: string[]; caches: string[]; workers: number };
  probeWindow.contentView.removeChildView(probeView);
  probeView.webContents.close({ waitForBeforeUnload: false });
  probeWindow.destroy();
  if (previousPartition.cookie.includes('auth_test') || previousPartition.local !== null ||
      previousPartition.databases.includes('auth_test') || previousPartition.caches.includes('auth-test') || previousPartition.workers !== 0) {
    throw new Error(`ephemeral authentication partition was not cleared: ${JSON.stringify(previousPartition)}`);
  }
  const clean = await controller.start('ws_browser', 'app', 'browser_start_clean');
  const cleanContents = webContents.getAllWebContents().find((candidate) => candidate.getURL().startsWith(`http://127.0.0.1:${pagePort}`));
  if (cleanContents === undefined) throw new Error('clean browser contents missing');
  const persisted = await cleanContents.executeJavaScript(`({cookie:document.cookie,local:localStorage.getItem('auth_test')})`) as { cookie: string; local: string | null };
  if (persisted.cookie.includes('auth_test') || persisted.local !== null) throw new Error('ephemeral authentication storage survived session destruction');
  await controller.stop('ws_browser', clean.sessionId);
  stage('storage-cleared');
  const race = await controller.start('ws_browser', 'app', 'browser_start_handoff_race');
  await controller.requestHumanControl('ws_browser', race.sessionId, 'sign_in', 'human_handoff_race');
  await controller.openHumanControlLocally(race.sessionId);
  let resolveHandoff!: (confirmed: boolean) => void;
  handoffConfirmation = () => new Promise<boolean>((resolve) => { resolveHandoff = resolve; });
  const pendingHandoff = controller.completeHumanControlLocally(race.sessionId);
  await new Promise((resolve) => setTimeout(resolve, 25));
  await controller.stop('ws_browser', race.sessionId);
  resolveHandoff(true);
  await pendingHandoff;
  handoffConfirmation = async () => true;
  stage('handoff-race-closed');
  const multiservice = await controller.startApplication('ws_browser', 'multiservice', [
    { service: 'frontend', processId: 'process_cccccccccccccccccccccccc', listenerRef: 'listener_cccccccccccccccccccccccc' },
    { service: 'api', processId: 'process_dddddddddddddddddddddddd', listenerRef: 'listener_dddddddddddddddddddddddd' },
  ], 'browser_multiservice_1');
  stage('multiservice-started');
  await waitForConsole(controller, 'ws_browser', multiservice.sessionId, 'MULTISERVICE_LOGIN_OK');
  await waitForConsole(controller, 'ws_browser', multiservice.sessionId, 'MULTISERVICE_HMR_OPEN');
  const multiserviceEvents = await controller.events('ws_browser', multiservice.sessionId, 0, 65_536);
  if (apiLoginRequests !== 1 || apiSessionRequests !== 1 || applicationWebSockets !== 1) {
    throw new Error(`multiservice traffic incomplete: ${JSON.stringify({ apiLoginRequests, apiSessionRequests, applicationWebSockets })}`);
  }
  if (apiObservedOrigin !== `http://localhost:${applicationPort}` || apiObservedHost !== `localhost:${apiPort}` ||
      !apiObservedCookie.includes('localbridge_session=synthetic')) {
    throw new Error(`manual localhost semantics changed: ${JSON.stringify({ apiObservedOrigin, apiObservedHost, apiObservedCookie })}`);
  }
  if (JSON.stringify(multiserviceEvents).includes('synthetic-login-secret')) {
    throw new Error('synthetic credential crossed LocalBridge browser events');
  }
  await controller.stop('ws_browser', multiservice.sessionId);
  apiLoginRequests = 0;
  apiSessionRequests = 0;
  applicationWebSockets = 0;
  apiObservedOrigin = '';
  apiObservedHost = '';
  apiObservedCookie = '';
  const projectId = `project_${'a'.repeat(24)}`;
  const projectBrowser = await controller.startProjectFromTerminals('ws_browser', projectId, [
    {
      projectId, processId: `terminal_${'e'.repeat(24)}`, listenerRef: `listener_${'e'.repeat(24)}`,
      profile: 'terminal', trustMode: 'full-host', origin: `http://localhost:${applicationPort}`,
      technicalOrigin: `http://[::]:${applicationPort}`, browserOrigin: `http://localhost:${applicationPort}`,
      addressFamily: 'ipv6', bindScope: 'wildcard', exclusive: true, port: applicationPort,
      observedAt: new Date().toISOString(),
    },
    {
      projectId, processId: `terminal_${'f'.repeat(24)}`, listenerRef: `listener_${'f'.repeat(24)}`,
      profile: 'terminal', trustMode: 'full-host', origin: `http://localhost:${apiPort}`,
      technicalOrigin: `http://[::]:${apiPort}`, browserOrigin: `http://localhost:${apiPort}`,
      addressFamily: 'ipv6', bindScope: 'wildcard', exclusive: true, port: apiPort,
      observedAt: new Date().toISOString(),
    },
  ], 'browser_project_multiservice_1');
  stage('project-multiservice-started');
  await waitForConsole(controller, 'ws_browser', projectBrowser.sessionId, 'MULTISERVICE_LOGIN_OK');
  await waitForConsole(controller, 'ws_browser', projectBrowser.sessionId, 'MULTISERVICE_HMR_OPEN');
  if (apiLoginRequests !== 1 || apiSessionRequests !== 1 || applicationWebSockets !== 1 ||
      apiObservedOrigin !== `http://localhost:${applicationPort}` || apiObservedHost !== `localhost:${apiPort}` ||
      !apiObservedCookie.includes('localbridge_session=synthetic')) {
    throw new Error(`project multiservice traffic incomplete: ${JSON.stringify({
      apiLoginRequests, apiSessionRequests, applicationWebSockets, apiObservedOrigin, apiObservedHost, apiObservedCookie,
    })}`);
  }
  projectTerminalListenersAllowed = false;
  await controller.reconcile();
  const projectAfterLoss = await controller.list('ws_browser');
  if (projectAfterLoss.find((entry) => entry.sessionId === projectBrowser.sessionId)?.state !== 'stopped') {
    throw new Error('project multiservice session survived listener authority loss');
  }
  const dynamic = await controller.startFromProcess('ws_browser', {
    processId: 'process_aaaaaaaaaaaaaaaaaaaaaaaa',
    listenerRef: 'listener_aaaaaaaaaaaaaaaaaaaaaaaa',
    profile: 'dev',
    origin: `http://127.0.0.1:${pagePort}`,
    addressFamily: 'ipv4',
    port: pagePort,
    bindScope: 'loopback',
    exclusive: true,
    observedAt: new Date().toISOString(),
  }, 'browser_dynamic_1');
  dynamicListenerAllowed = false;
  let dynamicRequestBlocked = false;
  try {
    await controller.navigate('ws_browser', dynamic.sessionId, '/next');
  } catch (error) {
    dynamicRequestBlocked = error instanceof Error && 'code' in error && error.code === 'FEATURE_UNAVAILABLE';
  }
  if (!dynamicRequestBlocked) throw new Error('dynamic request survived listener ownership loss');
  await controller.reconcile();
  const dynamicAfterListenerLoss = await controller.list('ws_browser');
  if (dynamicAfterListenerLoss.find((entry) => entry.sessionId === dynamic.sessionId)?.state !== 'stopped') {
    throw new Error('dynamic session survived listener ownership loss');
  }
  browserAllowed = false;
  await controller.reconcile();
  const listedAfterRevocation = await controller.list('ws_browser').catch(() => []);
  if (listedAfterRevocation.length !== 0) throw new Error('revocation should block listing');
  process.stdout.write(`${JSON.stringify({
    isolated: true,
    idempotent: true,
    accessibilityNodes: snapshot.nodes.length,
    screenshotBytes: Buffer.from(screenshot.dataBase64, 'base64').length,
    consoleCaptured: true,
    sameOriginWebSocketAllowed: true,
    externalOriginBlocked: true,
    externalWebSocketBlocked: true,
    navigation: true,
    controlledInteraction: true,
    staleSnapshotRejected: true,
    sensitiveInputRejected: true,
    directFileChooserBlocked: true,
    indirectFileChooserBlocked: true,
    humanControlIdempotent: true,
    declinedHandoffRestoredControls: true,
    agentExcludedDuringHumanControl: true,
    viewerPrivateDuringHumanControl: true,
    humanHandoffReady: true,
    preHandoffRefRejected: true,
    viewerInMemory: true,
    viewerResumed: true,
    liveViewerSameWindow: true,
    liveViewerSameWebContents: true,
    liveViewerNonFocusable: true,
    liveViewerAgentControlPreserved: true,
    liveViewerExecutionPreserved: true,
    liveViewerHumanAutoHide: true,
    liveViewerMovedWithoutResize: true,
    liveViewerMovedWithoutNavigation: true,
    liveViewerMoveAgentControlPreserved: true,
    signInReasonSupported: true,
    repeatedHumanControlPreservedSession: true,
    listingBlockedDuringHumanControl: true,
    oneHumanSessionAtATime: true,
    humanCrossOriginRedirectBlocked: true,
    handoffRaceClosed: true,
    projectMultiserviceLocalhost: true,
    projectMultiserviceAuthorityRevoked: true,
    humanSecretsNotObserved: true,
    queryAndFragmentRedacted: true,
    previousPartitionStorageCleared: true,
    ephemeralStorageCleared: true,
    humanControlRevocationImmediate: true,
    multiserviceLocalhost: true,
    managedWildcard: true,
    corsOriginPreserved: true,
    hostPreserved: true,
    crossPortCookiePreserved: true,
    multiserviceHmrWebSocket: true,
    syntheticCredentialNotObserved: true,
    dynamicListenerAdopted: true,
    dynamicRequestBlockedOnListenerLoss: true,
    dynamicListenerLossClosed: true,
    revocationImmediate: true,
  })}\n`);
} finally {
  browserAllowed = true;
  humanControlAllowed = true;
  await controller.close();
  for (const socket of pageSockets) socket.destroy();
  for (const socket of applicationSockets) socket.destroy();
  await Promise.all([
    new Promise<void>((resolve) => pageServer.close(() => resolve())),
    new Promise<void>((resolve) => blockedServer.close(() => resolve())),
    new Promise<void>((resolve) => alternateServer.close(() => resolve())),
    new Promise<void>((resolve) => applicationServer.close(() => resolve())),
    new Promise<void>((resolve) => apiServer.close(() => resolve())),
  ]);
  app.quit();
}
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  app.exit(1);
});
