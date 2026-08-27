import { describe, expect, it } from 'vitest';

import { ApplicationSupervisor, DevelopmentBrokerError, type ProcessSupervisor } from '@localbridge/development';
import type { LocalApplication, WorkspaceRegistry } from '@localbridge/workspace';
import { buildWorkspace } from '../helpers/fixtures.js';

const profile = {
  command: ['npm', 'run', 'dev'], cwd: '.',
  source: { kind: 'package-script' as const, manifestPath: 'package.json' as const, script: 'dev', definitionSha256: 'a'.repeat(64) },
  maxRuntimeSeconds: 300,
};

function application(id = 'app_aaaaaaaaaaaaaaaaaaaaaaaa'): LocalApplication {
  return {
    id, name: id.endsWith('a') ? 'CIP local' : 'Otra', description: '',
    primaryServiceId: `service_${'a'.repeat(24)}`,
    services: [
      { id: `service_${'b'.repeat(24)}`, alias: 'api', workspaceId: 'ws_api', processProfile: 'dev', startupOrder: 0, hostMode: 'manual-localhost', allowManagedWildcard: true },
      { id: `service_${'a'.repeat(24)}`, alias: 'frontend', workspaceId: 'ws_front', processProfile: 'dev', startupOrder: 1, hostMode: 'manual-localhost', allowManagedWildcard: false },
    ],
    viewport: { width: 1280, height: 800 }, reviewState: 'reviewed',
    createdAt: '2026-08-24T00:00:00.000Z', updatedAt: '2026-08-24T00:00:00.000Z',
  };
}

function registry(applications = [application()]): WorkspaceRegistry {
  const permissions = { read: true, write: false, overwrite: false, gitRead: false, validations: false, gitWrite: false, processes: true, browserRead: true };
  return {
    schemaVersion: 4,
    workspaces: [
      buildWorkspace({ id: 'ws_api', rootPath: 'C:\\api', permissions, processProfiles: { dev: profile } }),
      buildWorkspace({ id: 'ws_front', rootPath: 'C:\\front', permissions, processProfiles: { dev: profile } }),
    ],
    applications,
  };
}

function countedRegistry(serviceCount: number): WorkspaceRegistry {
  const permissions = { read: true, write: false, overwrite: false, gitRead: false, validations: false, gitWrite: false, processes: true, browserRead: true };
  const services = Array.from({ length: serviceCount }, (_, index) => ({
    id: `service_${index.toString(16).padStart(24, '0')}`,
    alias: `service-${index + 1}`,
    workspaceId: `ws_service_${index}`,
    processProfile: 'dev',
    startupOrder: index,
    hostMode: 'listener-literal' as const,
    allowManagedWildcard: false,
  }));
  return {
    schemaVersion: 4,
    workspaces: services.map((service) => buildWorkspace({ id: service.workspaceId, rootPath: `C:\\service-${service.startupOrder}`, permissions, processProfiles: { dev: profile } })),
    applications: [{
      id: `app_${serviceCount.toString(16).padStart(24, '0')}`,
      name: `Stack ${serviceCount}`,
      description: '',
      primaryServiceId: services.at(-1)!.id,
      services,
      viewport: { width: 1280, height: 800 },
      reviewState: 'reviewed',
      createdAt: '2026-08-24T00:00:00.000Z',
      updatedAt: '2026-08-24T00:00:00.000Z',
    }],
  };
}

class FakeProcesses {
  readonly starts: string[] = [];
  readonly stops: string[] = [];
  failWorkspace?: string;
  transientListenerFailures = 0;

  async start(workspaceId: string, processProfile: string) {
    this.starts.push(workspaceId);
    if (workspaceId === this.failWorkspace) throw new DevelopmentBrokerError('APPLICATION_START_FAILED', 'fallo simulado');
    return { processId: `process_${workspaceId === 'ws_api' ? 'a' : 'b'.repeat(24)}`.padEnd(32, 'a'), workspaceId, profile: processProfile, state: 'running' as const, startedAt: new Date().toISOString(), deadline: new Date(Date.now() + 60_000).toISOString() };
  }

  async listeners(workspaceId: string, processId: string) {
    const port = workspaceId === 'ws_api' ? 3007 : 5173;
    return {
      process: { processId, workspaceId, profile: 'dev', state: 'running' as const, startedAt: new Date().toISOString(), deadline: new Date(Date.now() + 60_000).toISOString() },
      listeners: [{ listenerRef: `listener_${workspaceId === 'ws_api' ? 'a'.repeat(24) : 'b'.repeat(24)}`, origin: `http://127.0.0.1:${port}`, addressFamily: 'ipv4' as const, bindScope: workspaceId === 'ws_api' ? 'wildcard' as const : 'loopback' as const, exclusive: true, port, observedAt: new Date().toISOString() }],
    };
  }

