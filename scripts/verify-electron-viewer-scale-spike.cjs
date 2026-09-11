const { app, BrowserWindow, WebContentsView } = require('electron');
const { mkdirSync, writeFileSync } = require('node:fs');
const { dirname, resolve } = require('node:path');
const { tmpdir } = require('node:os');

app.setPath('userData', resolve(tmpdir(), `localbridge-viewer-scale-${process.pid}`));

function pngDimensions(bytes) {
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

async function cdpCapture(contents) {
  const result = await contents.debugger.sendCommand('Page.captureScreenshot', {
    format: 'png', fromSurface: true, captureBeyondViewport: false,
  });
  return pngDimensions(Buffer.from(result.data, 'base64'));
}

async function main() {
  const reportPath = resolve('dist/viewer-scale-spike.json');
  const stage = (value) => {
    mkdirSync(dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, `${JSON.stringify({ stage: value }, null, 2)}\n`);
  };
  stage('creating-window');
  const window = new BrowserWindow({
    show: false,
    width: 1600,
    height: 1000,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
  });
  const view = new WebContentsView({ webPreferences: {
    nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false,
  } });
  window.contentView.addChildView(view);
  view.setBounds({ x: 0, y: 104, width: 1600, height: 896 });
  window.setPosition(-10_000, -10_000, false);
  window.showInactive();
  stage('loading');
  await view.webContents.loadURL(`data:text/html,${encodeURIComponent(`<!doctype html><style>
    html,body{margin:0;width:100%;height:100%;background:linear-gradient(90deg,#f00 0 50%,#00f 50%)}
    body:after{content:'RIGHT EDGE';position:fixed;right:0;bottom:0;color:white;font:40px sans-serif}
  </style>`)}`);
  view.webContents.debugger.attach('1.3');
  stage('baseline');
  await view.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride', {
    width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false,
  });
  const baselineMetrics = await view.webContents.debugger.sendCommand('Runtime.evaluate', {
    expression: '({innerWidth,innerHeight,devicePixelRatio})', returnByValue: true,
  });
  const baselineCdp = await cdpCapture(view.webContents);
  const baselineView = pngDimensions((await view.webContents.capturePage()).toPNG());
  await view.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride', {
    width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false, scale: 0.8,
  });
  const scaledMetrics = await view.webContents.debugger.sendCommand('Runtime.evaluate', {
    expression: '({innerWidth,innerHeight,devicePixelRatio})', returnByValue: true,
  });
  const scaledCdp = await cdpCapture(view.webContents);
  const scaledView = pngDimensions((await view.webContents.capturePage()).toPNG());
  const report = {
    electron: process.versions.electron,
    baselineMetrics: baselineMetrics.result.value,
    baselineCdp,
    baselineView,
    scaledMetrics: scaledMetrics.result.value,
    scaledCdp,
    scaledView,
  };
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report)}\n`);
  view.webContents.debugger.detach();
  window.contentView.removeChildView(view);
  view.webContents.close();
  window.destroy();
}

app.whenReady().then(main).then(() => app.exit(0)).catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  app.exit(1);
});
