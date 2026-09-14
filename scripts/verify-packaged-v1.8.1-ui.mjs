const port = Number.parseInt(process.argv[2] ?? '', 10);
if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('Expected the packaged desktop DevTools port.');

const deadline = Date.now() + 10_000;
let targets;
while (Date.now() < deadline) {
  try {
    // eslint-disable-next-line no-await-in-loop -- DevTools readiness must be polled sequentially.
    targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
    if (Array.isArray(targets) && targets.some((target) => target.type === 'page')) break;
  } catch {}
  // eslint-disable-next-line no-await-in-loop -- Keep one bounded probe in flight at a time.
  await new Promise((resolve) => setTimeout(resolve, 100));
}
const page = Array.isArray(targets) ? targets.find((target) => target.type === 'page') : undefined;
if (typeof page?.webSocketDebuggerUrl !== 'string') throw new Error('Packaged desktop renderer was not exposed.');

const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error('Timed out connecting to renderer.')), 5_000);
  socket.addEventListener('open', () => { clearTimeout(timeout); resolve(); }, { once: true });
  socket.addEventListener('error', () => { clearTimeout(timeout); reject(new Error('Renderer connection failed.')); }, { once: true });
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

async function evaluate(expression) {
  const result = await request('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails !== undefined) throw new Error(`Renderer evaluation failed: ${result.exceptionDetails.text}`);
  return result.result?.value;
}

try {
  let ready = false;
  for (let attempt = 0; attempt < 100 && !ready; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop -- Renderer readiness is inherently sequential.
    ready = await evaluate("document.querySelector('#nav-activity') !== null");
    // eslint-disable-next-line no-await-in-loop -- Keep one bounded probe in flight at a time.
    if (!ready) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!ready) throw new Error('Completed desktop UI did not render.');

  const initial = await evaluate(`(() => {
    document.querySelector('#nav-activity').click();
    const ids = ['runtime', 'technicalLog', 'documents', 'audit'];
    return {
      hidden: ids.map((id) => document.querySelector('#activity-' + (id === 'technicalLog' ? 'technical-log' : id) + '-panel')?.hidden),
      aria: ids.map((id) => document.querySelector('#activity-toggle-' + id)?.getAttribute('aria-expanded')),
      secretState: window.desktop.getTunnelKeyState instanceof Function,
      legacySecretGetter: 'getSavedTunnelKey' in window.desktop,
    };
  })()`);
  if (JSON.stringify(initial.hidden) !== JSON.stringify([true, true, true, true])) throw new Error(`Unexpected initial disclosure: ${JSON.stringify(initial)}`);
  if (initial.aria.some((value) => value !== 'false') || initial.secretState !== true || initial.legacySecretGetter !== false) {
    throw new Error(`Unexpected accessibility or IPC contract: ${JSON.stringify(initial)}`);
  }

  const toggled = await evaluate(`(() => {
    const button = document.querySelector('#activity-toggle-runtime');
    button.focus();
    button.click();
    const stored = JSON.parse(localStorage.getItem('localbridge.activityDisclosure.v1'));
    return {
      expanded: document.querySelector('#activity-toggle-runtime')?.getAttribute('aria-expanded'),
      hidden: document.querySelector('#activity-runtime-panel')?.hidden,
      focused: document.activeElement?.id,
      stored,
      keys: Object.keys(stored),
    };
  })()`);
  if (toggled.expanded !== 'true' || toggled.hidden !== false || toggled.focused !== 'activity-toggle-runtime') {
    throw new Error(`Toggle failed: ${JSON.stringify(toggled)}`);
  }
  if (JSON.stringify(toggled.keys.toSorted()) !== JSON.stringify(['audit', 'documents', 'runtime', 'technicalLog'].toSorted())) {
    throw new Error(`Activity preferences contain unexpected data: ${JSON.stringify(toggled.stored)}`);
  }

  await evaluate("location.reload(); 'reload-requested'");
  let restored = false;
  for (let attempt = 0; attempt < 100 && !restored; attempt += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop -- Reload completion is inherently sequential.
      restored = await evaluate(`(() => {
        const nav = document.querySelector('#nav-activity');
        if (nav === null) return false;
        nav.click();
        return document.querySelector('#activity-runtime-panel')?.hidden === false
          && document.querySelector('#activity-toggle-runtime')?.getAttribute('aria-expanded') === 'true';
      })()`);
    } catch {}
    // eslint-disable-next-line no-await-in-loop -- Keep one bounded probe in flight at a time.
    if (!restored) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!restored) throw new Error('Activity disclosure preference did not survive renderer reload.');
  process.stdout.write('Packaged 1.8.1 UI verification passed: disclosure, ARIA, focus, persistence and secret boundary.\n');
  await evaluate("window.desktop.quitApp(); 'quit-requested'");
} finally {
  socket.close();
}
