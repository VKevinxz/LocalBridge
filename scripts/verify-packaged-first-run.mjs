const port = Number.parseInt(process.argv[2] ?? '', 10);
const requestQuit = process.argv.includes('--quit');
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error('Expected the packaged desktop DevTools port.');
}

const deadline = Date.now() + 10_000;
let targets;
while (Date.now() < deadline) {
  try {
    targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
    if (Array.isArray(targets) && targets.some((target) => target.type === 'page')) break;
  } catch {
    // El renderer puede seguir cargando; se reintenta dentro del plazo acotado.
  }
  await new Promise((resolve) => setTimeout(resolve, 100));
}

const page = Array.isArray(targets) ? targets.find((target) => target.type === 'page') : undefined;
if (typeof page?.webSocketDebuggerUrl !== 'string') {
  throw new Error('Packaged desktop did not expose its renderer target.');
}

const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error('Timed out connecting to the packaged renderer.')), 5_000);
  socket.addEventListener('open', () => { clearTimeout(timeout); resolve(); }, { once: true });
  socket.addEventListener('error', () => { clearTimeout(timeout); reject(new Error('Could not connect to the packaged renderer.')); }, { once: true });
});

let sequence = 0;
function request(method, params) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${method}.`)), 10_000);
    const onMessage = (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id !== id) return;
      clearTimeout(timeout);
      socket.removeEventListener('message', onMessage);
      if (message.error !== undefined) reject(new Error(JSON.stringify(message.error)));
      else resolve(message.result);
    };
    socket.addEventListener('message', onMessage);
    socket.send(JSON.stringify({ id, method, params }));
  });
}

try {
  let value;
  const renderDeadline = Date.now() + 10_000;
  while (Date.now() < renderDeadline) {
    const evaluation = await request('Runtime.evaluate', {
      expression: `(async () => {
      const onboarding = await window.desktop.getOnboardingSnapshot();
      const webProfiles = await window.desktop.getWebProfiles();
      const savedKey = await window.desktop.getSavedTunnelKey();
      return {
        bodyText: document.body.innerText,
        status: onboarding.state.status,
        effectiveStep: onboarding.effectiveStep,
        webProfilesContract: webProfiles !== null
          && typeof webProfiles === 'object'
          && typeof webProfiles.state === 'string'
          && Array.isArray(webProfiles.document?.profiles),
        savedKeyContract: savedKey === undefined || typeof savedKey === 'string'
      };
      })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    if (evaluation.exceptionDetails !== undefined) {
      throw new Error(`Renderer evaluation failed: ${evaluation.exceptionDetails.text}`);
    }
    value = evaluation.result?.value;
    if (typeof value?.bodyText === 'string' && value.bodyText.toLocaleLowerCase('es').includes('primera configuración')) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (typeof value?.bodyText !== 'string' || !value.bodyText.toLocaleLowerCase('es').includes('primera configuración')) {
    const visible = typeof value?.bodyText === 'string' ? value.bodyText.replaceAll(/\s+/g, ' ').slice(0, 240) : '';
    throw new Error(`A fresh profile did not render the first-run wizard (status=${String(value?.status)}, step=${String(value?.effectiveStep)}, visible=${JSON.stringify(visible)}).`);
  }
  if (value.status !== 'not_started' || value.effectiveStep !== 'welcome') {
    throw new Error(`Unexpected onboarding state: ${JSON.stringify(value)}`);
  }
  if (value.webProfilesContract !== true || value.savedKeyContract !== true) {
    throw new Error(`One or more startup IPC channels did not answer (${JSON.stringify({ webProfilesContract: value.webProfilesContract, savedKeyContract: value.savedKeyContract })}).`);
  }
  process.stdout.write("Packaged desktop first run passed: wizard='welcome', IPC ready.\n");
  if (requestQuit) {
    await request('Runtime.evaluate', {
      expression: "window.desktop.quitApp(); 'quit-requested'",
      returnByValue: true,
    });
  }
} finally {
  socket.close();
}
