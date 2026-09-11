import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { ProcessSupervisor } from '@localbridge/development';
import type { AuthorizedWorkspace } from '@localbridge/workspace';

async function allocateAvailablePort(host: string): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, host, resolve);
  });
  const address = probe.address();
  if (!address || typeof address === 'string') {
    probe.close();
    throw new Error('temporary port probe did not expose a TCP port');
  }
  const selectedPort = address.port;
  await new Promise<void>((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  return selectedPort;
}

const externalServer = net.createServer();
await new Promise<void>((resolve, reject) => {
  externalServer.once('error', reject);
  externalServer.listen(0, '127.0.0.1', resolve);
});
const externalAddress = externalServer.address();
if (!externalAddress || typeof externalAddress === 'string') {
  throw new Error('external listener did not expose a TCP port');
}
const externalPort = externalAddress.port;
const selectedPorts = new Set<number>([externalPort]);
async function allocateDistinctPort(host: string): Promise<number> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const candidate = await allocateAvailablePort(host);
    if (!selectedPorts.has(candidate)) {
      selectedPorts.add(candidate);
      return candidate;
    }
  }
  throw new Error('could not allocate a distinct temporary TCP port');
}
const port = await allocateDistinctPort('127.0.0.1');
const wildcardPort = await allocateDistinctPort('0.0.0.0');
const forgedPort = await allocateDistinctPort('127.0.0.1');
const helperPath = process.env['LOCALBRIDGE_PROCESS_HELPER_BINARY'] ?? path.resolve('apps/desktop/vendor/process-host/localbridge-process-host.exe');
const nodeBinaryPath = process.env['LOCALBRIDGE_PROCESS_NODE_BINARY'] ?? process.execPath;
const rootPath = await mkdtemp(path.join(os.tmpdir(), 'localbridge-process-supervisor-'));
const definition = 'node managed process';
await writeFile(path.join(rootPath, 'package.json'), JSON.stringify({ scripts: { dev: definition } }));

const grandchild = `const net=require('node:net');const loopback=net.createServer();const wildcard=net.createServer();loopback.listen(${port},'127.0.0.1',()=>console.log('GRANDCHILD_READY'));wildcard.listen(${wildcardPort},'0.0.0.0',()=>console.log('WILDCARD_READY'));setInterval(()=>{},1000);`;
const target = `const {spawn}=require('node:child_process');const fs=require('node:fs');try{fs.writeSync(3,'LBP1 1 4:${forgedPort}\\n');console.log('CONTROL_FD_INHERITED')}catch{console.log('CONTROL_FD_BLOCKED')}const child=spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:'inherit'});console.log('TARGET_READY http://127.0.0.1:${externalPort}');child.on('exit',()=>process.exit());setInterval(()=>{},1000);`;
let processesAllowed = true;
const workspace = (): AuthorizedWorkspace => ({
  id: 'ws_supervisor',
  name: 'Supervisor',
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
    processes: processesAllowed,
  },
  limits: { maxFileBytes: 1024, maxTreeEntries: 30, maxTreeDepth: 2 },
  denyPatterns: ['.env'],
  validationProfiles: {},
  processProfiles: {
    dev: {
      command: [process.execPath, '-e', target],
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
});

function canConnect(targetPort = port): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port: targetPort });
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
    socket.setTimeout(500, () => { socket.destroy(); resolve(false); });
  });
}

async function waitForListener(processId: string) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const result = await supervisor.listeners('ws_supervisor', processId);
    if (result.listeners.length > 0) return result.listeners;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('verified listener did not appear');
}

async function waitFor(expected: boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await canConnect() === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`port ${port} did not become ${expected ? 'available' : 'closed'}`);
}

const supervisor = new ProcessSupervisor({
  helperPath,
  nodeBinaryPath,
  parentPid: process.pid,
  loadWorkspace: async (workspaceId) => workspaceId === 'ws_supervisor' ? workspace() : undefined,
});

try {
  const [started, reusedAcrossChat] = await Promise.all([
    supervisor.start('ws_supervisor', 'dev', 'operation_start_1'),
    supervisor.start('ws_supervisor', 'dev', 'operation_start_other_chat'),
  ]);
  if (started.processId !== reusedAcrossChat.processId) throw new Error('compatible concurrent starts created duplicate managed processes');
  const repeated = await supervisor.start('ws_supervisor', 'dev', 'operation_start_1');
  if (started.processId !== repeated.processId) throw new Error('start operation was not idempotent');
  await waitFor(true);
  const listeners = await waitForListener(started.processId);
  const loopbackListener = listeners.find((listener) => listener.origin === `http://127.0.0.1:${port}`);
  const wildcardListener = listeners.find((listener) => listener.origin === `http://localhost:${wildcardPort}`);
  if (listeners.length !== 2 || loopbackListener?.bindScope !== 'loopback' || !loopbackListener.exclusive ||
      wildcardListener?.bindScope !== 'wildcard' || !wildcardListener.exclusive) {
    throw new Error(`listener ownership filter failed: ${JSON.stringify(listeners)}`);
  }
  const resolved = await supervisor.resolveListener('ws_supervisor', started.processId, loopbackListener.listenerRef);
  if (resolved.origin !== `http://127.0.0.1:${port}`) throw new Error('listener ref resolved to another origin');
  const logs = await supervisor.logs('ws_supervisor', started.processId, 0, 65_536);
  if (!logs.entries.some((entry) => entry.text.includes('TARGET_READY'))) throw new Error('target output missing');
  if (!logs.entries.some((entry) => entry.text.includes('CONTROL_FD_BLOCKED'))) throw new Error('control fd reached the project process');
  await supervisor.stop('ws_supervisor', started.processId);
  await waitFor(false);
  let staleListenerRejected = false;
  try {
    await supervisor.resolveListener('ws_supervisor', started.processId, listeners[0].listenerRef);
  } catch (error) {
    staleListenerRejected = error instanceof Error && 'code' in error && error.code === 'PROCESS_NOT_FOUND';
  }
  if (!staleListenerRejected) throw new Error('stale listener ref remained valid');
  const restarted = await supervisor.start('ws_supervisor', 'dev', 'operation_start_2');
  await waitFor(true);
  processesAllowed = false;
  await supervisor.reconcile();
  await waitFor(false);
  let revoked = false;
  try {
    await supervisor.list('ws_supervisor');
  } catch (error) {
    revoked = error instanceof Error && 'code' in error && error.code === 'CAPABILITY_DISABLED';
  }
  if (!revoked) throw new Error('permission revocation did not take effect');
  process.stdout.write(`${JSON.stringify({ processId: started.processId, restartedProcessId: restarted.processId, idempotent: true, reusedAcrossChat: true, concurrentStartSerialized: true, logs: true, treeStopped: true, verifiedLoopbackListener: true, verifiedManagedWildcard: true, foreignListenerRejected: true, forgedStdoutRejected: true, controlPipeNotInherited: true, staleListenerRejected: true, revocationImmediate: true })}\n`);
} finally {
  processesAllowed = true;
  await supervisor.close();
  await new Promise<void>((resolve) => externalServer.close(() => resolve()));
  await rm(rootPath, { recursive: true, force: true });
}
