const { app, BrowserWindow, session } = require('electron');
const http = require('node:http');
const { randomBytes } = require('node:crypto');

const pagePort = 47_832;
const blockedPort = 47_833;

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

async function main() {
  let blockedRequests = 0;
  const blockedServer = http.createServer((_request, response) => {
    blockedRequests += 1;
    response.end('should-not-be-reached');
  });
  const pageServer = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html>
      <html><body>
        <h1>LocalBridge browser spike</h1>
        <label>Mensaje <input aria-label="Mensaje" /></label>
        <button type="button">Aplicar</button>
        <output aria-live="polite"></output>
        <img src="http://127.0.0.1:${blockedPort}/blocked.png" />
        <script>
          console.error('SPIKE_CONSOLE_ERROR');
          document.querySelector('button').addEventListener('click', () => {
            document.querySelector('output').textContent = document.querySelector('input').value;
          });
        </script>
      </body></html>`);
  });

  await Promise.all([listen(pageServer, pagePort), listen(blockedServer, blockedPort)]);
  const allowedOrigin = `http://127.0.0.1:${pagePort}`;
  const partition = `localbridge-spike-${randomBytes(8).toString('hex')}`;
  const isolatedSession = session.fromPartition(partition, { cache: false });
  isolatedSession.setPermissionCheckHandler(() => false);
  isolatedSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  isolatedSession.webRequest.onBeforeRequest((details, callback) => {
    let allowed = false;
    try {
      const url = new URL(details.url);
      allowed = url.origin === allowedOrigin || url.protocol === 'data:' || url.protocol === 'blob:';
    } catch {
      allowed = false;
    }
    callback({ cancel: !allowed });
  });

  const window = new BrowserWindow({
    show: false,
    width: 900,
    height: 640,
    webPreferences: {
      partition,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      offscreen: true,
      preload: undefined,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  const consoleMessages = [];
  window.webContents.on('console-message', (details) => consoleMessages.push(details.message));
  window.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(allowedOrigin)) event.preventDefault();
  });

  try {
    await window.loadURL(`${allowedOrigin}/`);
    window.webContents.debugger.attach('1.3');
    await window.webContents.debugger.sendCommand('Accessibility.enable');
    await window.webContents.debugger.sendCommand('DOM.enable');
    const tree = await window.webContents.debugger.sendCommand('Accessibility.getFullAXTree');
    const roles = new Set(tree.nodes.map((node) => node.role?.value).filter(Boolean));
    if (!roles.has('button') || !roles.has('textbox')) throw new Error('Accessibility tree incomplete');

    const { root } = await window.webContents.debugger.sendCommand('DOM.getDocument', { depth: -1, pierce: true });
    const input = await window.webContents.debugger.sendCommand('DOM.querySelector', { nodeId: root.nodeId, selector: 'input' });
    const button = await window.webContents.debugger.sendCommand('DOM.querySelector', { nodeId: root.nodeId, selector: 'button' });
    await window.webContents.debugger.sendCommand('DOM.focus', { nodeId: input.nodeId });
    await window.webContents.debugger.sendCommand('Input.insertText', { text: 'hola-controlada' });
    const box = await window.webContents.debugger.sendCommand('DOM.getBoxModel', { nodeId: button.nodeId });
    const [x1, y1, x2, , , y3] = box.model.border;
    const x = (x1 + x2) / 2;
    const y = (y1 + y3) / 2;
    await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });

    await new Promise((resolve) => setTimeout(resolve, 100));

    const updatedTree = await window.webContents.debugger.sendCommand('Accessibility.getFullAXTree');
    const names = updatedTree.nodes.map((node) => node.name?.value).filter(Boolean);
    if (!names.includes('hola-controlada')) throw new Error('Controlled interaction did not update the page');
    const screenshot = await window.webContents.capturePage();
    const png = screenshot.toPNG();
    if (png.length < 1000) throw new Error('Screenshot is unexpectedly empty');
    if (!consoleMessages.includes('SPIKE_CONSOLE_ERROR')) throw new Error('Console event was not observed');
    if (blockedRequests !== 0) throw new Error('A blocked origin received network traffic');

    process.stdout.write(`${JSON.stringify({
      isolatedPartition: !partition.startsWith('persist:'),
      accessibilityNodes: tree.nodes.length,
      screenshotBytes: png.length,
      consoleCaptured: true,
      externalOriginBlocked: true,
      controlledInteraction: true,
    })}\n`);
  } finally {
    if (window.webContents.debugger.isAttached()) window.webContents.debugger.detach();
    window.destroy();
    await Promise.all([close(pageServer), close(blockedServer)]);
  }
}

app.whenReady()
  .then(main)
  .then(() => app.exit(0))
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ''}` : String(error)}\n`);
    app.exit(1);
  });
