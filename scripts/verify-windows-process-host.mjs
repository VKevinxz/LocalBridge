import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const helperPath = path.join(repoRoot, 'apps', 'desktop', 'vendor', 'process-host', 'localbridge-process-host.exe');
const testPort = 47_831;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function pidExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function portAcceptsConnections(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      socket.removeAllListeners();
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(250, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

async function waitUntil(predicate, description, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(100);
  }
  throw new Error(`Timeout esperando: ${description}`);
}

if (process.argv[2] === '--parent-test') {
  const serverCode = [
    "const net = require('node:net')",
    `const server = net.createServer((socket) => { socket.on('error', () => {}); socket.end('ok') }).listen(${testPort}, '127.0.0.1', () => console.log('SERVER_READY:' + process.pid))`,
    "setInterval(() => {}, 1000)",
  ].join(';');
  const targetCode = [
    "const { spawn } = require('node:child_process')",
    `const child = spawn(process.execPath, ['-e', ${JSON.stringify(serverCode)}], { stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true })`,
    "console.log('TARGET_READY:' + process.pid + ':' + child.pid)",
    "setInterval(() => {}, 1000)",
  ].join(';');
  const helper = spawn(
    helperPath,
    ['--parent', String(process.pid), '--', process.execPath, '-e', targetCode],
    { cwd: repoRoot, stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true },
  );
  process.stdout.write(`PARENT_READY:${process.pid}:${helper.pid}\n`);
  setInterval(() => {}, 1000);
} else {
  if (process.platform !== 'win32') throw new Error('Este verificador solo aplica a Windows.');

  const parent = spawn(process.execPath, [fileURLToPath(import.meta.url), '--parent-test'], {
    cwd: repoRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const lines = readline.createInterface({ input: parent.stdout });
  let parentPid;
  let helperPid;
  let targetPid;
  let serverPid;
  const stderr = [];
  parent.stderr.on('data', (chunk) => stderr.push(chunk.toString('utf8')));
  lines.on('line', (line) => {
    if (line.startsWith('PARENT_READY:')) [, parentPid, helperPid] = line.split(':').map(Number);
    if (line.startsWith('TARGET_READY:')) [, targetPid, serverPid] = line.split(':').map(Number);
  });

  try {
    await waitUntil(() => parentPid !== undefined && helperPid !== undefined && targetPid !== undefined && serverPid !== undefined, 'PIDs del árbol');
    await waitUntil(() => portAcceptsConnections(testPort), 'puerto del nieto');

    const killed = spawnSync('taskkill.exe', ['/PID', String(parentPid), '/F'], { windowsHide: true, encoding: 'utf8' });
    if (killed.status !== 0) throw new Error(`taskkill del padre falló: ${killed.stderr}`);

    await waitUntil(
      async () => !pidExists(helperPid) && !pidExists(targetPid) && !pidExists(serverPid) && !(await portAcceptsConnections(testPort)),
      'cierre del helper, objetivo, nieto y puerto',
    );
    process.stdout.write(`${JSON.stringify({ parentPid, helperPid, targetPid, serverPid, port: testPort, killOnParentExit: true })}\n`);
  } finally {
    for (const pid of [parentPid, helperPid, targetPid, serverPid]) {
      if (pid !== undefined && pidExists(pid)) spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
    }
    lines.close();
    if (stderr.length > 0) process.stderr.write(stderr.join(''));
  }
}