  async resolveListener(workspaceId: string, processId: string, listenerRef: string) {
    if (this.transientListenerFailures > 0) {
      this.transientListenerFailures -= 1;
      throw new DevelopmentBrokerError('LISTENER_NOT_FOUND', 'snapshot transitorio simulado');
    }
    const port = workspaceId === 'ws_api' ? 3007 : 5173;
    return { workspaceId, processId, profile: 'dev', listenerRef, origin: `http://127.0.0.1:${port}`, addressFamily: 'ipv4' as const, bindScope: workspaceId === 'ws_api' ? 'wildcard' as const : 'loopback' as const, exclusive: true, port, observedAt: new Date().toISOString() };
  }

  async stopManaged(processId: string): Promise<void> {
    this.stops.push(processId);
  }
}

async function waitTerminalOrReady(supervisor: ApplicationSupervisor, runId: string) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const current = await supervisor.status(runId);
    if (current.state !== 'starting' && current.state !== 'stopping') return current;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error('timeout de prueba');
}

describe('ApplicationSupervisor', () => {
  it.each([1, 3, 8])('orquesta y limpia una composición válida de %i servicio(s)', async (serviceCount) => {
    const source = countedRegistry(serviceCount);
    const starts: string[] = [];
    const stops: string[] = [];
    const processes = {
      async start(workspaceId: string, processProfile: string) {
        starts.push(workspaceId);
        return { processId: `process_${starts.length.toString(16).padStart(24, '0')}`, workspaceId, profile: processProfile, state: 'running' as const, startedAt: new Date().toISOString(), deadline: new Date(Date.now() + 60_000).toISOString() };
      },
      async listeners(workspaceId: string, processId: string) {
        const index = Number(workspaceId.split('_').at(-1));
        const port = 6_000 + index;
        return { process: { processId, workspaceId, profile: 'dev', state: 'running' as const, startedAt: new Date().toISOString(), deadline: new Date(Date.now() + 60_000).toISOString() }, listeners: [{ listenerRef: `listener_${(index + 1).toString(16).padStart(24, '0')}`, origin: `http://127.0.0.1:${port}`, addressFamily: 'ipv4' as const, bindScope: 'loopback' as const, exclusive: true, port, observedAt: new Date().toISOString() }] };
      },
      async resolveListener(workspaceId: string, processId: string, listenerRef: string) {
        const index = Number(workspaceId.split('_').at(-1));
        const port = 6_000 + index;
        return { workspaceId, processId, profile: 'dev', listenerRef, origin: `http://127.0.0.1:${port}`, addressFamily: 'ipv4' as const, bindScope: 'loopback' as const, exclusive: true, port, observedAt: new Date().toISOString() };
      },
      async stopManaged(processId: string) { stops.push(processId); },
    };
    const supervisor = new ApplicationSupervisor({ processes: processes as unknown as ProcessSupervisor, loadRegistry: async () => source, readinessTimeoutMs: 100 });
    const initial = await supervisor.start(source.applications[0]!.id);
    const ready = await waitTerminalOrReady(supervisor, initial.runId);
    expect(ready.state).toBe('ready');
    expect(ready.services).toHaveLength(serviceCount);
    expect(starts).toEqual(source.applications[0]!.services.map((service) => service.workspaceId));
    await supervisor.stop(ready.runId);
    expect(stops).toHaveLength(serviceCount);
    await supervisor.close();
  });

  it('inicia en orden, demuestra listeners y devuelve solo resumen acotado', async () => {
    const fake = new FakeProcesses();
    const supervisor = new ApplicationSupervisor({ processes: fake as unknown as ProcessSupervisor, loadRegistry: async () => registry(), readinessTimeoutMs: 100 });
    const initial = await supervisor.start(application().id, 'op-one');
    const ready = await waitTerminalOrReady(supervisor, initial.runId);
    expect(fake.starts).toEqual(['ws_api', 'ws_front']);
    expect(ready).toMatchObject({ state: 'ready', primaryWorkspaceId: 'ws_front', services: [{ service: 'api', port: 3007 }, { service: 'frontend', port: 5173 }] });
    expect(JSON.stringify(ready)).not.toMatch(/command|cwd|processId|listenerRef|origin/i);
    expect((await supervisor.start(application().id, 'op-one')).runId).toBe(initial.runId);
    await supervisor.close();
  });

  it('vuelve a demostrar autoridad si el snapshot cambia entre listar y resolver', async () => {
    const fake = new FakeProcesses();
    fake.transientListenerFailures = 1;
    const supervisor = new ApplicationSupervisor({
      processes: fake as unknown as ProcessSupervisor,
      loadRegistry: async () => registry(),
      readinessTimeoutMs: 500,
    });
    const initial = await supervisor.start(application().id);
    const ready = await waitTerminalOrReady(supervisor, initial.runId);
    expect(ready.state).toBe('ready');
    expect(fake.transientListenerFailures).toBe(0);
    await supervisor.close();
  });

  it('hace rollback del primer servicio si falla el segundo', async () => {
    const fake = new FakeProcesses();
    fake.failWorkspace = 'ws_front';
    const supervisor = new ApplicationSupervisor({ processes: fake as unknown as ProcessSupervisor, loadRegistry: async () => registry(), readinessTimeoutMs: 100 });
    const initial = await supervisor.start(application().id);
    const failed = await waitTerminalOrReady(supervisor, initial.runId);
    expect(failed.state).toBe('failed');
    expect(failed.errorCode).toBe('APPLICATION_START_FAILED');
    expect(failed.services.map((service) => service.state)).toEqual(['stopped', 'failed']);
    expect(fake.stops).toHaveLength(1);
    await supervisor.close();
  });

  it('identifica solo el servicio que realmente falló y no culpa a los pendientes', async () => {
    const fake = new FakeProcesses();
    fake.failWorkspace = 'ws_api';
    const supervisor = new ApplicationSupervisor({ processes: fake as unknown as ProcessSupervisor, loadRegistry: async () => registry(), readinessTimeoutMs: 100 });
    const initial = await supervisor.start(application().id);
    const failed = await waitTerminalOrReady(supervisor, initial.runId);
    expect(failed.services.map((service) => service.state)).toEqual(['failed', 'stopped']);
    expect(fake.starts).toEqual(['ws_api']);
    expect(fake.stops).toHaveLength(0);
    await supervisor.close();
  });

  it('impide cruzar un runId entre aplicaciones', async () => {
    const second = { ...application(`app_${'c'.repeat(24)}`), name: 'Otra app' };
    const fake = new FakeProcesses();
    const supervisor = new ApplicationSupervisor({ processes: fake as unknown as ProcessSupervisor, loadRegistry: async () => registry([application(), second]), readinessTimeoutMs: 100 });
    const run = await supervisor.start(application().id);
    await waitTerminalOrReady(supervisor, run.runId);
    await expect(supervisor.resolveReadyRun(second.id, run.runId)).rejects.toMatchObject({ code: 'APPLICATION_RUN_NOT_FOUND' });
    await supervisor.close();
  });

  it('deniega por defecto aplicaciones no revisadas o sin permisos', async () => {
    const fake = new FakeProcesses();
    const needsReview = { ...application(), reviewState: 'needs-review' as const };
    const supervisor = new ApplicationSupervisor({ processes: fake as unknown as ProcessSupervisor, loadRegistry: async () => registry([needsReview]) });
    await expect(supervisor.start(needsReview.id)).rejects.toMatchObject({ code: 'APPLICATION_REVIEW_REQUIRED' });
    expect(fake.starts).toEqual([]);
    await supervisor.close();
  });

  it('permite resolver needs-review solo por la frontera explícita de revisión local', async () => {
    const fake = new FakeProcesses();
    const needsReview = { ...application(), reviewState: 'needs-review' as const };
    const supervisor = new ApplicationSupervisor({ processes: fake as unknown as ProcessSupervisor, loadRegistry: async () => registry([needsReview]), readinessTimeoutMs: 100 });
    const initial = await supervisor.startForLocalReview(needsReview.id);
    const ready = await waitTerminalOrReady(supervisor, initial.runId);
    expect(ready.state).toBe('ready');
    await expect(supervisor.resolveReadyRun(needsReview.id, ready.runId)).rejects.toMatchObject({ code: 'APPLICATION_REVIEW_REQUIRED' });
    await expect(supervisor.resolveReadyRunForLocalReview(needsReview.id, ready.runId)).resolves.toMatchObject({ application: { reviewState: 'needs-review' } });
    await supervisor.close();
  });
});
