import { createHash } from 'node:crypto';
import http from 'node:http';
import type { Socket } from 'node:net';

import { BrowserWindow, WebContentsView, app, webContents } from 'electron';

import { BrowserController } from '../apps/desktop/src/main/browser-controller.js';
import type { AuthorizedWorkspace, LocalApplication } from '@localbridge/workspace';
import { LocalBridgeError } from '@localbridge/shared';

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
let savedBrowserEvidence = 0;
let savedMotionBundles = 0;
let reloadAssetVersion = 1;
const pageSockets = new Set<Socket>();
const applicationSockets = new Set<Socket>();
const stage = (name: string): void => { process.stderr.write(`[browser-test] ${name}\n`); };
app.on('window-all-closed', () => { /* el verificador crea varias sesiones secuenciales */ });

const pageServer = http.createServer((request, response) => {
  if (request.url?.startsWith('/reload-resource.js') === true) {
    response.setHeader('content-type', 'text/javascript; charset=utf-8');
    response.setHeader('cache-control', 'public, max-age=3600');
    response.end(`window.__resourceVersion=${reloadAssetVersion};`);
    return;
  }
  if (request.url?.startsWith('/sw.js') === true) {
    response.setHeader('content-type', 'text/javascript; charset=utf-8');
    response.end("self.addEventListener('fetch',()=>{});");
    return;
  }
  if (request.url?.startsWith('/qa-response') === true) {
    response.setHeader('content-type', 'application/json; charset=utf-8');
    response.end('{"ok":true}');
    return;
  }
  if (request.url?.startsWith('/redirect-alt') === true) {
    response.statusCode = 302;
    response.setHeader('location', `http://127.0.0.1:${alternatePort}/login`);
    response.end();
    return;
  }
  if (request.url?.startsWith('/missing') === true) response.statusCode = 404;
  response.setHeader('content-type', 'text/html; charset=utf-8');
  response.end(`<!doctype html><html><head><title>Local test</title><style>
    :root{--fixture-accent:#12a4b8}
    @keyframes pulse-fixture { from { opacity:.35; transform:translateY(8px) } to { opacity:1; transform:translateY(0) } }
    #motion-css{animation:pulse-fixture 800ms ease-in-out infinite alternate}.sticky-fixture{position:sticky;top:0;background:#fff}
    #transition-fixture{opacity:.3;transition:opacity 150ms ease}#transition-fixture.active{opacity:1}#stable-target{transform:translateX(0);transition:transform 450ms ease}#stable-target.active{transform:translateX(40px)}
  </style></head><body>
    <h1>${request.url === '/next' ? 'Next page' : 'Development page'}</h1>
    <div id="motion-css">CSS animation fixture</div><div class="sticky-fixture">Sticky fixture</div>
    <div id="transition-fixture">Transition fixture</div><canvas id="motion-canvas" width="64" height="32"></canvas>
    <label>Query <input id="query" name="query"></label>
    <label>Password <input id="password" name="password" type="password"></label>
    <label for="fixture">Upload fixture</label><input id="fixture" name="fixture" type="file" multiple>
    <button id="open-fixture">Choose fixture indirectly</button><span id="upload-state">No fixture</span>
    <button id="action">Run action</button>
    <label>Theme <select id="theme"><option value="blue">Blue</option><option value="green">Green</option></select></label>
    <button id="hover">Hover target</button><button id="toast">Show toast</button><div id="toast-state" aria-live="polite"></div><button id="async">Run async</button><button id="dialog">Open dialog</button>
    <button id="disabled" disabled>Disabled action</button><div id="non-focusable" role="button">Non focusable action</div><button id="stable-target">Stable target</button>
    <div role="menu" aria-label="Fixture menu"><button role="menuitem" id="menu-one">Menu one</button><button role="menuitem" id="menu-two">Menu two</button></div>
    <button id="drag-source">Drag source</button><button id="drag-target">Drag target</button>
    <output id="qa-state" aria-live="polite">QA idle</output><output id="reload-version"></output><div style="height:1400px">Scrollable fixture</div>
    <script src="/reload-resource.js"></script><script>document.querySelector('#reload-version').textContent='Resource '+window.__resourceVersion;document.addEventListener('keydown',(event)=>{document.body.dataset.lastKey=event.key},true);document.addEventListener('mousedown',(event)=>console.log('SYNTHETIC_MOUSE_DOWN',event.clientX,event.clientY,event.target.id),true);document.querySelector('#action').onclick=()=>{document.querySelector('h1').textContent='Applied: '+document.querySelector('#query').value};document.querySelector('#fixture').addEventListener('change',(event)=>{document.querySelector('#upload-state').textContent=event.target.files.length+' fixture(s) selected'});document.querySelector('#open-fixture').onclick=()=>document.querySelector('#fixture').click();document.querySelector('#password').addEventListener('input',(event)=>{const value=event.target.value;document.title='leak:'+value;document.body.dataset.leak=value;console.log('HOSTILE_PASSWORD_ECHO',value)});document.querySelector('#theme').onchange=(event)=>document.querySelector('#qa-state').textContent='Theme: '+event.target.value;document.querySelector('#menu-one').onkeydown=(event)=>{if(event.key==='ArrowDown')document.querySelector('#menu-two').focus();if(event.key==='ArrowRight')document.querySelector('#password').focus()};document.querySelector('#menu-two').onkeydown=(event)=>{if(event.key==='Enter')document.querySelector('#qa-state').textContent='Menu activated'};document.querySelector('#hover').onmouseenter=()=>document.querySelector('#qa-state').textContent='Hovered';window.__toastClicks=0;document.querySelector('#toast').onclick=()=>{window.__toastClicks+=1;document.querySelector('#toast-state').textContent='Toast visible';setTimeout(()=>document.querySelector('#toast-state').textContent='',5000)};document.querySelector('#async').onclick=()=>setTimeout(async()=>{await fetch('/qa-response');document.querySelector('#qa-state').textContent='Async ready'},250);document.querySelector('#dialog').onclick=()=>confirm('Synthetic dialog');let dragging=false;document.querySelector('#drag-source').onmousedown=()=>{dragging=true};document.querySelector('#drag-target').onmouseup=()=>{if(dragging)document.querySelector('#qa-state').textContent='Dragged';dragging=false};document.querySelector('#transition-fixture').classList.add('active');document.querySelector('#motion-css').animate([{filter:'brightness(.7)'},{filter:'brightness(1)'}],{duration:900,iterations:Infinity,direction:'alternate'});const motionContext=document.querySelector('#motion-canvas').getContext('2d');motionContext.fillStyle='#0cf';motionContext.fillRect(0,0,64,32);setTimeout(()=>document.body.dataset.lazyReady='true',120);console.log('LOCALBRIDGE_BROWSER_READY');fetch('http://127.0.0.1:${blockedPort}/blocked').catch(()=>{});const hmr=new WebSocket('ws://127.0.0.1:${pagePort}/hmr');hmr.addEventListener('open',()=>console.log('LOCALBRIDGE_HMR_SOCKET_OPEN'));new WebSocket('ws://127.0.0.1:${blockedPort}/blocked');</script>
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
  preflightScreenshot: async ({ path: destinationPath }) => {
    if (destinationPath === 'evidence/preflight-fail.png') throw new LocalBridgeError('FILE_ALREADY_EXISTS');
  },
  saveScreenshot: async ({ path: destinationPath, bytes }) => {
    if (destinationPath === 'evidence/disk-fail.png') throw new LocalBridgeError('INTERNAL_ERROR');
    if (!destinationPath.startsWith('evidence/') || !Buffer.from(bytes).subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
      throw new Error('invalid browser evidence fixture');
    }
    savedBrowserEvidence += 1;
    const content = Buffer.from(bytes);
    return { path: destinationPath, sha256: createHash('sha256').update(content).digest('hex'), size: content.length, created: true };
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
        if (totalSize + requiredBytes > 1024 * 1024 * 1024) throw new LocalBridgeError('FILE_TOO_LARGE');
      },
      write: async (relativePath, input) => {
        const bytes = Buffer.from(input);
        if (bytes.length > 256 * 1024 * 1024 || totalSize + bytes.length > 1024 * 1024 * 1024) {
          throw new LocalBridgeError('FILE_TOO_LARGE');
        }
        const receipt = { path: relativePath, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length };
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
  stage('starting-session');
  const started = await controller.start('ws_browser', 'app', 'browser_start_1');
  stage('session-started');
  const repeated = await controller.start('ws_browser', 'app', 'browser_start_1');
  if (started.sessionId !== repeated.sessionId) throw new Error('browser start was not idempotent');
  const capacitySessions = [];
  for (let index = 0; index < 3; index += 1) {
    capacitySessions.push(await controller.start('ws_browser', 'app', `browser_capacity_${index}`));
  }
  let browserCapacityRejected = false;
  try {
    await controller.start('ws_browser', 'app', 'browser_capacity_overflow');
  } catch (error) {
    browserCapacityRejected = error instanceof Error && 'code' in error && error.code === 'RATE_LIMITED';
  }
  if (!browserCapacityRejected) throw new Error('fifth concurrent browser session did not return RATE_LIMITED');
  for (const session of capacitySessions) await controller.stop('ws_browser', session.sessionId);
  const viewport = await controller.setViewport('ws_browser', started.sessionId, 980, 680, false, 'viewport_replay');
  const viewportReplay = await controller.setViewport('ws_browser', started.sessionId, 980, 680, false, 'viewport_replay');
  if (JSON.stringify(viewportReplay) !== JSON.stringify(viewport)) throw new Error('viewport replay changed its result');
  let viewportConflict = false;
  try {
    await controller.setViewport('ws_browser', started.sessionId, 900, 640, false, 'viewport_replay');
  } catch (error) {
    viewportConflict = error instanceof Error && 'code' in error && error.code === 'IDEMPOTENCY_CONFLICT';
  }
  if (!viewportConflict) throw new Error('viewport operationId accepted a different viewport');
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
  let sensitiveInspectionRejected = false;
  try {
    await controller.inspect('ws_browser', started.sessionId, 'element', interactionSnapshot.snapshotId, currentPassword, ['color'], []);
  } catch (error) {
    sensitiveInspectionRejected = error instanceof Error && 'code' in error && error.code === 'SENSITIVE_INPUT_BLOCKED';
  }
  if (!sensitiveInspectionRejected) throw new Error('password field was exposed through CSS inspection');
  await controller.click('ws_browser', started.sessionId, interactionSnapshot.snapshotId, currentButton, 'click_1');
  await controller.click('ws_browser', started.sessionId, interactionSnapshot.snapshotId, currentButton, 'click_1');
  const appliedSnapshot = await controller.snapshot('ws_browser', started.sessionId, 12, 500);
  if (!appliedSnapshot.nodes.some((node) => node['name'] === 'Applied: hello')) {
    const clickDiagnostic = await controller.events('ws_browser', started.sessionId, 0, 65_536);
    throw new Error(`controlled interaction did not update DOM: ${JSON.stringify({ nodes: appliedSnapshot.nodes, events: clickDiagnostic.events })}`);
  }
  await controller.assert('ws_browser', started.sessionId, { kind: 'text', value: 'Applied: hello', state: 'present' });
  const disabled = appliedSnapshot.nodes.find((node) => node['role'] === 'button' && node['name'] === 'Disabled action')?.['elementRef'];
  const hover = appliedSnapshot.nodes.find((node) => node['role'] === 'button' && node['name'] === 'Hover target')?.['elementRef'];
  if (typeof disabled !== 'string' || typeof hover !== 'string') throw new Error('QA button references missing');
  let disabledRejected = false;
  try {
    await controller.click('ws_browser', started.sessionId, appliedSnapshot.snapshotId, disabled, 'disabled_click');
  } catch (error) {
    disabledRejected = error instanceof Error && 'code' in error && error.code === 'ELEMENT_NOT_INTERACTABLE';
  }
  if (!disabledRejected) throw new Error('disabled element accepted a click');
  await controller.hover('ws_browser', started.sessionId, appliedSnapshot.snapshotId, hover, 'hover_qa');
  await controller.wait('ws_browser', started.sessionId, { kind: 'text', value: 'Hovered', state: 'present' }, 2_000);
  stage('hover-qa-passed');

  const selectSnapshot = await controller.snapshot('ws_browser', started.sessionId, 12, 500);
  const theme = selectSnapshot.nodes.find((node) => node['role'] === 'combobox' && node['name'] === 'Theme')?.['elementRef'];
  if (typeof theme !== 'string') throw new Error(`select reference missing: ${JSON.stringify(selectSnapshot.nodes)}`);
  await controller.select('ws_browser', started.sessionId, selectSnapshot.snapshotId, theme, 'green', 'select_qa');
  await controller.assert('ws_browser', started.sessionId, { kind: 'text', value: 'Theme: green', state: 'present' });
  stage('select-qa-passed');

  const pressSnapshot = await controller.snapshot('ws_browser', started.sessionId, 12, 500);
  const pressTheme = pressSnapshot.nodes.find((node) => node['role'] === 'combobox' && node['name'] === 'Theme')?.['elementRef'];
  const pressDisabled = pressSnapshot.nodes.find((node) => node['role'] === 'button' && node['name'] === 'Disabled action')?.['elementRef'];
  const nonFocusable = pressSnapshot.nodes.find((node) => node['role'] === 'button' && node['name'] === 'Non focusable action')?.['elementRef'];
  if (typeof pressTheme !== 'string' || typeof pressDisabled !== 'string' || typeof nonFocusable !== 'string') {
    throw new Error(`keyboard fixture references missing: ${JSON.stringify(pressSnapshot.nodes)}`);
  }
  const pressed = await controller.press('ws_browser', started.sessionId, pressSnapshot.snapshotId, pressTheme, 'ArrowUp', 'press_qa');
  const pressedReplay = await controller.press('ws_browser', started.sessionId, pressSnapshot.snapshotId, pressTheme, 'ArrowUp', 'press_qa');
  if (JSON.stringify(pressedReplay) !== JSON.stringify(pressed)) throw new Error('keyboard operationId replay changed its result');
  const activeInspection = await controller.inspect('ws_browser', started.sessionId, 'active', undefined, undefined,
    ['color', 'background-color', 'font-family'], ['--fixture-accent']);
  if (!activeInspection.state.active || activeInspection.state.role !== 'combobox' ||
      activeInspection.variables['--fixture-accent'] !== '#12a4b8' || activeInspection.rect.width <= 0) {
    throw new Error(`active element inspection is incomplete: ${JSON.stringify(activeInspection)}`);
  }
  const afterPressSnapshot = await controller.snapshot('ws_browser', started.sessionId, 12, 500);
  const afterPressDisabled = afterPressSnapshot.nodes.find((node) => node['role'] === 'button' && node['name'] === 'Disabled action')?.['elementRef'];
  const afterPressNonFocusable = afterPressSnapshot.nodes.find((node) => node['role'] === 'button' && node['name'] === 'Non focusable action')?.['elementRef'];
  if (typeof afterPressDisabled !== 'string' || typeof afterPressNonFocusable !== 'string') throw new Error('keyboard rejection references missing');
  let disabledPressRejected = false;
  try {
    await controller.press('ws_browser', started.sessionId, afterPressSnapshot.snapshotId, afterPressDisabled, 'Enter', 'press_disabled');
  } catch (error) {
    disabledPressRejected = error instanceof Error && 'code' in error && error.code === 'ELEMENT_NOT_INTERACTABLE';
  }
  if (!disabledPressRejected) throw new Error('disabled element accepted a keyboard press');
  let nonFocusableRejected = false;
  try {
    await controller.press('ws_browser', started.sessionId, afterPressSnapshot.snapshotId, afterPressNonFocusable, 'Enter', 'press_non_focusable');
  } catch (error) {
    nonFocusableRejected = error instanceof Error && 'code' in error && error.code === 'ELEMENT_NOT_INTERACTABLE';
  }
  if (!nonFocusableRejected) throw new Error('non-focusable element accepted a keyboard press');
  stage('press-qa-passed');

  const selectSequenceSnapshot = await controller.snapshot('ws_browser', started.sessionId, 12, 500);
  const sequenceTheme = selectSequenceSnapshot.nodes.find((node) => node['role'] === 'combobox' && node['name'] === 'Theme')?.['elementRef'];
  if (typeof sequenceTheme !== 'string') throw new Error('select sequence reference missing');
  const selectSequence = await controller.keyboardSequence('ws_browser', started.sessionId, selectSequenceSnapshot.snapshotId,
    sequenceTheme, ['ArrowDown', 'Enter'], 'keyboard_select_sequence');
  if (selectSequence.actionState !== 'complete' || selectSequence.keysSent !== 2) throw new Error('select keyboard sequence did not complete');
  const sequenceContents = webContents.getAllWebContents().find((candidate) => candidate.getURL().startsWith(`http://127.0.0.1:${pagePort}`));
  if (sequenceContents === undefined || await sequenceContents.executeJavaScript("document.querySelector('#theme').value", true) !== 'green') {
    throw new Error('select keyboard sequence did not move the native selection');
  }
  stage('select-sequence-passed');

  const menuSequenceSnapshot = await controller.snapshot('ws_browser', started.sessionId, 12, 500);
  const menuOne = menuSequenceSnapshot.nodes.find((node) => node['role'] === 'menuitem' && node['name'] === 'Menu one')?.['elementRef'];
  if (typeof menuOne !== 'string') throw new Error('menu sequence reference missing');
  const menuSequence = await controller.keyboardSequence('ws_browser', started.sessionId, menuSequenceSnapshot.snapshotId,
    menuOne, ['ArrowDown', 'Enter'], 'keyboard_menu_sequence');
  if (menuSequence.actionState !== 'complete' || menuSequence.keysSent !== 2) throw new Error('moving-focus menu sequence did not complete');
  stage('menu-sequence-applied');
  const menuState = await sequenceContents.executeJavaScript("({active:document.activeElement?.id,state:document.querySelector('#qa-state').textContent,lastKey:document.body.dataset.lastKey})", true) as { active?: string; state?: string; lastKey?: string };
  if (menuState.active !== 'menu-two' || menuState.state !== 'Menu activated') throw new Error(`moving-focus menu sequence failed: ${JSON.stringify(menuState)}`);

  const sensitiveSequenceSnapshot = await controller.snapshot('ws_browser', started.sessionId, 12, 500);
  const sensitiveMenuOne = sensitiveSequenceSnapshot.nodes.find((node) => node['role'] === 'menuitem' && node['name'] === 'Menu one')?.['elementRef'];
  if (typeof sensitiveMenuOne !== 'string') throw new Error('sensitive sequence reference missing');
  const sensitiveSequence = await controller.keyboardSequence('ws_browser', started.sessionId, sensitiveSequenceSnapshot.snapshotId,
    sensitiveMenuOne, ['ArrowRight', 'Enter'], 'keyboard_sensitive_sequence');
  if (sensitiveSequence.actionState !== 'partial' || sensitiveSequence.keysSent !== 1 || sensitiveSequence.stoppedReason !== 'sensitive_focus') {
    throw new Error(`keyboard sequence did not stop before sensitive focus: ${JSON.stringify(sensitiveSequence)}`);
  }
  stage('keyboard-sequences-passed');

  const stableSnapshot = await controller.snapshot('ws_browser', started.sessionId, 12, 500);
  const stableRef = stableSnapshot.nodes.find((node) => node['role'] === 'button' && node['name'] === 'Stable target')?.['elementRef'];
  if (typeof stableRef !== 'string') throw new Error('stable target reference missing');
  const stableContents = webContents.getAllWebContents().find((candidate) => candidate.getURL().startsWith(`http://127.0.0.1:${pagePort}`));
  if (stableContents === undefined) throw new Error('controlled web contents missing for stable wait');
  await stableContents.executeJavaScript("document.querySelector('#stable-target').classList.add('active')", true);
  const stableWait = await controller.wait('ws_browser', started.sessionId, {
    kind: 'stable', snapshotId: stableSnapshot.snapshotId, elementRef: stableRef, intervalMs: 150, tolerancePx: 0.25,
  }, 2_000);
  if (stableWait.waitedMs < 150) throw new Error('stable wait returned before the required interval');
  stage('stable-wait-passed');

  const asyncSnapshot = await controller.snapshot('ws_browser', started.sessionId, 12, 500);
  const asyncButton = asyncSnapshot.nodes.find((node) => node['role'] === 'button' && node['name'] === 'Run async')?.['elementRef'];
  if (typeof asyncButton !== 'string') throw new Error('async button reference missing');
  const beforeAsync = await controller.events('ws_browser', started.sessionId, 0, 65_536);
  await controller.click('ws_browser', started.sessionId, asyncSnapshot.snapshotId, asyncButton, 'async_qa');
  await controller.wait('ws_browser', started.sessionId, { kind: 'response', path: '/qa-response', status: 200, afterCursor: beforeAsync.nextCursor }, 2_000);
  await controller.wait('ws_browser', started.sessionId, { kind: 'text', value: 'Async ready', state: 'present' }, 2_000);
  await controller.assert('ws_browser', started.sessionId, { kind: 'no-console-errors', afterCursor: beforeAsync.nextCursor });
  stage('async-qa-passed');

  await controller.scroll('ws_browser', started.sessionId, 'down', 700, 'shared_qa_operation');
  const scrollContents = webContents.getAllWebContents().find((candidate) => candidate.getURL().startsWith(`http://127.0.0.1:${pagePort}`));
  if (scrollContents === undefined || await scrollContents.executeJavaScript('scrollY') as number <= 0) throw new Error('wheel scrolling did not move the page');
  const collisionSnapshot = await controller.snapshot('ws_browser', started.sessionId, 12, 500);
  const collisionHover = collisionSnapshot.nodes.find((node) => node['role'] === 'button' && node['name'] === 'Hover target')?.['elementRef'];
  let interactionConflict = false;
  try {
    await controller.hover('ws_browser', started.sessionId, collisionSnapshot.snapshotId, String(collisionHover), 'shared_qa_operation');
  } catch (error) {
    interactionConflict = error instanceof Error && 'code' in error && error.code === 'IDEMPOTENCY_CONFLICT';
  }
  if (!interactionConflict) throw new Error('cross-action operationId collision was accepted');
  await controller.scroll('ws_browser', started.sessionId, 'up', 700, 'scroll_reset');
  stage('scroll-qa-passed');

  const dragSnapshot = await controller.snapshot('ws_browser', started.sessionId, 12, 500);
  const dragSource = dragSnapshot.nodes.find((node) => node['name'] === 'Drag source')?.['elementRef'];
  const dragTarget = dragSnapshot.nodes.find((node) => node['name'] === 'Drag target')?.['elementRef'];
  if (typeof dragSource !== 'string' || typeof dragTarget !== 'string') throw new Error('drag references missing');
  await controller.drag('ws_browser', started.sessionId, dragSnapshot.snapshotId, dragSource, dragTarget, 'drag_qa');
  await controller.assert('ws_browser', started.sessionId, { kind: 'text', value: 'Dragged', state: 'present' });
  stage('drag-qa-passed');

  const dialogSnapshot = await controller.snapshot('ws_browser', started.sessionId, 12, 500);
  const dialogButton = dialogSnapshot.nodes.find((node) => node['name'] === 'Open dialog')?.['elementRef'];
  if (typeof dialogButton !== 'string') throw new Error('dialog button reference missing');
  await controller.click('ws_browser', started.sessionId, dialogSnapshot.snapshotId, dialogButton, 'dialog_open');
  await controller.assert('ws_browser', started.sessionId, { kind: 'dialog', state: 'open' });
  await controller.dialog('ws_browser', started.sessionId, 'dismiss', 'dialog_dismiss');
  await controller.assert('ws_browser', started.sessionId, { kind: 'dialog', state: 'closed' });
  stage('typed-qa-passed');
  const settledScreenshotStartedAt = Date.now();
  const screenshot = await controller.screenshot('ws_browser', started.sessionId, 150);
  if (Date.now() - settledScreenshotStartedAt < 130) throw new Error('screenshot ignored settleMs');
  stage('screenshot');
  if (Buffer.from(screenshot.dataBase64, 'base64').length < 1000) throw new Error('screenshot is unexpectedly empty');
  const savedScreenshot = await controller.saveScreenshot('ws_browser', started.sessionId, 'evidence/local.png', 'save_local_1');
  const savedScreenshotReplay = await controller.saveScreenshot('ws_browser', started.sessionId, 'evidence/local.png', 'save_local_1');
  if (savedBrowserEvidence !== 1 || savedScreenshot.mimeType !== 'image/png' || savedScreenshot.width !== 980 || savedScreenshot.height !== 680 ||
      JSON.stringify(savedScreenshotReplay) !== JSON.stringify(savedScreenshot)) {
    throw new Error('browser.screenshot.save no guardó una sola captura PNG verificable');
  }
  const preflightActionSnapshot = await controller.snapshot('ws_browser', started.sessionId, 12, 500);
  const preflightToastRef = preflightActionSnapshot.nodes.find((node) => node['name'] === 'Show toast')?.['elementRef'];
  if (typeof preflightToastRef !== 'string') throw new Error('toast action reference missing');
  let actionPreflightRejected = false;
  try {
    await controller.actionCapture('ws_browser', started.sessionId, preflightActionSnapshot.snapshotId, preflightToastRef,
      { kind: 'click' }, { kind: 'delay', settleMs: 50 }, { kind: 'save', workspaceId: 'ws_browser', path: 'evidence/preflight-fail.png' }, 'action_preflight_fail');
  } catch (error) {
    actionPreflightRejected = error instanceof Error && 'code' in error && error.code === 'FILE_ALREADY_EXISTS';
  }
  const clicksAfterPreflight = await stableContents.executeJavaScript('window.__toastClicks', true) as number;
  if (!actionPreflightRejected || clicksAfterPreflight !== 0) {
    throw new Error(`action.capture clicked before destination preflight succeeded: ${JSON.stringify({ actionPreflightRejected, clicksAfterPreflight })}`);
  }
  const actionSnapshot = await controller.snapshot('ws_browser', started.sessionId, 12, 500);
  const toastRef = actionSnapshot.nodes.find((node) => node['name'] === 'Show toast')?.['elementRef'];
  if (typeof toastRef !== 'string') throw new Error('toast action reference missing after preflight');
  const actionArgs = ['ws_browser', started.sessionId, actionSnapshot.snapshotId, toastRef,
    { kind: 'click' as const }, { kind: 'delay' as const, settleMs: 180 }, { kind: 'inline' as const }, 'action_capture_once'] as const;
  const [actionCapture, actionCaptureConcurrent] = await Promise.all([
    controller.actionCapture(...actionArgs), controller.actionCapture(...actionArgs),
  ]);
  if (JSON.stringify(actionCapture) !== JSON.stringify(actionCaptureConcurrent) || actionCapture.captureState !== 'complete' ||
      typeof actionCapture.dataBase64 !== 'string' || await stableContents.executeJavaScript('window.__toastClicks', true) !== 1 ||
      await stableContents.executeJavaScript("document.querySelector('#toast-state').textContent", true) !== 'Toast visible') {
    throw new Error('action.capture did not coalesce or preserve the five-second toast evidence');
  }
  const diskActionSnapshot = await controller.snapshot('ws_browser', started.sessionId, 12, 500);
  const diskToastRef = diskActionSnapshot.nodes.find((node) => node['name'] === 'Show toast')?.['elementRef'];
  if (typeof diskToastRef !== 'string') throw new Error('disk failure toast reference missing');
  const diskFailure = await controller.actionCapture('ws_browser', started.sessionId, diskActionSnapshot.snapshotId, diskToastRef,
    { kind: 'click' }, { kind: 'delay', settleMs: 20 }, { kind: 'save', workspaceId: 'ws_browser', path: 'evidence/disk-fail.png' }, 'action_disk_fail');
  const diskFailureReplay = await controller.actionCapture('ws_browser', started.sessionId, diskActionSnapshot.snapshotId, diskToastRef,
    { kind: 'click' }, { kind: 'delay', settleMs: 20 }, { kind: 'save', workspaceId: 'ws_browser', path: 'evidence/disk-fail.png' }, 'action_disk_fail');
  if (diskFailure.captureState !== 'failed' || diskFailure.failureCode !== 'INTERNAL_ERROR' || JSON.stringify(diskFailure) !== JSON.stringify(diskFailureReplay) ||
      await stableContents.executeJavaScript('window.__toastClicks', true) !== 2) throw new Error('failed action capture was replayed or hid its write failure');
  let toastEvidenceRuns = 0;
  for (let index = 0; index < 20; index += 1) {
    const toastSnapshot = await controller.snapshot('ws_browser', started.sessionId, 12, 500);
    const currentToastRef = toastSnapshot.nodes.find((node) => node['name'] === 'Show toast')?.['elementRef'];
    if (typeof currentToastRef !== 'string') throw new Error(`toast reference missing on run ${index + 1}`);
    const evidence = await controller.actionCapture(
      'ws_browser', started.sessionId, toastSnapshot.snapshotId, currentToastRef,
      { kind: 'click' }, { kind: 'delay', settleMs: 20 }, { kind: 'inline' }, `toast_evidence_${index}`,
    );
    const visible = await stableContents.executeJavaScript("document.querySelector('#toast-state').textContent", true);
    if (evidence.captureState !== 'complete' || typeof evidence.dataBase64 !== 'string' || visible !== 'Toast visible') {
      throw new Error(`five-second toast evidence missing on run ${index + 1}`);
    }
    toastEvidenceRuns += 1;
  }
  if (toastEvidenceRuns !== 20) throw new Error(`toast evidence completed ${toastEvidenceRuns}/20 runs`);
  const hoverCaptureSnapshot = await controller.snapshot('ws_browser', started.sessionId, 12, 500);
  const hoverCaptureRef = hoverCaptureSnapshot.nodes.find((node) => node['name'] === 'Hover target')?.['elementRef'];
  if (typeof hoverCaptureRef !== 'string') throw new Error('hover capture reference missing');
  const hoverCapture = await controller.actionCapture('ws_browser', started.sessionId, hoverCaptureSnapshot.snapshotId, hoverCaptureRef,
    { kind: 'hover' }, { kind: 'delay', settleMs: 20 }, { kind: 'inline' }, 'action_hover_capture');
  if (hoverCapture.captureState !== 'complete' || await stableContents.executeJavaScript("document.querySelector('#qa-state').textContent", true) !== 'Hovered') {
    throw new Error('hover action capture did not preserve tooltip evidence');
  }
  stage('action-capture-passed');
  const motionInspection = await controller.inspectMotion('ws_browser', started.sessionId, 100) as {
    capabilities?: { screencast?: boolean }; viewport?: { width?: number; height?: number };
    animations?: Array<{ source?: string }>; stickyCandidates?: unknown[];
  };
  if (motionInspection.viewport?.width !== 980 || motionInspection.viewport.height !== 680 || !motionInspection.capabilities?.screencast ||
      !motionInspection.animations?.some((item) => item.source === 'document-getAnimations') || (motionInspection.stickyCandidates?.length ?? 0) === 0) {
    throw new Error(`la inspección temporal no detectó el viewport o screencast de Electron: ${JSON.stringify(motionInspection)}`);
  }
  const motionCapture = await controller.captureMotion(
    'ws_browser', started.sessionId, 'evidence/local-scroll.lbmotion',
    { axis: 'y', startY: 0, distancePx: 500, durationMs: 500, sampleCount: 3 }, 0, 'auto', 'motion_local_1',
  );
  const motionReplay = await controller.captureMotion(
    'ws_browser', started.sessionId, 'evidence/local-scroll.lbmotion',
    { axis: 'y', startY: 0, distancePx: 500, durationMs: 500, sampleCount: 3 }, 0, 'auto', 'motion_local_1',
  );
  if (savedMotionBundles !== 1 || motionCapture.frameCount !== 3 || motionCapture.width !== 980 || motionCapture.height !== 680 ||
      JSON.stringify(motionReplay) !== JSON.stringify(motionCapture)) {
    throw new Error(`browser.motion.capture no produjo evidencia temporal idempotente: ${JSON.stringify(motionCapture)}`);
  }
  const cancelledMotion = controller.captureMotion(
    'ws_browser', started.sessionId, 'evidence/cancelled-scroll.lbmotion',
    { axis: 'y', startY: 0, distancePx: 400, durationMs: 2_000, sampleCount: 12 }, 0, 'stepped', 'motion_cancelled_1',
  );
  await new Promise((resolve) => setTimeout(resolve, 120));
  controller.cancelMotionLocally(started.sessionId);
  let cancellationClosed = false;
  try { await cancelledMotion; } catch (error) {
    cancellationClosed = error instanceof Error && 'code' in error && error.code === 'MOTION_EFFECT_UNCERTAIN';
  }
  if (!cancellationClosed || savedMotionBundles !== 1) throw new Error('cancelar una captura temporal no cerró ni limpió el staging');
  await controller.setViewport('ws_browser', started.sessionId, 1920, 1080, false, 'viewport_large_capture');
  const activeContents = webContents.getAllWebContents().find((candidate) => candidate.getURL().startsWith(`http://127.0.0.1:${pagePort}`));
  if (activeContents === undefined) throw new Error('browser contents missing for large capture');
  await activeContents.executeJavaScript(`(() => {
    document.body.innerHTML = '<canvas id="noise" width="1920" height="1080" style="display:block;width:1920px;height:1080px"></canvas>';
    const context = document.querySelector('#noise').getContext('2d');
    const image = context.createImageData(1920, 1080); let state = 0x12345678;
    for (let index = 0; index < image.data.length; index += 4) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      image.data[index] = state & 255; image.data[index + 1] = (state >>> 8) & 255; image.data[index + 2] = (state >>> 16) & 255; image.data[index + 3] = 255;
    }
    context.putImageData(image, 0, 0);
  })()`, true);
  const largeBrowserCapture = await controller.screenshot('ws_browser', started.sessionId);
  if (largeBrowserCapture.mimeType !== 'image/jpeg' || !largeBrowserCapture.fallbackUsed || largeBrowserCapture.width !== 1920 || largeBrowserCapture.height !== 1080) {
    throw new Error(`large browser capture did not use bounded JPEG fallback: ${largeBrowserCapture.mimeType} ${largeBrowserCapture.width}x${largeBrowserCapture.height}`);
  }
  await controller.setViewport('ws_browser', started.sessionId, 980, 680, false, 'viewport_after_large_capture');
  const navigated = await controller.navigate('ws_browser', started.sessionId, '/next', 'navigate_replay');
  const navigationReplay = await controller.navigate('ws_browser', started.sessionId, '/next', 'navigate_replay');
  if (JSON.stringify(navigationReplay) !== JSON.stringify(navigated)) throw new Error('navigation replay changed its result');
  let navigationConflict = false;
  try {
    await controller.navigate('ws_browser', started.sessionId, '/', 'navigate_replay');
  } catch (error) {
    navigationConflict = error instanceof Error && 'code' in error && error.code === 'IDEMPOTENCY_CONFLICT';
  }
  if (!navigationConflict) throw new Error('navigation operationId accepted another destination');
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
  await activeContents.executeJavaScript(`(() => {
    const root = { nested: { value: 3 }, huge: 9007199254740993n, error: new Error('fixture') };
    root.self = root;
    Object.defineProperty(root, 'danger', { enumerable: true, get() { throw new Error('getter must not run'); } });
    console.log('STRUCTURED_EVENT', root);
  })()`, true);
  let structuredEvents = await controller.events('ws_browser', started.sessionId, 0, 65_536, 'current-navigation');
  const structuredDeadline = Date.now() + 3_000;
  while (!structuredEvents.events.some((event) => event.type === 'console' && event.message.includes('STRUCTURED_EVENT')) && Date.now() < structuredDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    structuredEvents = await controller.events('ws_browser', started.sessionId, 0, 65_536, 'current-navigation');
  }
  const structured = structuredEvents.events.find((event) => event.type === 'console' && event.message.includes('STRUCTURED_EVENT'));
  const structuredText = JSON.stringify(structured);
  if (structured === undefined || !structuredText.includes('nested') || !structuredText.includes('9007199254740993n') ||
      !structuredText.includes('"kind":"accessor"') || !structuredText.includes('"kind":"reference"')) {
    throw new Error(`structured console arguments were not safely preserved: ${structuredText}`);
  }
  const historyBeforeReload = await controller.events('ws_browser', started.sessionId, 0, 65_536, 'history');
  if (structuredEvents.events.some((event) => event.navigationEpoch !== structuredEvents.navigationEpoch) ||
      !historyBeforeReload.events.some((event) => event.navigationEpoch < historyBeforeReload.navigationEpoch)) {
    throw new Error('navigation epoch filtering did not separate current document from history');
  }
  await activeContents.executeJavaScript("document.cookie='reload_auth=retained; SameSite=Lax';localStorage.setItem('reload_auth','retained')", true);
  reloadAssetVersion = 2;
  const beforeReloadViewport = (await controller.list('ws_browser')).find((item) => item.sessionId === started.sessionId)?.viewport;
  const reloaded = await controller.reload('ws_browser', started.sessionId, 'ignore-cache', 'reload_browser_1');
  const reloadReplay = await controller.reload('ws_browser', started.sessionId, 'ignore-cache', 'reload_browser_1');
  if (JSON.stringify(reloaded) !== JSON.stringify(reloadReplay)) throw new Error('browser.reload was not idempotent');
  let reloadConflict = false;
  try { await controller.reload('ws_browser', started.sessionId, 'normal', 'reload_browser_1'); }
  catch (error) { reloadConflict = error instanceof Error && 'code' in error && error.code === 'IDEMPOTENCY_CONFLICT'; }
  if (!reloadConflict) throw new Error('browser.reload operationId accepted another cache mode');
  const reloadState = await activeContents.executeJavaScript(`({
    resource: document.querySelector('#reload-version')?.textContent,
    cookie: document.cookie,
    local: localStorage.getItem('reload_auth')
  })`, true) as { resource?: string; cookie: string; local: string | null };
  const afterReloadViewport = (await controller.list('ws_browser')).find((item) => item.sessionId === started.sessionId)?.viewport;
  if (reloadState.resource !== 'Resource 2' || !reloadState.cookie.includes('reload_auth=retained') || reloadState.local !== 'retained' ||
      JSON.stringify(beforeReloadViewport) !== JSON.stringify(afterReloadViewport)) {
    throw new Error(`browser.reload did not preserve session/viewport or refresh resources: ${JSON.stringify({ reloadState, beforeReloadViewport, afterReloadViewport })}`);
  }
  await controller.navigate('ws_browser', started.sessionId, '/missing', 'navigate_404');
  await new Promise((resolve) => setTimeout(resolve, 100));
  const notFoundEvents = await controller.events('ws_browser', started.sessionId, 0, 65_536, 'current-navigation');
  if (!notFoundEvents.events.some((event) => event.type === 'network' && event.message === 'HTTP 404')) {
    throw new Error(`browser.events did not preserve a 404 response in the current navigation: ${JSON.stringify(notFoundEvents.events)}`);
  }
  await controller.navigate('ws_browser', started.sessionId, '/next', 'navigate_after_404');
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
  await liveProjectContents.executeJavaScript("document.getAnimations({subtree:true}).forEach((animation)=>animation.cancel())");
  await controller.setViewport('ws_browser', started.sessionId, 1920, 1080, false, 'viewer_full_hd');
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
  const fittedBounds = liveWindow.getBounds();
  const fittedContent = liveProjectContents.getOwnerBrowserWindow() === liveWindow
    ? (controller as unknown as { entries: Map<string, { content: WebContentsView }> }).entries.get(started.sessionId)?.content.getBounds()
    : undefined;
  const viewerScreenshot = await controller.screenshot('ws_browser', started.sessionId);
  if (fittedBounds.width >= 1920 || fittedBounds.height !== firstWorkArea.height || fittedContent === undefined ||
      Math.abs(fittedContent.width / fittedContent.height - 16 / 9) > 0.01 ||
      viewerScreenshot.width !== 1920 || viewerScreenshot.height !== 1080) {
    throw new Error(`el visor local no encajó 1920x1080 sin alterar la evidencia: ${JSON.stringify({ fittedBounds, fittedContent, screenshot: [viewerScreenshot.width, viewerScreenshot.height] })}`);
  }
  const fitHash = createHash('sha256').update(Buffer.from(viewerScreenshot.dataBase64, 'base64')).digest('hex');
  await controller.setLiveViewerPresentationLocally(started.sessionId, 'actual', 500, 200);
  const actualSummary = (await controller.list('ws_browser')).find((item) => item.sessionId === started.sessionId)?.viewerPresentation;
  const actualScreenshot = await controller.screenshot('ws_browser', started.sessionId);
  const actualHash = createHash('sha256').update(Buffer.from(actualScreenshot.dataBase64, 'base64')).digest('hex');
  const actualContent = (controller as unknown as { entries: Map<string, { content: WebContentsView }> }).entries.get(started.sessionId)?.content.getBounds();
  if (actualSummary?.mode !== 'actual' || actualSummary.scale !== 1 || actualSummary.panX <= 0 || actualSummary.panY <= 0 ||
      actualContent === undefined || actualContent.x >= 0 || actualContent.y >= 0 || fitHash !== actualHash) {
    throw new Error(`el modo 1:1 alteró el render, no aplicó pan local o cambió la captura: ${JSON.stringify({ actualSummary, actualContent, fitHash, actualHash })}`);
  }
  await controller.setLiveViewerPresentationLocally(started.sessionId, 'fit');
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
  if (afterMoveBounds.x < secondWorkArea.x || afterMoveBounds.y < secondWorkArea.y ||
      afterMoveBounds.x + afterMoveBounds.width > secondWorkArea.x + secondWorkArea.width ||
      afterMoveBounds.y + afterMoveBounds.height > secondWorkArea.y + secondWorkArea.height) {
    throw new Error('moving live view did not fit the destination work area');
  }
  const viewportAfterViewerMove = (await controller.list('ws_browser')).find((item) => item.sessionId === started.sessionId)?.viewport;
  if (viewportAfterViewerMove?.width !== 1920 || viewportAfterViewerMove.height !== 1080 || viewportAfterViewerMove.mobile) {
    throw new Error('moving or fitting the live viewer changed the logical viewport');
  }
  if (liveProjectContents.id !== originalContentsId || liveProjectContents.getURL() !== urlBeforeMove) throw new Error('moving live view replaced or navigated the controlled page');
  if (liveWindow.isFocusable()) throw new Error('moving live view enabled focus');
  const movedSnapshot = await controller.snapshot('ws_browser', started.sessionId, 12, 500);
  if (!movedSnapshot.nodes.some((node) => node['name'] === 'Next page')) throw new Error('agent control stopped after moving live view');
  await controller.hideLiveViewerLocally(started.sessionId);
  if (controller.getLocalLiveViewerSessionId() !== undefined) throw new Error('live view state survived explicit hide');
  const [hiddenX, hiddenY] = liveWindow.getPosition();
  if (hiddenX > -9_000 || hiddenY > -9_000) throw new Error('hidden live view remained on-screen');
  await controller.setViewport('ws_browser', started.sessionId, 980, 680, false, 'viewer_restore_compact');
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
  const restoredViewport = (await controller.list('ws_browser')).find((item) => item.sessionId === started.sessionId)?.viewport;
  if (restoredViewport?.width !== 980 || restoredViewport.height !== 680 || restoredViewport.mobile) {
    throw new Error('human handoff did not restore the viewport selected for agent QA');
  }
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
  const failedDialog = await controller.start('ws_browser', 'app', 'browser_start_failed_dialog');
  await controller.requestHumanControl('ws_browser', failedDialog.sessionId, 'manual_step', 'human_failed_dialog');
  await controller.openHumanControlLocally(failedDialog.sessionId);
  handoffConfirmation = async () => { throw new Error('fixture dialog failure'); };
  let failedDialogClosed = false;
  try {
    await controller.completeHumanControlLocally(failedDialog.sessionId);
  } catch (error) {
    failedDialogClosed = error instanceof Error && 'code' in error && error.code === 'INTERNAL_ERROR';
  } finally {
    handoffConfirmation = async () => true;
  }
  if (!failedDialogClosed || (await controller.list('ws_browser')).find((entry) => entry.sessionId === failedDialog.sessionId)?.state !== 'stopped') {
    throw new Error('un fallo del diálogo dejó control humano o la sesión activos');
  }
  stage('handoff-dialog-failure-closed');
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
  if (projectBrowser.viewport.width !== 1920 || projectBrowser.viewport.height !== 1080 || projectBrowser.viewport.mobile) {
    throw new Error('el navegador de proyecto no inició con la resolución de prueba 1920x1080');
  }
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
  if (dynamic.viewport.width !== 1920 || dynamic.viewport.height !== 1080 || dynamic.viewport.mobile) {
    throw new Error('el navegador de proceso no inició con la resolución de prueba 1920x1080');
  }
  dynamicListenerAllowed = false;
  let dynamicRequestBlocked = false;
  try {
    await controller.reload('ws_browser', dynamic.sessionId, 'normal', 'reload_listener_lost');
  } catch (error) {
    dynamicRequestBlocked = error instanceof Error && 'code' in error && error.code === 'LISTENER_NOT_FOUND';
  }
  if (!dynamicRequestBlocked) throw new Error('browser.reload survived listener ownership loss');
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
    defaultProjectViewport1920x1080: true,
    customViewportSupported: viewport.width === 980 && viewport.height === 680 && !viewport.mobile,
    losslessBrowserEvidenceSaved: true,
    motionInspectAndCapture: true,
    fullLogicalViewportFittedInViewer: true,
    largeBrowserCaptureTransportFallback: true,
    viewportRestoredAfterHuman: true,
    idempotent: true,
    accessibilityNodes: snapshot.nodes.length,
    screenshotBytes: Buffer.from(screenshot.dataBase64, 'base64').length,
    consoleCaptured: true,
    structuredConsoleArguments: true,
    navigationEpochFiltering: true,
    browserCapacityLimit: true,
    reloadPreservesStorageViewportAndRefreshesResources: true,
    reloadRevalidatesListener: true,
    sameOriginWebSocketAllowed: true,
    externalOriginBlocked: true,
    externalWebSocketBlocked: true,
    navigation: true,
    controlledInteraction: true,
    typedWaitsAndAssertions: true,
    toastEvidenceRuns,
    pointerHitTesting: true,
    hoverScrollSelectDragDialog: true,
    interactionIdempotencyConflict: true,
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
    liveViewerFitsWorkArea: true,
    liveViewerMovedWithoutNavigation: true,
    liveViewerMoveAgentControlPreserved: true,
    signInReasonSupported: true,
    repeatedHumanControlPreservedSession: true,
    listingBlockedDuringHumanControl: true,
    oneHumanSessionAtATime: true,
    humanCrossOriginRedirectBlocked: true,
    handoffRaceClosed: true,
    failedHandoffDialogClosed: true,
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
