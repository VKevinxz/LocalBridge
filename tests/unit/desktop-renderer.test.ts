/// <reference lib="dom" />
// @vitest-environment happy-dom

import path from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { DesktopApi, OnboardingViewSnapshot } from '../../apps/desktop/src/preload/index.js';
import type { DesktopSettings, TunnelStatus, WebProfile } from '@localbridge/desktop-core';
import type { AuthorizedWorkspace, DevelopmentProject, LocalApplication, ProjectSetupSession } from '@localbridge/workspace';

declare global {
  interface Window {
    readonly desktop: DesktopApi;
  }
}

const ROOT_PATH = path.resolve('renderer-test-project');
const PERMISSIONS = {
  read: true,
  write: false,
  overwrite: false,
  gitRead: false,
  validations: true,
  gitWrite: false,
  processes: false,
  browserRead: false,
  browserInteract: false,
  browserHumanControl: false,
};

function workspace(overrides: Partial<AuthorizedWorkspace> = {}): AuthorizedWorkspace {
  return {
    id: 'ws_demo',
    name: 'Demo',
    rootPath: ROOT_PATH,
    enabled: true,
    createdAt: '2026-08-20T00:00:00.000Z',
    permissions: PERMISSIONS,
    limits: { maxFileBytes: 1_048_576, maxTreeEntries: 300, maxTreeDepth: 3, largeArtifacts: { mode: 'standard', reserve: { minimumFreeBytes: 1024 * 1024 * 1024, minimumFreePercent: 10 }, maxConcurrentJobs: 1 } },
    denyPatterns: ['.env'],
    validationProfiles: {},
    ...overrides,
  };
}

function webProfile(overrides: Partial<WebProfile> = {}): WebProfile {
  return {
    id: `webprofile_${'a'.repeat(24)}`,
    name: 'Investigación pública',
    kind: 'public-research',
    enabled: false,
    reviewRequired: false,
    destinations: [],
    supportHosts: [],
    permissions: { read: true, interact: true, download: false, humanControl: false },
    limits: {
      maxSessions: 2,
      maxTabsPerSession: 8,
      maxExtractedChars: 50_000,
      maxDownloadBytes: 25 * 1024 * 1024,
      maxTotalDownloadBytes: 1024 * 1024 * 1024,
      transferPolicy: { mode: 'fixed' },
    },
    createdAt: '2026-09-05T00:00:00.000Z',
    updatedAt: '2026-09-05T00:00:00.000Z',
    ...overrides,
  };
}

function onboardingSettings(step: number) {
  return {
    onboardingStep: step,
    onboardingCompleted: false,
    minimizeToTray: true,
    largeArtifactPreference: { mode: 'standard' as const, reserve: { minimumFreeBytes: 1024 * 1024 * 1024, minimumFreePercent: 10 }, maxConcurrentJobs: 1 as const },
    gitApprovalMode: 'mrtr' as const,
    activeConnectionProfileId: 'profile_default0',
    connectionProfiles: [{ id: 'profile_default0', name: 'Personal', tunnelId: '' }],
    tunnelId: '',
    tunnelBinaryPath: '',
    tunnelProfile: 'local-stdio',
    tunnelProfileDir: '',
    serverCwd: '',
  };
}

function makeApiSettings(): DesktopSettings {
  return {
    onboardingStep: 0,
    onboardingCompleted: true,
    minimizeToTray: true,
    largeArtifactPreference: { mode: 'standard', reserve: { minimumFreeBytes: 1024 * 1024 * 1024, minimumFreePercent: 10 }, maxConcurrentJobs: 1 },
    gitApprovalMode: 'mrtr',
    activeConnectionProfileId: 'profile_default0',
    connectionProfiles: [{ id: 'profile_default0', name: 'Personal', tunnelId: '' }],
    tunnelId: '',
    tunnelBinaryPath: '',
    tunnelProfile: 'local-stdio',
    tunnelProfileDir: '',
    serverCwd: '',
  };
}

function completedOnboarding(overrides: Partial<OnboardingViewSnapshot> = {}): OnboardingViewSnapshot {
  return {
    state: {
      schemaVersion: 2,
      flowVersion: 1,
      status: 'completed',
      currentStep: 'review',
      selectedConnectionProfileId: 'profile_default0',
      completedAt: '2026-08-27T12:00:00.000Z',
      updatedAt: '2026-08-27T12:00:00.000Z',
    },
    effectiveStep: 'review',
    redirected: false,
    canContinue: false,
    canComplete: false,
    requirements: [],
    draft: {},
    ...overrides,
  };
}

function onboardingAt(
  step: OnboardingViewSnapshot['effectiveStep'],
  overrides: Partial<OnboardingViewSnapshot> = {},
): OnboardingViewSnapshot {
  return {
    state: {
      schemaVersion: 2,
      flowVersion: 1,
      status: step === 'welcome' ? 'not_started' : 'in_progress',
      currentStep: step,
      selectedConnectionProfileId: 'profile_default0',
      updatedAt: '2026-08-27T12:00:00.000Z',
    },
    effectiveStep: step,
    redirected: false,
    canContinue: step === 'welcome',
    canComplete: false,
    requirements: [],
    draft: {},
    ...overrides,
  };
}

function makeApi(overrides: Partial<DesktopApi> = {}): DesktopApi {
  return {
    cancelAnalysisJob: vi.fn(async () => undefined),
    cancelTaskBatch: vi.fn(async () => undefined),
    setBrowserViewport: vi.fn(async () => undefined),
    setWebViewport: vi.fn(async () => undefined),
    setBrowserLiveViewerPresentation: vi.fn(async () => undefined),
    cancelBrowserMotion: vi.fn(async () => undefined),
    setWebLiveViewerPresentation: vi.fn(async () => undefined),
    cancelWebMotion: vi.fn(async () => undefined),
    getOnboardingSnapshot: vi.fn(async () => completedOnboarding()),
    restartOnboarding: vi.fn(async () => completedOnboarding()),
    nextOnboarding: vi.fn(async () => { throw new Error('not configured'); }),
    backOnboarding: vi.fn(async () => { throw new Error('not configured'); }),
    checkOnboardingRuntime: vi.fn(async () => { throw new Error('not configured'); }),
    diagnoseOnboardingConnection: vi.fn(async () => { throw new Error('not configured'); }),
    pickOnboardingProjectFolder: vi.fn(async () => undefined),
    setOnboardingAccess: vi.fn(async () => { throw new Error('not configured'); }),
    completeOnboarding: vi.fn(async () => { throw new Error('not configured'); }),
    listV1Projects: vi.fn(async () => ({ projects: [], decisions: [], sandboxAvailable: false })),
    createV1Project: vi.fn(async () => { throw new Error('not configured'); }),
    setV1ProjectTrust: vi.fn(async () => { throw new Error('not configured'); }),
    revokeV1ProjectTrust: vi.fn(async () => { throw new Error('not configured'); }),
    rescanV1Project: vi.fn(async () => { throw new Error('not configured'); }),
    listAssistedProjects: vi.fn(async () => ({ projects: [], sessions: [], runs: [] })),
    createAssistedProject: vi.fn(async () => { throw new Error('not configured'); }),
    adoptDevelopmentProject: vi.fn(async () => { throw new Error('not configured'); }),
    refreshAssistedProject: vi.fn(async () => { throw new Error('not configured'); }),
    setAssistedProjectPolicy: vi.fn(async () => { throw new Error('not configured'); }),
    approveAssistedProject: vi.fn(async () => { throw new Error('not configured'); }),
    cancelAssistedProject: vi.fn(async () => undefined),
    removeDevelopmentProject: vi.fn(async () => ({
      removed: true,
      workspacesRemoved: 0,
      applicationsRemoved: 0,
      sharedWorkspacesKept: 0,
      sharedApplicationsKept: 0,
      filesDeleted: false as const,
    })),
    onAssistedProjectsChange: vi.fn(() => () => undefined),
    listWorkspaces: vi.fn(async () => []),
    pickFolder: vi.fn(async () => ROOT_PATH),
    createWorkspace: vi.fn(async (input) => workspace({ name: input.name, rootPath: input.rootPath })),
    updateWorkspace: vi.fn(async (input) => input),
    removeWorkspace: vi.fn(async () => undefined),
    testWorkspace: vi.fn(async (id) => ({ workspaceId: id, ready: true, checks: [] })),
    listApplications: vi.fn(async () => []),
    createApplication: vi.fn(async () => { throw new Error('not configured'); }),
    updateApplication: vi.fn(async (application) => application),
    removeApplication: vi.fn(async () => undefined),
    verifyApplication: vi.fn(async () => { throw new Error('not configured'); }),
    startApplication: vi.fn(async () => { throw new Error('not configured'); }),
    applicationStatus: vi.fn(async () => { throw new Error('not configured'); }),
    stopApplication: vi.fn(async () => undefined),
    detectProjectCommands: vi.fn(async () => []),
    listDevelopmentActivity: vi.fn(async () => ({ processes: [], browsers: [], applications: [] })),
    stopAllDevelopmentActivity: vi.fn(async () => undefined),
    openTerminalListener: vi.fn(async () => undefined),
    copyTerminalListener: vi.fn(async () => undefined),
    stopTerminal: vi.fn(async () => undefined),
    takeBrowserHumanControl: vi.fn(async () => undefined),
    declineBrowserHumanControl: vi.fn(async () => undefined),
    revokeBrowserHumanControl: vi.fn(async () => undefined),
    captureBrowserViewer: vi.fn(async (sessionId) => ({ state: 'stopped' as const, sessionId, path: '/' as const })),
    showBrowserLiveViewer: vi.fn(async () => undefined),
    moveBrowserLiveViewer: vi.fn(async () => undefined),
    hideBrowserLiveViewer: vi.fn(async () => undefined),
    onDevelopmentActivityChange: vi.fn(() => () => undefined),
    getWebProfiles: vi.fn(async () => ({ state: 'missing' as const, document: { schemaVersion: 1 as const, profiles: [] }, sha256: null })),
    enableWebBrowsing: vi.fn(async () => ({ state: 'ready' as const, document: { schemaVersion: 1 as const, profiles: [] }, sha256: 'a'.repeat(64) })),
    createWebProfile: vi.fn(async () => ({ state: 'ready' as const, document: { schemaVersion: 1 as const, profiles: [] }, sha256: 'a'.repeat(64) })),
    updateWebProfile: vi.fn(async () => ({ state: 'ready' as const, document: { schemaVersion: 1 as const, profiles: [] }, sha256: 'a'.repeat(64) })),
    removeWebProfile: vi.fn(async () => ({ state: 'ready' as const, document: { schemaVersion: 1 as const, profiles: [] }, sha256: 'a'.repeat(64) })),
    resetWebProfiles: vi.fn(async () => ({ state: 'ready' as const, document: { schemaVersion: 1 as const, profiles: [] }, sha256: 'a'.repeat(64) })),
    listWebActivity: vi.fn(async () => []),
    getWebLiveViewerState: vi.fn(async () => ({ visible: false as const, displays: [], recommendedDisplayId: '' })),
    listWebTabs: vi.fn(async () => []),
    showWebLiveViewer: vi.fn(async () => undefined),
    moveWebLiveViewer: vi.fn(async () => undefined),
    hideWebLiveViewer: vi.fn(async () => undefined),
    takeWebHumanControl: vi.fn(async () => undefined),
    cycleWebHumanTab: vi.fn(async () => undefined),
    returnWebHumanControl: vi.fn(async () => undefined),
    declineWebHumanControl: vi.fn(async () => undefined),
    stopWebSession: vi.fn(async () => undefined),
    onWebActivityChange: vi.fn(() => () => undefined),
    getSettings: vi.fn(async () => makeApiSettings()),
    saveSettings: vi.fn(async () => undefined),
    getRuntimeInfo: vi.fn(async () => ({
      tunnelBinaryPath: path.resolve('vendor/tunnel-client/tunnel-client.exe'),
      nodeBinaryPath: path.resolve('vendor/node/node.exe'),
      serverBundlePath: path.resolve('server/index.cjs'),
      profileDir: path.resolve('profiles'),
      profile: 'localbridge',
    })),
    checkRuntime: vi.fn(async () => ({
      node: { ok: true, detail: 'v22.18.0' },
      tunnel: { ok: true, detail: 'v0.0.12' },
      connectivity: { ok: true, detail: 'HTTPS 401' },
      server: { ok: true, detail: 'system.health: ready' },
      ready: true,
    })),
    openExternal: vi.fn(async () => undefined),
    copyDiagnostic: vi.fn(async () => undefined),
    exportDiagnostic: vi.fn(async () => true),
    hideApp: vi.fn(async () => undefined),
    quitApp: vi.fn(async () => undefined),
    createConnectionProfile: vi.fn(async () => makeApiSettings()),
    selectConnectionProfile: vi.fn(async () => makeApiSettings()),
    removeConnectionProfile: vi.fn(async () => makeApiSettings()),
    exportPortableConfig: vi.fn(async () => true),
    selectPortableImport: vi.fn(async () => undefined),
    mapPortableWorkspace: vi.fn(async () => true),
    applyPortableImport: vi.fn(async () => ({ settings: makeApiSettings(), registry: { schemaVersion: 5 as const, workspaces: [], applications: [] }, workspaces: [], applications: [], projects: [], importedProfileIds: [] })),
    listAuditEvents: vi.fn(async () => []),
    listPendingApprovals: vi.fn(async () => []),
    pickTunnelBinary: vi.fn(async () => undefined),
    pickTunnelProfileDir: vi.fn(async () => undefined),
    connectTunnel: vi.fn(async (input) => ({ connected: true as const, remembered: input.remember })),
    initializeTunnelProfile: vi.fn(async () => undefined),
    diagnoseTunnel: vi.fn(async () => ({ ok: true, output: 'OK', keyPersistence: 'remembered' as const })),
    disconnectTunnel: vi.fn(async () => undefined),
    getTunnelStatus: vi.fn(async (): Promise<TunnelStatus> => 'disconnected'),
    getEffectiveGitApprovalMode: vi.fn(async () => undefined),
    onTunnelStatusChange: vi.fn(() => () => undefined),
    onTunnelLog: vi.fn(() => () => undefined),
    getTunnelKeyState: vi.fn(async () => ({ status: 'absent' as const })),
    forgetTunnelKey: vi.fn(async () => undefined),
    ...overrides,
  };
}

async function boot(overrides: Partial<DesktopApi> = {}, readySelector = '#show-create-form'): Promise<DesktopApi> {
  vi.resetModules();
  const api = makeApi(overrides);
  Object.defineProperty(window, 'desktop', { value: api, configurable: true });
  document.body.innerHTML = '<div id="app"></div>';
  window.confirm = vi.fn(() => true);

  await import('../../apps/desktop/src/renderer/src/main.js');
  await vi.waitFor(() => expect(document.querySelector(readySelector)).not.toBeNull());
  return api;
}

function click(selector: string): void {
  const element = document.querySelector<HTMLElement>(selector);
  if (element === null) throw new Error(`Elemento no encontrado: ${selector}`);
  element.click();
}

function setValue(selector: string, value: string): void {
  const element = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector);
  if (element === null) throw new Error(`Campo no encontrado: ${selector}`);
  element.value = value;
  element.dispatchEvent(new Event('input', { bubbles: true }));
}

function submit(selector: string): void {
  const form = document.querySelector<HTMLFormElement>(selector);
  if (form === null) throw new Error(`Formulario no encontrado: ${selector}`);
  form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
}

beforeEach(() => {
  document.body.innerHTML = '';
  window.localStorage.clear();
});

describe('renderer desktop — workspaces', () => {
  it('guarda perfiles detectados desde el alta inicial', async () => {
    const api = await boot({
      detectProjectCommands: vi.fn(async () => [
        {
          name: 'test',
          command: ['pnpm', 'run', 'test'],
          source: 'package.json (pnpm)',
          processProfile: {
            command: ['pnpm', 'run', 'test'],
            cwd: '.',
            source: {
              kind: 'package-script' as const,
              manifestPath: 'package.json' as const,
              script: 'test',
              definitionSha256: 'a'.repeat(64),
            },
            maxRuntimeSeconds: 14_400,
          },
        },
      ]),
    });

    click('#show-create-form');
    setValue('#workspace-form input[name="name"]', 'Proyecto nuevo');
    click('#pick-folder');
    await vi.waitFor(() => expect(document.querySelector<HTMLInputElement>('input[name="rootPath"]')?.value).toBe(ROOT_PATH));
    click('#detect-commands');
    await vi.waitFor(() => expect(document.querySelector('input[data-detected="test"]')).not.toBeNull());
    click('#authorize-all-detected');
    click('[data-workspace-tab="advanced"]');
    setValue('select[name="maxFileBytes"]', String(8 * 1024 * 1024));
    submit('#workspace-form');

    await vi.waitFor(() =>
      expect(api.createWorkspace).toHaveBeenCalledWith({
        name: 'Proyecto nuevo',
        rootPath: ROOT_PATH,
        maxFileBytes: 8 * 1024 * 1024,
        largeArtifacts: { mode: 'standard', reserve: { minimumFreeBytes: 1024 * 1024 * 1024, minimumFreePercent: 10 }, maxConcurrentJobs: 1 },
        permissions: { ...PERMISSIONS, processes: false, browserRead: false, browserInteract: false, browserHumanControl: false },
        validationProfiles: { test: ['pnpm', 'run', 'test'] },
        processProfiles: {},
        browserProfiles: {},
        automationReviewRequired: false,
      }),
    );
  });

  it('edita nombre y perfiles de un workspace existente', async () => {
    const existing = workspace({ validationProfiles: { test: ['pnpm', 'test'] } });
    const api = await boot({ listWorkspaces: vi.fn(async () => [existing]) });

    click('[data-action="edit"]');
    expect(document.querySelectorAll('[data-workspace-tab]')).toHaveLength(4);
    setValue('#workspace-form input[name="name"]', 'Demo editado');
    click('[data-workspace-tab="advanced"]');
    setValue('select[name="maxFileBytes"]', String(8 * 1024 * 1024));
    setValue('textarea[name="validationProfiles"]', '{"lint":["pnpm","lint"]}');
    submit('#workspace-form');

    await vi.waitFor(() =>
      expect(api.updateWorkspace).toHaveBeenCalledWith({
        ...existing,
        name: 'Demo editado',
        limits: { ...existing.limits, maxFileBytes: 8 * 1024 * 1024 },
        permissions: { ...existing.permissions, processes: false, browserRead: false, browserInteract: false, browserHumanControl: false },
        validationProfiles: { lint: ['pnpm', 'lint'] },
        processProfiles: {},
        browserProfiles: {},
        automationReviewRequired: false,
      }),
    );
    await vi.waitFor(() => expect(document.querySelector('#workspace-form')).toBeNull());
    expect(document.activeElement).toBe(document.querySelector('[data-action="edit"][data-id="ws_demo"]'));
  });

  it('configura una aplicación global con frontend y API sin editar JSON', async () => {
    const processProfile = {
      command: ['npm', 'run', 'dev'],
      cwd: '.',
      source: {
        kind: 'package-script' as const,
        manifestPath: 'package.json' as const,
        script: 'dev',
        definitionSha256: 'a'.repeat(64),
      },
      maxRuntimeSeconds: 300,
    };
    const frontend = workspace({ id: 'ws_frontend', name: 'Frontend', processProfiles: { dev: processProfile } });
    const apiWorkspace = workspace({ id: 'ws_api', name: 'API', processProfiles: { dev: processProfile } });
    const createApplication = vi.fn(async () => ({
      id: 'app_aaaaaaaaaaaaaaaaaaaaaaaa', name: 'CIP local', description: 'Frontend y API',
      primaryServiceId: 'service_aaaaaaaaaaaaaaaaaaaaaaaa', services: [], viewport: { width: 1280, height: 800 },
      reviewState: 'needs-review' as const, createdAt: '2026-08-24T00:00:00.000Z', updatedAt: '2026-08-24T00:00:00.000Z',
    }));
    await boot({ listWorkspaces: vi.fn(async () => [frontend, apiWorkspace]), createApplication });

    click('#nav-applications');
    click('#show-app-wizard');
    setValue('#app-name', 'CIP local');
    setValue('#app-description', 'Frontend y API');
    click('#app-wizard-next');
    click('[data-app-service="ws_frontend|dev"]');
    click('[data-app-service="ws_api|dev"]');
    click('#app-wizard-next');
    expect(document.body.textContent).toContain('Abrir en el navegador');
    expect(document.body.textContent).toContain('No necesitas copiar URLs ni puertos de la terminal');
    expect(document.body.textContent).toContain('Déjalo apagado para localhost o 127.0.0.1');
    setValue('[data-app-alias="ws_frontend|dev"]', 'frontend');
    setValue('[data-app-alias="ws_api|dev"]', 'api');
    click('[data-app-primary="ws_frontend|dev"]');
    click('[data-app-wildcard="ws_api|dev"]');
    click('#app-wizard-next');
    expect(document.body.textContent).toContain('Elige cuánto podrá hacer ChatGPT');
    expect(document.body.textContent).toContain('Selecciona un solo nivel');
    expect(document.body.textContent).toContain('los permisos que ya tenían no se reducen');
    expect(document.body.textContent).toContain('La tabla muestra el acceso resultante');
    click('#app-wizard-next');
    click('#app-wizard-save-later');

    await vi.waitFor(() => expect(createApplication).toHaveBeenCalledWith({
      name: 'CIP local', description: 'Frontend y API', primaryServiceAlias: 'frontend',
      services: [
        { alias: 'frontend', workspaceId: 'ws_frontend', processProfile: 'dev', hostMode: 'manual-localhost', allowManagedWildcard: false },
        { alias: 'api', workspaceId: 'ws_api', processProfile: 'dev', hostMode: 'manual-localhost', allowManagedWildcard: true },
      ],
      viewport: { width: 1920, height: 1080 },
    }));
    expect(document.body.textContent).not.toContain('Aplicaciones multiservicio (JSON avanzado)');
  });

  it('conserva la aplicación creada y permite reintentar una verificación fallida', async () => {
    const processProfile = {
      command: ['npm', 'run', 'dev'], cwd: '.',
      source: { kind: 'package-script' as const, manifestPath: 'package.json' as const, script: 'dev', definitionSha256: 'a'.repeat(64) },
      maxRuntimeSeconds: 300,
    };
    const project = workspace({ id: 'ws_api', name: 'API', processProfiles: { dev: processProfile } });
    const service = { id: `service_${'a'.repeat(24)}`, alias: 'api', workspaceId: project.id, processProfile: 'dev', startupOrder: 0, hostMode: 'manual-localhost' as const, allowManagedWildcard: true };
    let saved: LocalApplication | undefined;
    const createApplication = vi.fn(async () => {
      saved = {
        id: `app_${'a'.repeat(24)}`, name: 'CIP local', description: '', primaryServiceId: service.id,
        services: [service], viewport: { width: 1280, height: 800 }, reviewState: 'needs-review',
        createdAt: '2026-08-24T00:00:00.000Z', updatedAt: '2026-08-24T00:00:00.000Z',
      };
      return saved;
    });
    const updateApplication = vi.fn(async (application: LocalApplication) => {
      saved = application;
      return application;
    });
    let rejectFirstVerification: ((reason: Error) => void) | undefined;
    const firstVerification = new Promise<never>((_resolve, reject) => {
      rejectFirstVerification = reject;
    });
    const verifyApplication = vi.fn()
      .mockReturnValueOnce(firstVerification)
      .mockImplementationOnce(async () => ({
        application: { ...saved!, reviewState: 'reviewed' as const },
        run: { runId: `run_${'a'.repeat(24)}`, applicationId: saved!.id, applicationName: saved!.name, primaryWorkspaceId: project.id, state: 'ready' as const, startedAt: '2026-08-24T00:00:00.000Z', services: [{ service: 'api', workspaceId: project.id, processProfile: 'dev', state: 'ready' as const, port: 3007, bindScope: 'wildcard' as const }] },
      }));
    await boot({
      listWorkspaces: vi.fn(async () => [project]),
      listApplications: vi.fn(async () => saved === undefined ? [] : [saved]),
      createApplication,
      updateApplication,
      verifyApplication,
    });

    click('#nav-applications');
    click('#show-app-wizard');
    setValue('#app-name', 'CIP local');
    click('#app-wizard-next');
    click('[data-app-service="ws_api|dev"]');
    click('#app-wizard-next');
    setValue('[data-app-alias="ws_api|dev"]', 'api');
    click('[data-app-primary="ws_api|dev"]');
    click('[data-app-wildcard="ws_api|dev"]');
    click('#app-wizard-next');
    click('#app-wizard-next');
    click('#app-wizard-save');

    expect(document.querySelector('.application-wizard')?.getAttribute('aria-busy')).toBe('true');
    expect(document.querySelector<HTMLButtonElement>('#app-wizard-save')?.disabled).toBe(true);
    expect(document.querySelector<HTMLButtonElement>('#app-wizard-save')?.textContent).toContain('Guardando y verificando');
    expect(document.querySelector<HTMLButtonElement>('#app-wizard-save-later')?.disabled).toBe(true);
    expect(document.querySelector<HTMLButtonElement>('#app-wizard-back')?.disabled).toBe(true);
    expect(document.querySelector<HTMLButtonElement>('#cancel-app-wizard')?.disabled).toBe(true);
    expect(document.querySelector('[role="status"]')?.textContent).toContain('Puede tardar unos segundos');
    click('#app-wizard-save');
    await vi.waitFor(() => expect(verifyApplication).toHaveBeenCalledTimes(1));
    rejectFirstVerification?.(new Error("Error invoking remote method 'applications:verify': DevelopmentBrokerError: La aplicación quedó guardada, pero no se pudo iniciar “api” (perfil dev). Comprueba que su puerto no esté ocupado y vuelve a intentarlo."));

    await vi.waitFor(() => expect(document.querySelector('#application-form-error')?.textContent).toContain('no se pudo iniciar “api”'));
    expect(document.querySelector('#application-form-error')?.textContent).not.toContain('Error invoking remote method');
    expect(document.body.textContent).toContain('Editar CIP local');
    expect(createApplication).toHaveBeenCalledTimes(1);
    expect(document.querySelector<HTMLButtonElement>('#app-wizard-save')?.disabled).toBe(false);

    click('#app-wizard-save');
    await vi.waitFor(() => expect(updateApplication).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(verifyApplication).toHaveBeenCalledTimes(2));
    expect(createApplication).toHaveBeenCalledTimes(1);
  });

  it('repara una aplicación migrada sin conservar candidatos conflictivos', async () => {
    const processProfile = {
      command: ['npm', 'run', 'dev'], cwd: '.',
      source: { kind: 'package-script' as const, manifestPath: 'package.json' as const, script: 'dev', definitionSha256: 'a'.repeat(64) },
      maxRuntimeSeconds: 300,
    };
    const project = workspace({ processProfiles: { dev: processProfile } });
    const service = { id: `service_${'a'.repeat(24)}`, alias: 'frontend', workspaceId: project.id, processProfile: 'dev', startupOrder: 0, hostMode: 'manual-localhost' as const, allowManagedWildcard: false };
    const conflicted: LocalApplication = {
      id: `app_${'b'.repeat(24)}`, name: 'Aplicación migrada', description: '', primaryServiceId: service.id,
      services: [service], viewport: { width: 1280, height: 800 }, reviewState: 'conflict',
      conflictCandidates: [false, true].map((allowManagedWildcard) => ({
        ownerWorkspaceId: project.id,
        profile: {
          primaryService: 'frontend',
          services: { frontend: { workspaceId: project.id, processProfile: 'dev', startupOrder: 0, hostMode: 'manual-localhost' as const, allowManagedWildcard } },
          viewport: { width: 1280, height: 800 },
        },
      })),
      createdAt: '2026-08-24T00:00:00.000Z', updatedAt: '2026-08-24T00:00:00.000Z',
    };
    const updateApplication = vi.fn(async (application: LocalApplication) => application);
    await boot({ listWorkspaces: vi.fn(async () => [project]), listApplications: vi.fn(async () => [conflicted]), updateApplication });

    click('#nav-applications');
    expect(document.body.textContent).toContain('Reparar configuración');
    click('[data-app-edit]');
    click('#app-wizard-next');
    click('#app-wizard-next');
    click('#app-wizard-next');
    click('#app-wizard-next');
    click('#app-wizard-save-later');

    await vi.waitFor(() => expect(updateApplication).toHaveBeenCalled());
    const repaired = updateApplication.mock.calls[0]?.[0];
    expect(repaired).not.toHaveProperty('conflictCandidates');
    expect(repaired?.reviewState).toBe('needs-review');
  });

  it('enfoca únicamente el proyecto seleccionado y su editor', async () => {
    const first = workspace({ id: 'ws_first', name: 'Primero' });
    const selected = workspace({ id: 'ws_selected', name: 'Seleccionado' });
    const last = workspace({ id: 'ws_last', name: 'Último' });
    await boot({ listWorkspaces: vi.fn(async () => [first, selected, last]) });

    click('[data-action="edit"][data-id="ws_selected"]');

    const cards = document.querySelectorAll('.workspace-card');
    expect(cards).toHaveLength(1);
    expect(cards[0]?.textContent).toContain('Seleccionado');
    expect(document.querySelector('.workspace-edit-layout')).not.toBeNull();
    expect(document.querySelector('#workspace-form-title')?.textContent).toContain('Seleccionado');
    expect(document.querySelector<HTMLInputElement>('#workspace-form input[name="name"]')?.value).toBe('Seleccionado');
    expect(document.activeElement).toBe(document.querySelector('#workspace-form input[name="name"]'));
  });

  it('restaura la cuadrícula y el foco al cancelar la edición', async () => {
    const first = workspace({ id: 'ws_first', name: 'Primero' });
    const selected = workspace({ id: 'ws_selected', name: 'Seleccionado' });
    const last = workspace({ id: 'ws_last', name: 'Último' });
    await boot({ listWorkspaces: vi.fn(async () => [first, selected, last]) });

    click('[data-action="edit"][data-id="ws_selected"]');
    click('#cancel-form');

    expect(document.querySelectorAll('.workspace-card')).toHaveLength(3);
    expect(document.activeElement).toBe(document.querySelector('[data-action="edit"][data-id="ws_selected"]'));
  });

  it('muestra errores de detección sin borrar el formulario', async () => {
    await boot({ detectProjectCommands: vi.fn(async () => Promise.reject(new Error('manifiesto ilegible'))) });

    click('#show-create-form');
    setValue('#workspace-form input[name="name"]', 'Borrador importante');
    click('#pick-folder');
    await vi.waitFor(() => expect(document.querySelector<HTMLInputElement>('input[name="rootPath"]')?.value).toBe(ROOT_PATH));
    click('#detect-commands');

    await vi.waitFor(() => expect(document.querySelector('#form-error')?.textContent).toContain('manifiesto ilegible'));
    expect(document.querySelector<HTMLInputElement>('#workspace-form input[name="name"]')?.value).toBe('Borrador importante');
  });
});

describe('renderer desktop — proyectos asistidos v0.9', () => {
  const project: DevelopmentProject = {
    id: `project_${'a'.repeat(24)}`, name: 'Web nueva', description: '', workspaceIds: ['ws_demo'],
    setupStatus: 'review-required', createdAt: '2026-08-26T00:00:00.000Z', updatedAt: '2026-08-26T00:00:00.000Z',
  };
  const session: ProjectSetupSession = {
    id: `setup_${'b'.repeat(24)}`, projectId: project.id, provisionalWorkspaceId: 'ws_demo',
    policy: 'restricted', initializeGit: false, phase: 'awaiting-local-review',
    plan: {
      id: `plan_${'c'.repeat(24)}`, projectId: project.id, topology: 'single', proposedWorkspaceRoots: ['.'],
      manifestRefs: [{ workspaceId: 'ws_demo', path: 'package.json', sha256: 'd'.repeat(64) }], lockfileRefs: [],
      packageManagers: [], directDependencyCount: 0, directDevDependencyCount: 0,
      toolchainFingerprint: 'e'.repeat(64), actions: [], proposedProfiles: [], policy: 'restricted',
      planSha256: 'f'.repeat(64), createdAt: '2026-08-26T00:00:00.000Z',
    },
    createdAt: '2026-08-26T00:00:00.000Z', updatedAt: '2026-08-26T00:00:00.000Z',
  };

  it('crea desde una carpeta con presets explícitos y concede gitWrite solo al pedir git-init', async () => {
    const createAssistedProject = vi.fn(async () => ({ project, session }));
    const api = await boot({ createAssistedProject });
    click('[data-section="assisted"]');
    expect(document.body.textContent).toContain('Tus carpetas y aplicaciones actuales siguen funcionando igual');
    click('#show-assisted-wizard-empty');
    setValue('#assisted-name', 'Web nueva');
    click('#assisted-pick-folder');
    await vi.waitFor(() => expect(document.querySelector<HTMLInputElement>('#assisted-root')?.value).toBe(ROOT_PATH));
    click('#assisted-next');
    click('#assisted-next');
    click('#assisted-git-init');
    click('#assisted-next');
    click('#assisted-next');

    await vi.waitFor(() => expect(createAssistedProject).toHaveBeenCalledOnce());
    expect(createAssistedProject).toHaveBeenCalledWith(expect.objectContaining({
      name: 'Web nueva', rootPath: ROOT_PATH, initializeGit: true,
      permissions: expect.objectContaining({ read: true, write: true, overwrite: true, processes: true, gitWrite: true }),
    }));
    expect(api.createAssistedProject).toHaveBeenCalledTimes(1);
  });

  it('deshabilita la aprobación sincrónicamente y evita doble ejecución', async () => {
    let resolveApproval: (() => void) | undefined;
    const approveAssistedProject = vi.fn(() => new Promise<never>((resolve) => { resolveApproval = resolve as () => void; }));
    await boot({
      listAssistedProjects: vi.fn(async () => ({ projects: [project], sessions: [session], runs: [] })),
      approveAssistedProject,
    });
    click('[data-section="assisted"]');
    click('[data-assisted-approve]');
    expect(document.querySelector<HTMLButtonElement>('[data-assisted-approve]')?.disabled).toBe(true);
    expect(document.querySelector('[data-assisted-approve]')?.getAttribute('aria-busy')).toBe('true');
    click('[data-assisted-approve]');
    expect(approveAssistedProject).toHaveBeenCalledTimes(1);
    resolveApproval?.();
  });

  it('permite cambiar a instalación manual sin exponer una ejecución a ChatGPT', async () => {
    const setAssistedProjectPolicy = vi.fn(async () => ({ ...session, policy: 'manual' as const }));
    await boot({
      listAssistedProjects: vi.fn(async () => ({ projects: [project], sessions: [session], runs: [] })),
      setAssistedProjectPolicy,
    });
    click('[data-section="assisted"]');
    const select = document.querySelector<HTMLSelectElement>('[data-assisted-policy]');
    if (select === null) throw new Error('selector ausente');
    select.value = 'manual';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    await vi.waitFor(() => expect(setAssistedProjectPolicy).toHaveBeenCalledWith(project.id, 'manual'));
  });

  it('elimina el desarrollo y sus accesos desde una sola acción local', async () => {
    const removeDevelopmentProject = vi.fn(async () => ({
      removed: true,
      workspacesRemoved: 1,
      applicationsRemoved: 1,
      sharedWorkspacesKept: 0,
      sharedApplicationsKept: 0,
      filesDeleted: false as const,
    }));
    await boot({
      listAssistedProjects: vi.fn(async () => ({ projects: [project], sessions: [session], runs: [] })),
      removeDevelopmentProject,
    });
    click('[data-section="assisted"]');

    expect(document.querySelector('[data-assisted-remove]')?.textContent).toContain('Eliminar desarrollo y accesos');
    click('[data-assisted-remove]');

    await vi.waitFor(() => expect(removeDevelopmentProject).toHaveBeenCalledWith(project.id));
    await vi.waitFor(() => expect(document.querySelector('#global-feedback')?.textContent).toContain('1 carpeta(s) autorizada(s)'));
    expect(document.querySelector('#global-feedback')?.textContent).toContain('Los archivos reales permanecen en el disco');
  });
});

describe('renderer desktop — proyectos y confianza v1.0', () => {
  const projectId = `project_${'1'.repeat(24)}`;
  const catalogProject = {
    id: projectId,
    displayName: 'Producto completo',
    description: 'Frontend y API',
    selectedRoot: ROOT_PATH,
    state: 'ready' as const,
    topology: 'multi-service' as const,
    nodes: [],
    derivedScopes: [{ relativePath: '.', source: 'root' as const, status: 'active' as const }],
    compatibilityRefs: [{ kind: 'workspace' as const, id: 'ws_demo' }],
    scanFingerprint: 'a'.repeat(64),
    createdAt: '2026-08-26T00:00:00.000Z',
    updatedAt: '2026-08-26T00:00:00.000Z',
  };
  const fullHostDecision = {
    projectId,
    mode: 'full-host' as const,
    deviceBinding: 'b'.repeat(64),
    status: 'active' as const,
    networkPolicy: 'user-session' as const,
    acceptedRiskVersion: '1',
    reviewedAt: '2026-08-26T00:00:00.000Z',
  };

  it('abre una sola carpeta, explica los niveles y bloquea Agente en proyecto', async () => {
    const createV1Project = vi.fn(async () => ({ project: catalogProject, decision: fullHostDecision }));
    await boot({ createV1Project });
    click('[data-section="assisted"]');
    click('#show-v1-project-empty');

    expect(document.querySelector<HTMLInputElement>('input[value="project-agent"]')?.disabled).toBe(true);
    expect(document.querySelector<HTMLInputElement>('input[value="guided"]')?.checked).toBe(true);
    expect(document.body.textContent).toContain('La carpeta es el inicio, no un límite de seguridad');
    click('#v1-project-pick');
    await vi.waitFor(() => expect(document.querySelector<HTMLInputElement>('#v1-project-root')?.value).toBe(ROOT_PATH));
    click('input[value="full-host"]');
    submit('#v1-project-form');

    expect(document.querySelector<HTMLButtonElement>('#v1-project-save')?.disabled).toBe(true);
    await vi.waitFor(() => expect(createV1Project).toHaveBeenCalledWith(expect.objectContaining({
      rootPath: ROOT_PATH,
      trustMode: 'full-host',
    })));
  });

  it('muestra Control total de forma persistente y permite revocarlo', async () => {
    const revokeV1ProjectTrust = vi.fn(async () => ({ ...fullHostDecision, status: 'revoked' as const }));
    await boot({
      listV1Projects: vi.fn(async () => ({ projects: [catalogProject], decisions: [fullHostDecision], sandboxAvailable: false })),
      revokeV1ProjectTrust,
    });
    click('[data-section="assisted"]');

    expect(document.querySelector('.state-danger')?.textContent).toBe('Control total');
    expect(document.body.textContent).toContain('puede operar fuera de esta carpeta');
    click('[data-v1-revoke]');
    await vi.waitFor(() => expect(revokeV1ProjectTrust).toHaveBeenCalledWith(projectId));
  });

  it('mantiene Control total disponible cuando solo la preparación guiada pide revisión', async () => {
    const setupProject: DevelopmentProject = {
      id: projectId, name: 'Producto completo', description: '', workspaceIds: ['ws_demo'],
      setupStatus: 'review-required', createdAt: '2026-08-26T00:00:00.000Z', updatedAt: '2026-08-26T00:00:00.000Z',
    };
    const setupSession: ProjectSetupSession = {
      id: `setup_${'c'.repeat(24)}`, projectId, provisionalWorkspaceId: 'ws_demo', policy: 'restricted',
      initializeGit: false, phase: 'awaiting-local-review',
      plan: {
        id: `plan_${'d'.repeat(24)}`, projectId, topology: 'single', proposedWorkspaceRoots: ['.'],
        manifestRefs: [], lockfileRefs: [], packageManagers: ['npm'], directDependencyCount: 1,
        directDevDependencyCount: 1, toolchainFingerprint: 'e'.repeat(64), actions: [],
        proposedProfiles: [], policy: 'restricted', planSha256: 'f'.repeat(64), createdAt: '2026-08-26T00:00:00.000Z',
      },
      createdAt: '2026-08-26T00:00:00.000Z', updatedAt: '2026-08-26T00:00:00.000Z',
    };
    await boot({
      listV1Projects: vi.fn(async () => ({ projects: [catalogProject], decisions: [fullHostDecision], sandboxAvailable: false })),
      listAssistedProjects: vi.fn(async () => ({ projects: [setupProject], sessions: [setupSession], runs: [] })),
    });
    click('[data-section="assisted"]');
    expect(document.body.textContent).toContain('Tu terminal sigue disponible');
    expect(document.body.textContent).toContain('Revisar preparación guiada');
    expect(document.querySelector('.state-danger')?.textContent).toBe('Control total');
  });

  it('distingue en Actividad perfiles revisados y propuestas detectadas', async () => {
    await boot({
      listDevelopmentActivity: vi.fn(async () => ({
        processes: [], browsers: [], applications: [],
        availability: [{
          projectId,
          projectName: 'Producto completo',
          terminalAvailable: true,
          reviewed: { processes: 0, validations: 1, browser: 0 },
          detectedProposal: { state: 'detected-awaiting-review' as const, processes: 1, validations: 2 },
        }],
      })),
    });
    click('[data-section="activity"]');

    expect(document.body.textContent).toContain('Terminal autorizada disponible independientemente de los perfiles');
    expect(document.body.textContent).toContain('perfiles revisados disponibles: 0 servidor(es), 1 validación(es)');
    expect(document.body.textContent).toContain('propuesta detectada pendiente: 1 servidor(es), 2 validación(es)');
    expect(document.body.textContent).toContain('Una propuesta detectada no es un perfil revisado');
  });

  it('agrupa lotes, explica esperas y permite cancelar un hijo sin confundirlo con el servidor', async () => {
    const cancelTaskBatch = vi.fn(async () => undefined);
    await boot({
      cancelTaskBatch,
      listDevelopmentActivity: vi.fn(async () => ({
        processes: [], browsers: [], applications: [],
        taskBatchAvailability: { available: true as const },
        taskBatches: [{
          batchId: `batch_${'a'.repeat(24)}`, workspaceId: 'ws_demo', operationId: 'batch_ux',
          state: 'running' as const, revision: 4, createdAt: '2026-09-12T10:00:00.000Z', updatedAt: '2026-09-12T10:00:01.000Z', deliveryMs: 1,
          children: [{
            localId: 'visual-check', operationKind: 'artifact.hash' as const, sourcePath: 'reference.png',
            state: 'waiting_resource' as const, stage: 'waiting_for_analysis_capacity', effectState: 'not_started' as const,
            coverage: 'unknown' as const,
            timing: { admissionMs: 3, dependencyWaitMs: 0, capacityWaitMs: 120, lockWaitMs: 0, lockHoldMs: 0, executionMs: 0, persistenceMs: 2, clientWaitMs: 0 as const },
            resultAvailable: false, resultExpired: false,
          }],
        }],
      })),
    });
    click('[data-section="activity"]');

    expect(document.body.textContent).toContain('LOTE');
    expect(document.body.textContent).toContain('Espera una plaza de análisis disponible');
    expect(document.body.textContent).toContain('Cancelar paso');
    click('[data-task-child="visual-check"]');
    await vi.waitFor(() => expect(cancelTaskBatch).toHaveBeenCalledWith('ws_demo', `batch_${'a'.repeat(24)}`, 'visual-check'));
  });

  it('contrae la actividad vacía, conserva solo cuatro preferencias generales y restaura el foco', async () => {
    await boot();
    click('[data-section="activity"]');

    expect(document.querySelector<HTMLElement>('#activity-runtime-panel')?.hidden).toBe(true);
    expect(document.querySelector<HTMLElement>('#activity-technical-log-panel')?.hidden).toBe(true);
    expect(document.querySelector<HTMLElement>('#activity-documents-panel')?.hidden).toBe(true);
    expect(document.querySelector<HTMLElement>('#activity-audit-panel')?.hidden).toBe(true);

    click('#activity-toggle-runtime');
    expect(document.querySelector<HTMLElement>('#activity-runtime-panel')?.hidden).toBe(false);
    expect(document.querySelector('#activity-toggle-runtime')?.getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement?.id).toBe('activity-toggle-runtime');
    const stored = JSON.parse(window.localStorage.getItem('localbridge.activityDisclosure.v1') ?? '{}') as Record<string, unknown>;
    expect(stored).toEqual({ runtime: true, technicalLog: false, documents: false, audit: false });
    expect(Object.keys(stored)).toHaveLength(4);
  });

  it('mantiene visibles las intervenciones y permite contraer todo el detalle', async () => {
    await boot({
      listDevelopmentActivity: vi.fn(async () => ({
        processes: [], applications: [], terminals: [],
        browsers: [{
          workspaceId: 'ws_demo', sessionId: `session_${'a'.repeat(24)}`, profile: 'dev', state: 'running' as const,
          title: 'Acceso requerido', path: '/', startedAt: '2026-09-13T10:00:00.000Z',
          controlState: 'waiting_for_human' as const, humanReason: 'sign_in' as const,
        }],
      })),
    });
    click('[data-section="activity"]');
    expect(document.querySelector<HTMLElement>('#activity-runtime-panel')?.hidden).toBe(false);

    click('#activity-collapse-all');
    expect(document.querySelector<HTMLElement>('#activity-runtime-panel')?.hidden).toBe(true);
    const intervention = document.querySelector<HTMLElement>('.activity-intervention');
    expect(intervention).not.toBeNull();
    expect(intervention?.closest('[hidden]')).toBeNull();
    expect(intervention?.textContent).toContain('requieren tu intervención');
    click('.activity-intervention [data-activity-filter="browsers"]');
    expect(document.querySelector<HTMLElement>('#activity-runtime-panel')?.hidden).toBe(false);
    expect(document.querySelector('#activity-filter-browsers')?.getAttribute('aria-pressed')).toBe('true');
  });

  it('conserva en memoria el plegado de un lote sin persistir su identificador', async () => {
    const batchId = `batch_${'b'.repeat(24)}`;
    await boot({
      listDevelopmentActivity: vi.fn(async () => ({
        processes: [], browsers: [], applications: [],
        taskBatches: [{
          batchId, workspaceId: 'ws_demo', operationId: 'batch_disclosure', state: 'running' as const,
          revision: 1, createdAt: '2026-09-13T10:00:00.000Z', updatedAt: '2026-09-13T10:00:01.000Z', deliveryMs: 1,
          children: [{
            localId: 'read', operationKind: 'artifact.inspect' as const, sourcePath: 'large.bin', state: 'running' as const,
            stage: 'reading', effectState: 'not_started' as const, coverage: 'unknown' as const,
            timing: { admissionMs: 1, dependencyWaitMs: 0, capacityWaitMs: 0, lockWaitMs: 0, lockHoldMs: 0, executionMs: 1, persistenceMs: 0, clientWaitMs: 0 as const },
            resultAvailable: false, resultExpired: false,
          }],
        }],
      })),
    });
    click('[data-section="activity"]');
    const selector = `[data-activity-item-toggle="batch:${batchId}"]`;
    expect(document.querySelector(selector)?.getAttribute('aria-expanded')).toBe('true');
    click(selector);
    expect(document.querySelector(selector)?.getAttribute('aria-expanded')).toBe('false');
    click('#activity-filter-browsers');
    click('#activity-filter-all');
    expect(document.querySelector(selector)?.getAttribute('aria-expanded')).toBe('false');
    expect(window.localStorage.getItem('localbridge.activityDisclosure.v1') ?? '').not.toContain(batchId);
  });
});

describe('renderer desktop — configuración y errores', () => {
  it('permite elegir conscientemente el cuadro nativo de ChatGPT y explica la delegación', async () => {
    const api = await boot();

    setValue('select[name="gitApprovalMode"]', 'host');
    setValue('input[name="tunnelId"]', 'tunnel_0123456789abcdef0123456789abcdef');
    submit('#settings-form');

    await vi.waitFor(() => expect(api.saveSettings).toHaveBeenCalledWith(expect.objectContaining({ gitApprovalMode: 'host' })));
    expect(document.body.textContent).toContain('LocalBridge no puede comprobar qué botón pulsaste');
  });

  it('prepara el perfil autocontenido guardando primero el tunnel ID', async () => {
    const api = await boot();

    setValue('input[name="tunnelId"]', 'tunnel_0123456789abcdef0123456789abcdef');
    click('#prepare-profile');

    await vi.waitFor(() => expect(api.initializeTunnelProfile).toHaveBeenCalledOnce());
    expect(api.saveSettings).toHaveBeenCalledWith(
      expect.objectContaining({ tunnelId: 'tunnel_0123456789abcdef0123456789abcdef' }),
    );
    expect(document.querySelector('#global-feedback')?.textContent).toContain('autocontenido preparado');
  });

  it('presenta el resultado de doctor dentro de la ventana', async () => {
    const api = await boot({ diagnoseTunnel: vi.fn(async () => ({ ok: true, output: 'CHECK profile_load PASS', keyPersistence: 'remembered' as const })) });

    setValue('input[name="tunnelId"]', 'tunnel_0123456789abcdef0123456789abcdef');
    setValue('#api-key', 'clave-de-prueba');
    click('#diagnose-tunnel');

    await vi.waitFor(() => expect(document.querySelector('#diagnostic-output')?.textContent).toContain('profile_load PASS'));
    expect(document.querySelector('#global-feedback')?.textContent).toContain('sin fallos');
    expect(api.diagnoseTunnel).toHaveBeenCalledWith('clave-de-prueba');
    expect(document.querySelector<HTMLInputElement>('#api-key')?.value).toBe('');
  });

  it('detiene el flujo y explica el ID inválido sin mostrar errores internos', async () => {
    const api = await boot();

    setValue('input[name="tunnelId"]', 'valor-de-credencial-en-campo-equivocado');
    setValue('#api-key', 'clave-candidata');
    click('#diagnose-tunnel');

    const message = document.querySelector('#tunnel-id-error')?.textContent ?? '';
    expect(message).toContain('empieza por tunnel_');
    expect(message).not.toMatch(/settings:save|Zod|invalid_format|regex/i);
    expect(document.activeElement).toBe(document.querySelector('input[name="tunnelId"]'));
    expect(api.saveSettings).not.toHaveBeenCalled();
    expect(api.diagnoseTunnel).not.toHaveBeenCalled();
  });

  it('conserva la clave guardada si una candidata no supera el diagnóstico', async () => {
    const api = await boot({
      getTunnelKeyState: vi.fn(async () => ({ status: 'available' as const })),
      diagnoseTunnel: vi.fn(async () => ({ ok: false, output: 'HTTP 401 unauthorized' })),
    });

    setValue('input[name="tunnelId"]', 'tunnel_0123456789abcdef0123456789abcdef');
    setValue('#api-key', 'clave-candidata');
    click('#diagnose-tunnel');

    await vi.waitFor(() => expect(api.diagnoseTunnel).toHaveBeenCalledWith('clave-candidata'));
    expect(document.querySelector('#global-feedback')?.textContent).toContain('clave de runtime fue rechazada');
    expect(document.body.textContent).toContain('se conserva la anterior');
  });

  it('redacta una excepción técnica del diagnóstico', async () => {
    await boot({
      diagnoseTunnel: vi.fn(async () =>
        Promise.reject(new Error("Error invoking remote method 'tunnel:doctor': ZodError invalid_format")),
      ),
    });

    setValue('input[name="tunnelId"]', 'tunnel_0123456789abcdef0123456789abcdef');
    setValue('#api-key', 'clave-candidata');
    click('#diagnose-tunnel');

    await vi.waitFor(() => expect(document.querySelector('#global-feedback')).not.toBeNull());
    const message = document.querySelector('#global-feedback')?.textContent ?? '';
    expect(message).toContain('No se pudo completar el diagnóstico');
    expect(message).not.toMatch(/remote method|tunnel:doctor|Zod|invalid_format/i);
  });

  it('conserva el perfil escrito al elegir otra ruta', async () => {
    const api = await boot({ pickTunnelBinary: vi.fn(async () => path.resolve('tunnel-client.exe')) });

    setValue('input[name="tunnelProfile"]', 'perfil-alternativo');
    click('#pick-binary');

    await vi.waitFor(() =>
      expect(api.saveSettings).toHaveBeenCalledWith({
        onboardingStep: 4,
        onboardingCompleted: true,
        minimizeToTray: true,
        largeArtifactPreference: { mode: 'standard', reserve: { minimumFreeBytes: 1024 * 1024 * 1024, minimumFreePercent: 10 }, maxConcurrentJobs: 1 },
        gitApprovalMode: 'mrtr',
        activeConnectionProfileId: 'profile_default0',
        connectionProfiles: [{ id: 'profile_default0', name: 'Personal', tunnelId: '' }],
        tunnelId: '',
        tunnelBinaryPath: path.resolve('tunnel-client.exe'),
        tunnelProfile: 'perfil-alternativo',
        tunnelProfileDir: '',
        serverCwd: '',
      }),
    );
    expect(document.querySelector<HTMLInputElement>('input[name="tunnelProfile"]')?.value).toBe('perfil-alternativo');
  });

  it('presenta un error de conexión dentro de la ventana', async () => {
    await boot({ connectTunnel: vi.fn(async () => Promise.reject(new Error('clave rechazada'))) });

    setValue('input[name="tunnelId"]', 'tunnel_0123456789abcdef0123456789abcdef');
    setValue('#api-key', 'clave-candidata');
    click('#connect-tunnel');

    await vi.waitFor(() => expect(document.querySelector('#global-feedback')?.textContent).toContain('clave de runtime fue rechazada'));
    expect(document.querySelector('#global-feedback')?.getAttribute('role')).toBe('alert');
  });

  it('recuerda una clave nueva desde el flujo normal después de conectar', async () => {
    const api = await boot();

    setValue('input[name="tunnelId"]', 'tunnel_0123456789abcdef0123456789abcdef');
    setValue('#api-key', 'clave-candidata');
    click('#connect-tunnel');

    await vi.waitFor(() => expect(api.connectTunnel).toHaveBeenCalledWith({ apiKey: 'clave-candidata', remember: true }));
    expect(document.querySelector('#global-feedback')?.textContent).toContain('guardada y cifrada');
    expect(document.querySelector<HTMLInputElement>('#api-key')?.value).toBe('');
  });

  it('reutiliza una clave guardada sin precargar ni devolver el secreto al DOM', async () => {
    const api = await boot({ getTunnelKeyState: vi.fn(async () => ({ status: 'available' as const })) });

    setValue('input[name="tunnelId"]', 'tunnel_0123456789abcdef0123456789abcdef');
    expect(document.querySelector<HTMLInputElement>('#api-key')?.value).toBe('');
    click('#connect-tunnel');

    await vi.waitFor(() => expect(api.connectTunnel).toHaveBeenCalledWith({ remember: true }));
    expect(document.querySelector('#global-feedback')?.textContent).toContain('guardada y cifrada');
    expect(document.body.innerHTML).not.toContain('sk-guardada');
  });

  it('usa una clave nueva de forma efímera y borra el borrador tras conectar', async () => {
    const api = await boot();

    setValue('input[name="tunnelId"]', 'tunnel_0123456789abcdef0123456789abcdef');
    setValue('#api-key', 'clave-efimera');
    click('#remember-tunnel-key');
    click('#connect-tunnel');

    await vi.waitFor(() => expect(api.connectTunnel).toHaveBeenCalledWith({ apiKey: 'clave-efimera', remember: false }));
    expect(document.querySelector('#global-feedback')?.textContent).toContain('temporal para esta sesión');
    expect(document.querySelector<HTMLInputElement>('#api-key')?.value).toBe('');
    expect(window.localStorage.length).toBe(0);
  });

  it('mantiene el túnel conectado y explica un fallo de persistencia sin perder el estado anterior', async () => {
    await boot({
      getTunnelKeyState: vi.fn(async () => ({ status: 'available' as const })),
      connectTunnel: vi.fn(async () => ({ connected: true as const, remembered: false, warningCode: 'KEY_STORE_WRITE_FAILED' as const })),
    });

    setValue('input[name="tunnelId"]', 'tunnel_0123456789abcdef0123456789abcdef');
    setValue('#api-key', 'clave-nueva');
    click('#connect-tunnel');

    await vi.waitFor(() => expect(document.querySelector('#global-feedback')?.textContent).toContain('la clave anterior se conserva'));
    expect(document.querySelector('#global-feedback')?.classList.contains('feedback-warning')).toBe(true);
    expect(document.body.textContent).toContain('guardada y cifrada por Windows');
  });

  it('diferencia un almacén ilegible de una clave ausente sin exponer datos', async () => {
    await boot({ getTunnelKeyState: vi.fn(async () => ({ status: 'unreadable' as const })) });

    expect(document.body.textContent).toContain('clave guardada ilegible');
    expect(document.querySelector<HTMLInputElement>('#api-key')?.value).toBe('');
    expect(document.querySelector<HTMLButtonElement>('#forget-key')?.disabled).toBe(false);
  });

  it('un log vivo no interrumpe el texto que el usuario está editando', async () => {
    let emitLog: ((line: string, stream: 'stdout' | 'stderr') => void) | undefined;
    await boot({
      onTunnelLog: vi.fn((callback) => {
        emitLog = callback;
        return () => undefined;
      }),
    });

    click('#show-create-form');
    setValue('#workspace-form input[name="name"]', 'Texto sin perder');
    emitLog?.('actividad', 'stdout');

    expect(document.querySelector<HTMLInputElement>('#workspace-form input[name="name"]')?.value).toBe('Texto sin perder');
    expect(document.querySelector('#tunnel-log')?.textContent).toContain('actividad');
  });
});

describe('renderer desktop — onboarding reanudable', () => {
  it('explica el límite de confianza y persiste el avance', async () => {
    const runtime = onboardingAt('runtime');
    const api = await boot({
      getSettings: vi.fn(async () => onboardingSettings(0)),
      getOnboardingSnapshot: vi.fn(async () => onboardingAt('welcome')),
      nextOnboarding: vi.fn(async () => runtime),
    }, '[data-onboarding-next]');

    expect(document.body.textContent).toContain('Ninguna carpeta ni capacidad se concede');
    click('[data-onboarding-next]');

    await vi.waitFor(() => expect(api.nextOnboarding).toHaveBeenCalledTimes(1));
    expect(document.body.textContent).toContain('Comprobar componentes');
  });

  it('reanuda en conexión, cifra la clave y habilita continuar tras doctor', async () => {
    const connection = onboardingAt('connection');
    const validated = onboardingAt('connection', { canContinue: true });
    const api = await boot({
      getSettings: vi.fn(async () => onboardingSettings(2)),
      getOnboardingSnapshot: vi.fn(async () => connection),
      diagnoseOnboardingConnection: vi.fn(async () => ({ report: { ok: true, output: 'ready', keyPersistence: 'remembered' as const }, snapshot: validated })),
    }, '#diagnose-tunnel');

    expect(document.body.textContent).toContain('Validar el túnel');
    setValue('input[name="tunnelId"]', 'tunnel_0123456789abcdef0123456789abcdef');
    setValue('#api-key', 'clave-runtime');
    click('#diagnose-tunnel');

    await vi.waitFor(() => expect(api.diagnoseOnboardingConnection).toHaveBeenCalledWith('clave-runtime'));
    await vi.waitFor(() => expect(document.querySelector<HTMLButtonElement>('[data-onboarding-next]')?.disabled).toBe(false));
    expect(document.body.textContent).toContain('Guardada y cifrada');
  });

  it('aplica presets humanos al primer workspace', async () => {
    const access = onboardingAt('access', {
      draft: { selectionId: 'folder_0123456789abcdef0123456789abcdef' },
    });
    const prepared = onboardingAt('access', {
      canContinue: true,
      draft: { selectionId: 'folder_0123456789abcdef0123456789abcdef', trustMode: 'guided', guidedPreset: 'complete' },
    });
    const api = await boot({
      getOnboardingSnapshot: vi.fn(async () => access),
      setOnboardingAccess: vi.fn(async () => prepared),
    }, '#onboarding-confirm-access');

    const preset = document.querySelector<HTMLInputElement>('input[name="onboarding-preset"][value="complete"]');
    if (preset === null) throw new Error('preset no encontrado');
    preset.click();
    click('#onboarding-confirm-access');

    await vi.waitFor(() => expect(api.setOnboardingAccess).toHaveBeenCalledWith({ trustMode: 'guided', guidedPreset: 'complete' }));
    expect(document.querySelector<HTMLButtonElement>('[data-onboarding-next]')?.disabled).toBe(false);
  });

  it('completa solo después de una prueba de salud verde', async () => {
    const folder = {
      selectionId: 'folder_0123456789abcdef0123456789abcdef', suggestedName: 'Demo', topology: 'single-repo' as const,
      repositoryCount: 1, packageCount: 1, serviceCount: 1, validationCount: 2, warningCodes: [], requiresReview: false,
      fingerprint: 'a'.repeat(64),
    };
    const review = onboardingAt('review', {
      canContinue: true,
      folder,
      draft: { selectionId: folder.selectionId, trustMode: 'guided', guidedPreset: 'develop' },
    });
    const api = await boot({
      getOnboardingSnapshot: vi.fn(async () => review),
      completeOnboarding: vi.fn(async () => ({ ...completedOnboarding(), project: {} as never })),
    }, '#complete-onboarding');

    expect(document.querySelector<HTMLButtonElement>('#complete-onboarding')?.disabled).toBe(false);
    click('#complete-onboarding');

    await vi.waitFor(() => expect(api.completeOnboarding).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'selection', folderSelectionId: folder.selectionId, name: 'Demo', trustMode: 'guided', guidedPreset: 'develop',
    })));
  });

  it('abre únicamente destinos externos predefinidos', async () => {
    const api = await boot({
      getSettings: vi.fn(async () => onboardingSettings(2)),
      getOnboardingSnapshot: vi.fn(async () => onboardingAt('connection')),
    }, '[data-external="tunnels"]');

    click('[data-external="tunnels"]');
    await vi.waitFor(() => expect(api.openExternal).toHaveBeenCalledWith('tunnels'));
  });

  it('puede repetirse sin borrar la configuración existente', async () => {
    const api = await boot({ restartOnboarding: vi.fn(async () => onboardingAt('welcome')) });

    click('#restart-onboarding');
    await vi.waitFor(() => expect(api.restartOnboarding).toHaveBeenCalledTimes(1));
    expect(api.removeWorkspace).not.toHaveBeenCalled();
    expect(api.removeDevelopmentProject).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('Trabaja con ChatGPT desde una carpeta');
  });
});

describe('renderer desktop — navegación operacional', () => {
  it('separa cinco vistas, inicia en el dashboard y mueve el foco al navegar', async () => {
    await boot();

    expect(document.querySelector('#nav-home')?.getAttribute('aria-current')).toBe('page');
    expect(document.querySelector('[data-view="projects"]')?.hasAttribute('hidden')).toBe(true);

    click('#nav-projects');

    expect(document.querySelector('#nav-projects')?.getAttribute('aria-current')).toBe('page');
    expect(document.querySelector('[data-view="projects"]')?.hasAttribute('hidden')).toBe(false);
    expect(document.activeElement?.id).toBe('main-content');
  });

  it('presenta proyectos como tarjetas con permisos humanos', async () => {
    await boot({ listWorkspaces: vi.fn(async () => [workspace()]) });

    expect(document.querySelector('table')).toBeNull();
    expect(document.querySelector('.workspace-card')?.textContent).toContain('Leer archivos');
    expect(document.querySelector('.workspace-card')?.textContent).not.toContain('gitWrite');
  });

  it('mantiene operativa la app si el registro de proyectos falla', async () => {
    await boot({ listWorkspaces: vi.fn(async () => Promise.reject(new Error('registro ilegible'))) });

    click('#nav-projects');
    expect(document.querySelector('[data-view="projects"]')?.textContent).toContain('registro ilegible');
    click('#nav-connection');
    expect(document.querySelector('#connect-tunnel')).not.toBeNull();
  });

  it('busca, redacta, copia y exporta el diagnóstico de sesión', async () => {
    let emitLog: ((line: string, stream: 'stdout' | 'stderr') => void) | undefined;
    const api = await boot({
      onTunnelLog: vi.fn((callback) => {
        emitLog = callback;
        return () => undefined;
      }),
    });
    emitLog?.('falló con sk-abcdefghijk', 'stderr');
    click('#nav-activity');
    setValue('#log-search', 'falló');

    expect(document.querySelector('#tunnel-log')?.textContent).toContain('falló');
    click('#copy-diagnostic');
    click('#export-diagnostic');

    await vi.waitFor(() => expect(api.copyDiagnostic).toHaveBeenCalled());
    expect(api.copyDiagnostic).toHaveBeenCalledWith(expect.stringContaining('[CLAVE REDACTADA]'));
    expect(api.exportDiagnostic).toHaveBeenCalledWith(expect.not.stringContaining('sk-abcdefghijk'));
  });

  it('guarda el comportamiento de bandeja y ofrece salida explícita', async () => {
    const api = await boot();
    click('#nav-settings');
    const checkbox = document.querySelector<HTMLInputElement>('input[name="minimizeToTray"]');
    if (checkbox === null) throw new Error('ajuste de bandeja no encontrado');
    checkbox.checked = false;
    submit('#behavior-settings-form');

    await vi.waitFor(() => expect(api.saveSettings).toHaveBeenCalledWith(expect.objectContaining({ minimizeToTray: false })));
    click('#hide-app');
    click('#quit-app');
    expect(api.hideApp).toHaveBeenCalledOnce();
    expect(api.quitApp).toHaveBeenCalledOnce();
  });
});

describe('renderer desktop — portabilidad y confianza', () => {
  it('cambia de perfil y carga únicamente la clave de la cuenta seleccionada', async () => {
    const second: DesktopSettings = {
      ...makeApiSettings(),
      activeConnectionProfileId: 'profile_work0000',
      connectionProfiles: [
        { id: 'profile_default0', name: 'Personal', tunnelId: '' },
        { id: 'profile_work0000', name: 'Trabajo', tunnelId: 'tunnel_0123456789abcdef0123456789abcdef' },
      ],
      tunnelId: 'tunnel_0123456789abcdef0123456789abcdef',
    };
    const api = await boot({
      getSettings: vi.fn(async () => ({ ...second, activeConnectionProfileId: 'profile_default0', tunnelId: '' })),
      selectConnectionProfile: vi.fn(async () => second),
      getTunnelKeyState: vi.fn(async () => ({ status: 'available' as const })),
    });
    click('#nav-settings');
    click('[data-select-profile="profile_work0000"]');

    await vi.waitFor(() => expect(api.selectConnectionProfile).toHaveBeenCalledWith('profile_work0000'));
    await vi.waitFor(() => expect(document.body.textContent).toContain('Clave secreta de runtime de Trabajo'));
    expect(document.querySelector<HTMLInputElement>('#api-key')?.value).toBe('');
    expect(document.body.textContent).toContain('guardada y cifrada por Windows');
  });

  it('prueba un proyecto y presenta checks accionables', async () => {
    const api = await boot({
      listWorkspaces: vi.fn(async () => [workspace()]),
      testWorkspace: vi.fn(async () => ({
        workspaceId: 'ws_demo',
        ready: false,
        checks: [{ ok: false, label: 'Toolchain pnpm', detail: 'No encontrado en este equipo', severity: 'error' as const }],
      })),
    });
    click('[data-action="test"]');

    await vi.waitFor(() => expect(api.testWorkspace).toHaveBeenCalledWith('ws_demo'));
    expect(document.body.textContent).toContain('No encontrado en este equipo');
  });

  it('remapea cada carpeta antes de habilitar una importación portable', async () => {
    const config = {
      format: 'localbridge-portable' as const,
      version: 1 as const,
      exportedAt: '2026-08-21T00:00:00.000Z',
      connections: [{ name: 'Trabajo', tunnelId: '' }],
      workspaces: [{
        ref: 'portable_0123456789abcdef', name: 'Importado', enabled: true,
        permissions: {
          read: true, write: false, overwrite: false, gitRead: false, validations: true, gitWrite: false,
          processes: false, browserRead: false, browserInteract: false,
          browserAuthenticate: false, browserManualControl: false,
        },
        limits: { maxFileBytes: 1024, maxTreeEntries: 30, maxTreeDepth: 2, largeArtifacts: { mode: 'standard' as const, reserve: { minimumFreeBytes: 1024 * 1024 * 1024, minimumFreePercent: 10 }, maxConcurrentJobs: 1 as const } },
        denyPatterns: ['.env'], validationProfiles: {}, processProfiles: {}, browserProfiles: {},
        automationReviewRequired: false,
      }],
    };
    const api = await boot({
      selectPortableImport: vi.fn(async () => ({ sessionId: '00000000-0000-4000-8000-000000000000', config })),
      applyPortableImport: vi.fn(async () => {
        const workspaces = [workspace({ name: 'Importado' })];
        return { settings: makeApiSettings(), registry: { schemaVersion: 5 as const, workspaces, applications: [] }, workspaces, applications: [], projects: [], importedProfileIds: ['profile_new00000'] };
      }),
    });
    click('#nav-settings');
    click('#select-portable-import');
    await vi.waitFor(() => expect(document.querySelector('[data-map-workspace]')).not.toBeNull());
    expect(document.querySelector<HTMLButtonElement>('#apply-portable-import')?.disabled).toBe(true);
    click('[data-map-workspace]');
    await vi.waitFor(() => expect(document.querySelector<HTMLButtonElement>('#apply-portable-import')?.disabled).toBe(false));
    click('#apply-portable-import');

    await vi.waitFor(() => expect(api.applyPortableImport).toHaveBeenCalled());
    expect(document.body.textContent).toContain('requieren una clave nueva');
  });

  it('muestra la auditoría en lenguaje humano y permite filtrarla', async () => {
    const api = await boot({
      listWorkspaces: vi.fn(async () => [workspace()]),
      listAuditEvents: vi.fn(async () => [{
        id: 'event_1', timestamp: '2026-08-21T00:00:00.000Z', requestId: 'req_1', workspaceId: 'ws_demo',
        action: 'file.read', riskLevel: 'R1', decision: 'allow' as const, outcome: 'success' as const, durationMs: 2,
      }]),
    });
    click('#nav-activity');

    await vi.waitFor(() => expect(api.listAuditEvents).toHaveBeenCalled());
    await vi.waitFor(() => expect(document.querySelector('#audit-events')?.textContent).toContain('Leyó un archivo'));
  });

  it('muestra una aprobación Git pendiente sin tratarla como éxito o error', async () => {
    await boot({
      listWorkspaces: vi.fn(async () => [workspace()]),
      listPendingApprovals: vi.fn(async () => [{
        id: 'approval_1',
        requestedAt: '2026-08-23T20:00:00.000Z',
        expiresAt: '2099-08-23T20:05:00.000Z',
        workspaceId: 'ws_demo',
        action: 'git.commit' as const,
      }]),
    });

    expect(document.body.textContent).toContain('Esperando confirmación del cliente MCP');
    expect(document.body.textContent).toContain('Crear commit');
    expect(document.body.textContent).toContain('Demo');
  });

  it('presenta terminales con proyecto y listeners verificados sin usar el ID como título', async () => {
    const projectId = `project_${'a'.repeat(24)}`;
    const terminalSessionId = `terminal_${'b'.repeat(24)}`;
    const listenerRef = `listener_${'c'.repeat(24)}`;
    const api = await boot({
      listDevelopmentActivity: vi.fn(async () => ({
        processes: [], browsers: [], applications: [],
        terminals: [{
          projectId,
          projectName: 'CIP Local',
          sessionId: terminalSessionId,
          state: 'running' as const,
          trustMode: 'full-host' as const,
          startedAt: '2026-08-26T23:00:00.000Z',
          deadline: '2026-08-27T07:00:00.000Z',
          nextCursor: 0,
          listeners: [{
            listenerRef,
            browserOrigin: 'http://localhost:5173',
            addressFamily: 'ipv6' as const,
            bindScope: 'loopback' as const,
            exclusive: true,
            port: 5173,
            observedAt: '2026-08-26T23:00:01.000Z',
          }],
        }, {
          projectId,
          projectName: 'CIP Local',
          sessionId: `terminal_${'d'.repeat(24)}`,
          state: 'running' as const,
          trustMode: 'full-host' as const,
          startedAt: '2026-08-26T23:01:00.000Z',
          deadline: '2026-08-27T07:01:00.000Z',
          nextCursor: 0,
          listeners: [],
        }],
      })),
    });
    click('#nav-activity');
    await vi.waitFor(() => expect(document.querySelector('.runtime-heading strong')?.textContent).toBe('CIP Local'));
    expect(document.querySelector('.runtime-heading')?.textContent).toContain('En ejecución');
    expect(document.querySelector('.runtime-listener')?.textContent).toContain('localhost:5173');
    expect(document.querySelector('.runtime-heading strong')?.textContent).not.toContain(projectId);
    expect(document.querySelectorAll('.runtime-project')).toHaveLength(1);
    expect(document.querySelectorAll('.runtime-terminal')).toHaveLength(2);
    expect(document.body.textContent).toContain('2 terminal(es) activa(s)');
    expect(document.body.textContent).toContain('fuera del control de ChatGPT');

    click('[data-terminal-open]');
    await vi.waitFor(() => expect(api.openTerminalListener).toHaveBeenCalledWith(projectId, terminalSessionId, listenerRef));
  });

  it('deshabilita la apertura de listeners no exclusivos', async () => {
    await boot({
      listDevelopmentActivity: vi.fn(async () => ({
        processes: [], browsers: [], applications: [], terminals: [{
          projectId: `project_${'d'.repeat(24)}`, projectName: 'Proyecto',
          sessionId: `terminal_${'e'.repeat(24)}`, state: 'running' as const, trustMode: 'full-host' as const,
          startedAt: '2026-08-26T23:00:00.000Z', deadline: '2026-08-27T07:00:00.000Z', nextCursor: 0,
          listeners: [{ listenerRef: `listener_${'f'.repeat(24)}`, browserOrigin: 'http://localhost:3007',
            addressFamily: 'ipv4' as const, bindScope: 'wildcard' as const, exclusive: false, port: 3007,
            observedAt: '2026-08-26T23:00:01.000Z' }],
        }],
      })),
    });
    click('#nav-activity');
    await vi.waitFor(() => expect(document.querySelector<HTMLButtonElement>('[data-terminal-open]')?.disabled).toBe(true));
    expect(document.body.textContent).toContain('Puerto no exclusivo');
    expect(document.body.textContent).toContain('Escucha en todas las redes');
    expect(document.body.textContent).toContain('Usa 127.0.0.1 o ::1');
  });

  it('abre y cierra la navegación compacta conservando el foco', async () => {
    await boot();
    click('#nav-toggle');
    expect(document.querySelector('#sidebar-navigation')?.classList.contains('sidebar-open')).toBe(true);
    expect(document.querySelector('#nav-toggle')?.getAttribute('aria-expanded')).toBe('true');
    click('#close-navigation');
    expect(document.querySelector('#sidebar-navigation')?.classList.contains('sidebar-open')).toBe(false);
    expect(document.activeElement?.id).toBe('nav-toggle');
  });

  it('pagina la auditoría larga sin perder los filtros', async () => {
    const events = Array.from({ length: 45 }, (_, index) => ({
      id: `event_${index}`, timestamp: new Date(2026, 7, 26, 20, 0, index).toISOString(), requestId: `req_${index}`,
      workspaceId: 'ws_demo', action: 'file.read', riskLevel: 'R1', decision: 'allow' as const,
      outcome: 'success' as const, durationMs: 1,
    }));
    await boot({ listWorkspaces: vi.fn(async () => [workspace()]), listAuditEvents: vi.fn(async () => events) });
    click('#nav-activity');
    await vi.waitFor(() => expect(document.querySelectorAll('.audit-row')).toHaveLength(20));
    click('#audit-show-more');
    expect(document.querySelectorAll('.audit-row')).toHaveLength(40);
    click('#audit-show-more');
    expect(document.querySelectorAll('.audit-row')).toHaveLength(45);
  });

  it('muestra el código causal seguro de un diagnóstico temporal', async () => {
    const event = {
      id: 'event_motion', timestamp: '2026-09-07T12:00:00.000Z', requestId: 'req_motion',
      workspaceId: 'ws_demo', action: 'web.motion.diagnostic', riskLevel: 'R2', decision: 'allow' as const,
      outcome: 'error' as const, errorCode: 'FILE_TOO_LARGE', durationMs: 1,
    };
    await boot({ listWorkspaces: vi.fn(async () => [workspace()]), listAuditEvents: vi.fn(async () => [event]) });
    click('#nav-activity');
    await vi.waitFor(() => expect(document.querySelector('.audit-row')?.textContent).toContain('FILE_TOO_LARGE'));
    expect(document.querySelector('.audit-row')?.textContent).toContain('Diagnosticó una captura temporal externa');
  });

  it('anida diagnósticos correlacionados y oculta diagnósticos correctos sin operación', async () => {
    const events = [{
      id: 'event_download', timestamp: '2026-09-07T12:00:00.000Z', requestId: 'req_download',
      workspaceId: 'ws_demo', action: 'web.download', riskLevel: 'R4', decision: 'deny' as const,
      outcome: 'error' as const, errorCode: 'WEB_MEDIA_TYPE_MISMATCH', operationId: 'download_1', durationMs: 5,
    }, {
      id: 'event_download_diag', timestamp: '2026-09-07T12:00:00.001Z', requestId: 'req_download_diag',
      workspaceId: 'ws_demo', action: 'web.download.diagnostic', riskLevel: 'R2', decision: 'allow' as const,
      outcome: 'error' as const, errorCode: 'WEB_MEDIA_TYPE_MISMATCH', operationId: 'download_1', durationMs: 0,
    }, {
      id: 'event_capture_diag', timestamp: '2026-09-07T12:00:01.000Z', requestId: 'req_capture_diag',
      workspaceId: 'ws_demo', action: 'web.screenshot.diagnostic', riskLevel: 'R2', decision: 'allow' as const,
      outcome: 'success' as const, durationMs: 0,
    }];
    await boot({ listWorkspaces: vi.fn(async () => [workspace()]), listAuditEvents: vi.fn(async () => events) });
    click('#nav-activity');
    await vi.waitFor(() => expect(document.querySelectorAll('.audit-row')).toHaveLength(1));
    expect(document.querySelector('.audit-diagnostics')?.textContent).toContain('WEB_MEDIA_TYPE_MISMATCH');
    expect(document.querySelector('#audit-events')?.textContent).not.toContain('Diagnosticó una captura web sin registrar contenido');
    expect(document.querySelector('.audit-summary')?.textContent).toContain('1 operaciones');
    expect(document.querySelector('.audit-summary')?.textContent).toContain('1 fallos reales');
    expect(document.querySelector('.audit-summary')?.textContent).toContain('0 recuperadas');
    expect(document.querySelector('.audit-summary')?.textContent).toContain('2 detalles');
  });

  it('marca como recuperada solo una operación exitosa cuyo diagnóstico confirma recuperación', async () => {
    const events = [{
      id: 'event_navigation', timestamp: '2026-09-07T12:00:00.000Z', requestId: 'req_navigation',
      action: 'web.navigate', riskLevel: 'R2', decision: 'allow' as const, outcome: 'success' as const,
      operationId: 'navigate_1', durationMs: 5,
    }, {
      id: 'event_navigation_diag', timestamp: '2026-09-07T12:00:00.001Z', requestId: 'req_navigation_diag',
      action: 'web.navigate.diagnostic', resource: 'session:tab:recovered', riskLevel: 'R2', decision: 'allow' as const,
      outcome: 'success' as const, errorCode: 'WEB_NAVIGATION_FAILED', operationId: 'navigate_1', durationMs: 0,
    }];
    await boot({ listAuditEvents: vi.fn(async () => events) });
    click('#nav-activity');
    await vi.waitFor(() => expect(document.querySelector('.audit-row')?.textContent).toContain('Recuperado'));
    expect(document.querySelector('.audit-summary')?.textContent).toContain('1 recuperadas');
  });

  it('agrupa texto, páginas renderizadas e imágenes en cobertura documental', async () => {
    const events = [{
      id: 'event_document_text', timestamp: '2026-09-08T12:00:00.000Z', requestId: 'req_document_text',
      workspaceId: 'ws_demo', action: 'document.read',
      resource: 'docs/report#final.pdf#textPages=1,2;total=5;sha=0123456789ab;mode=mixed;warnings=DOCUMENT_NO_TEXT', riskLevel: 'R2',
      decision: 'allow' as const, outcome: 'success' as const, durationMs: 4,
    }, {
      id: 'event_document_render', timestamp: '2026-09-08T12:00:01.000Z', requestId: 'req_document_render',
      workspaceId: 'ws_demo', action: 'document.render',
      resource: 'docs/report#final.pdf#pages=1,2,3;total=5;sha=0123456789ab;warnings=none', riskLevel: 'R2',
      decision: 'allow' as const, outcome: 'success' as const, durationMs: 20,
    }, {
      id: 'event_image', timestamp: '2026-09-08T12:00:02.000Z', requestId: 'req_image',
      workspaceId: 'ws_demo', action: 'image.read',
      resource: 'images/chart.png#image=1;sha=fedcba987654;mime=image/png', riskLevel: 'R2',
      decision: 'allow' as const, outcome: 'success' as const, durationMs: 3,
    }];
    await boot({ listWorkspaces: vi.fn(async () => [workspace()]), listAuditEvents: vi.fn(async () => events) });
    click('#nav-activity');
    await vi.waitFor(() => expect(document.querySelector('#document-coverage')?.textContent).toContain('3 página(s) preparadas'));
    const coverage = document.querySelector('#document-coverage')?.textContent;
    expect(coverage).toContain('2 archivo(s)');
    expect(coverage).toContain('1 con texto');
    expect(coverage).toContain('2 visual(es)');
    expect(coverage).toContain('report#final.pdf');
    expect(coverage).toContain('chart.png');
    expect(coverage).toContain('2 página(s) con texto extraído');
    expect(coverage).toContain('3/5 página(s) renderizada(s)');
    expect(coverage).toContain('modo mixed');
    expect(coverage).toContain('SHA-256 0123456789ab…');
    expect(coverage).toContain('1 aviso(s)');
  });
});

describe('renderer desktop — navegador web cotidiano', () => {
  it('mantiene Desarrollo y Acceso a Internet y lleva la operación a Actividad', async () => {
    await boot();
    click('[data-section-target="activity"]');
    expect(document.querySelector('[data-view="activity"]')?.hasAttribute('hidden')).toBe(false);
    click('#nav-web');
    expect(document.querySelector('[data-view="web"]')?.hasAttribute('hidden')).toBe(false);
    expect(document.querySelector('[data-view="web"]')?.textContent).toContain('Las sesiones y la toma de control aparecen en Actividad');
    click('#nav-assisted');
    expect(document.querySelector('[data-view="assisted"]')?.hasAttribute('hidden')).toBe(false);
  });

  it('habilita la navegación pública con una sola acción local', async () => {
    const enabled = webProfile({ enabled: true });
    const enableWebBrowsing = vi.fn(async () => ({
      state: 'ready' as const,
      document: { schemaVersion: 1 as const, profiles: [enabled] },
      sha256: 'b'.repeat(64),
    }));
    await boot({ enableWebBrowsing });
    click('#nav-web');
    expect(document.body.textContent).toContain('Habilitar navegación por Internet');
    click('#enable-web-browsing');
    await vi.waitFor(() => expect(enableWebBrowsing).toHaveBeenCalledWith(null, false));
    await vi.waitFor(() => expect(document.body.textContent).toContain('Navegación por Internet habilitada'));
  });

  it('reúne navegadores LOCAL e INTERNET y permite tomar una sesión pública activa', async () => {
    const project = workspace({
      permissions: { ...PERMISSIONS, browserRead: true, browserInteract: true, browserHumanControl: true },
    });
    const sessionId = `websession_${'c'.repeat(24)}`;
    const tabId = `webtab_${'d'.repeat(24)}`;
    const takeWebHumanControl = vi.fn(async () => undefined);
    const listWebActivity = vi.fn(async () => [{
      sessionId, webProfileId: webProfile().id, profileName: 'Público', profileKind: 'public-research' as const,
      state: 'running' as const, startedAt: '2026-09-06T12:00:00.000Z', controlState: 'agent_control' as const, tabCount: 1,
    }]);
    await boot({
      listWorkspaces: vi.fn(async () => [project]),
      listDevelopmentActivity: vi.fn(async () => ({
        processes: [], applications: [], terminals: [],
        browsers: [{
          workspaceId: project.id, sessionId: `session_${'a'.repeat(24)}`, profile: 'dev', state: 'running' as const,
          title: 'Local', path: '/', startedAt: '2026-09-06T12:00:00.000Z', controlState: 'agent_control' as const,
        }],
      })),
      listWebActivity,
      listWebTabs: vi.fn(async () => [{ tabId, title: 'Sitio', url: 'https://example.com/', state: 'ready' as const, openedAt: '2026-09-06T12:00:00.000Z' }]),
      takeWebHumanControl,
    });
    click('#nav-activity');
    await vi.waitFor(() => expect(listWebActivity.mock.calls.length).toBeGreaterThanOrEqual(2));
    await vi.waitFor(() => expect(document.querySelectorAll('[data-view="activity"] .source-pill')).toHaveLength(2));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(document.querySelector('[data-view="activity"]')?.textContent).toContain('LOCAL');
    expect(document.querySelector('[data-view="activity"]')?.textContent).toContain('INTERNET');
    click(`[data-web-take="${sessionId}"]`);
    await vi.waitFor(() => expect(takeWebHumanControl).toHaveBeenCalledWith(sessionId, tabId));
  });

  it('muestra 1920x1080 como baseline y aplica presets distintos en LOCAL e INTERNET', async () => {
    const project = workspace({ permissions: { ...PERMISSIONS, browserRead: true, browserInteract: true } });
    const browserSessionId = `session_${'a'.repeat(24)}`;
    const webSessionId = `websession_${'c'.repeat(24)}`;
    const tabId = `webtab_${'d'.repeat(24)}`;
    const setBrowserViewport = vi.fn(async () => undefined);
    const setWebViewport = vi.fn(async () => undefined);
    await boot({
      listWorkspaces: vi.fn(async () => [project]),
      listDevelopmentActivity: vi.fn(async () => ({
        processes: [], applications: [], terminals: [],
        browsers: [{
          workspaceId: project.id, sessionId: browserSessionId, profile: 'dev', state: 'running' as const,
          title: 'Local', path: '/', startedAt: '2026-09-06T12:00:00.000Z', controlState: 'agent_control' as const,
          viewport: { width: 1920, height: 1080, mobile: false },
        }],
      })),
      listWebActivity: vi.fn(async () => [{
        sessionId: webSessionId, webProfileId: webProfile().id, profileName: 'Público', profileKind: 'public-research' as const,
        state: 'running' as const, startedAt: '2026-09-06T12:00:00.000Z', controlState: 'agent_control' as const, tabCount: 1,
      }]),
      listWebTabs: vi.fn(async () => [{
        tabId, title: 'Referencia', url: 'https://example.com/', state: 'ready' as const,
        openedAt: '2026-09-06T12:00:00.000Z', viewport: { width: 1920, height: 1080, mobile: false },
      }]),
      setBrowserViewport,
      setWebViewport,
    });
    click('#nav-activity');
    await vi.waitFor(() => expect(document.querySelector(`[data-browser-viewport="${browserSessionId}"]`)).not.toBeNull());
    await vi.waitFor(() => expect(document.querySelector(`[data-web-viewport="${webSessionId}"]`)).not.toBeNull());
    expect(document.querySelector('[data-view="activity"]')?.textContent).toContain('Render: 1920×1080');

    click(`[data-browser-viewport="${browserSessionId}"][data-viewport-width="390"]`);
    click(`[data-web-viewport="${webSessionId}"][data-viewport-width="1440"]`);
    await vi.waitFor(() => expect(setBrowserViewport).toHaveBeenCalledWith(project.id, browserSessionId, 390, 844, true));
    await vi.waitFor(() => expect(setWebViewport).toHaveBeenCalledWith(webSessionId, tabId, 1440, 900, false));
  });

  it('muestra el progreso de capturas temporales LOCAL e INTERNET en Actividad', async () => {
    const project = workspace({ permissions: { ...PERMISSIONS, browserRead: true, browserInteract: true } });
    const webSessionId = `websession_${'c'.repeat(24)}`;
    const api = await boot({
      listWorkspaces: vi.fn(async () => [project]),
      listDevelopmentActivity: vi.fn(async () => ({
        processes: [], applications: [], terminals: [],
        browsers: [{
          workspaceId: project.id, sessionId: `session_${'a'.repeat(24)}`, profile: 'dev', state: 'running' as const,
          title: 'Local', path: '/', startedAt: '2026-09-06T12:00:00.000Z', controlState: 'agent_control' as const,
          motionCapture: { completed: 4, total: 12, mode: 'stepped' as const },
          lastMotionCapture: { path: 'evidence/scroll.lbmotion', frameCount: 12, totalSize: 2048, captureMode: 'stepped' as const, warnings: [] },
        }],
      })),
      listWebActivity: vi.fn(async () => [{
        sessionId: webSessionId, webProfileId: webProfile().id, profileName: 'Público', profileKind: 'public-research' as const,
        state: 'running' as const, startedAt: '2026-09-06T12:00:00.000Z', controlState: 'agent_control' as const, tabCount: 1,
      }]),
      listWebTabs: vi.fn(async () => [{
        tabId: `webtab_${'d'.repeat(24)}`, title: 'Referencia', url: 'https://example.com/', state: 'ready' as const,
        openedAt: '2026-09-06T12:00:00.000Z', motionCapture: { completed: 7, total: 12, mode: 'screencast' as const },
      }]),
    });
    click('#nav-activity');
    await vi.waitFor(() => expect(document.querySelectorAll('[data-view="activity"] .motion-progress')).toHaveLength(2));
    expect(document.querySelector('[data-view="activity"]')?.textContent).toContain('Capturando movimiento 4/12');
    expect(document.querySelector('[data-view="activity"]')?.textContent).toContain('Capturando movimiento 7/12');
    expect(document.querySelector('[data-view="activity"]')?.textContent).toContain('evidence/scroll.lbmotion');
    expect([...document.querySelectorAll<HTMLProgressElement>('[data-view="activity"] progress')].map((item) => item.value)).toEqual([4, 7]);
    expect(document.querySelectorAll('[data-view="activity"] [data-browser-cancel-motion], [data-view="activity"] [data-web-cancel-motion]')).toHaveLength(2);
    click('[data-browser-cancel-motion]');
    click('[data-web-cancel-motion]');
    await vi.waitFor(() => expect(api.cancelBrowserMotion).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(api.cancelWebMotion).toHaveBeenCalledTimes(1));
  });

  it('ordena una intervención INTERNET antes de un navegador LOCAL normal', async () => {
    await boot({
      listDevelopmentActivity: vi.fn(async () => ({
        processes: [], applications: [], terminals: [],
        browsers: [{
          workspaceId: 'ws_demo', sessionId: `session_${'a'.repeat(24)}`, profile: 'dev', state: 'running' as const,
          title: 'Local', path: '/', startedAt: '2026-09-06T11:00:00.000Z', controlState: 'agent_control' as const,
        }],
      })),
      listWebActivity: vi.fn(async () => [{
        sessionId: `websession_${'c'.repeat(24)}`, webProfileId: webProfile().id, profileName: 'Intervención',
        profileKind: 'public-research' as const, state: 'running' as const, startedAt: '2026-09-06T12:00:00.000Z',
        controlState: 'waiting_for_human' as const, tabCount: 1,
      }]),
    });
    click('#nav-activity');
    await vi.waitFor(() => expect(document.querySelectorAll('[data-view="activity"] .source-pill')).toHaveLength(2));
    expect([...document.querySelectorAll('[data-view="activity"] .source-pill')].map((entry) => entry.textContent)).toEqual(['INTERNET', 'LOCAL']);
    expect(document.querySelector('#stop-all-development')?.textContent).toBe('Detener entorno de desarrollo');
    expect(document.querySelector('[data-web-stop]')?.textContent).toBe('Cerrar sesión y borrar estado');
  });

  it('bloquea un doble clic al tomar control de una sesión web', async () => {
    const sessionId = `websession_${'c'.repeat(24)}`;
    const tabId = `webtab_${'d'.repeat(24)}`;
    let resolveTake!: () => void;
    const takeWebHumanControl = vi.fn(() => new Promise<void>((resolve) => { resolveTake = resolve; }));
    const listWebActivity = vi.fn(async () => [{
      sessionId, webProfileId: webProfile().id, profileName: 'Público', profileKind: 'public-research' as const,
      state: 'running' as const, startedAt: '2026-09-06T12:00:00.000Z', controlState: 'agent_control' as const, tabCount: 1,
    }]);
    await boot({
      listWebActivity,
      listWebTabs: vi.fn(async () => [{
        tabId, title: 'Sitio', url: 'https://example.com/', state: 'ready' as const, openedAt: '2026-09-06T12:00:00.000Z',
      }]),
      takeWebHumanControl,
    });
    click('#nav-activity');
    await vi.waitFor(() => expect(listWebActivity.mock.calls.length).toBeGreaterThanOrEqual(2));
    await new Promise((resolve) => setTimeout(resolve, 20));
    await vi.waitFor(() => expect(document.querySelector(`[data-web-take="${sessionId}"]`)).not.toBeNull());
    const button = document.querySelector<HTMLButtonElement>(`[data-web-take="${sessionId}"]`)!;
    button.click();
    button.click();
    expect(button.disabled).toBe(true);
    expect(button.textContent).toBe('Entregando control…');
    expect(takeWebHumanControl).toHaveBeenCalledTimes(1);
    resolveTake();
  });

  it('filtra actividad sin perder el foco del control elegido', async () => {
    await boot({
      listDevelopmentActivity: vi.fn(async () => ({
        browsers: [], applications: [], terminals: [],
        processes: [{
          workspaceId: 'ws_demo', processId: `process_${'a'.repeat(24)}`, profile: 'dev', state: 'running' as const,
          startedAt: '2026-09-06T12:00:00.000Z', deadline: '2026-09-06T13:00:00.000Z', listeners: [],
        }],
      })),
    });
    click('#nav-activity');
    const filter = document.querySelector<HTMLButtonElement>('#activity-filter-browsers');
    if (filter === null) throw new Error('filtro de navegadores no encontrado');
    filter.focus();
    if (document.scrollingElement !== null) document.scrollingElement.scrollTop = 240;
    filter.click();
    expect(document.activeElement?.id).toBe('activity-filter-browsers');
    expect(document.scrollingElement?.scrollTop).toBe(240);
    expect(document.querySelector('[data-view="activity"] #development-activity')?.textContent).not.toContain('Servidor · dev');
    expect(document.querySelector('#activity-filter-browsers')?.getAttribute('aria-pressed')).toBe('true');
  });

  it('abre la vista web local en seguimiento o fijada sin exponer consultas', async () => {
    const sessionId = `websession_${'c'.repeat(24)}`;
    const tabId = `webtab_${'d'.repeat(24)}`;
    const showWebLiveViewer = vi.fn(async () => undefined);
    const listWebTabs = vi.fn(async () => [{
      tabId,
      title: '<img src=x onerror=alert(1)> Resultados',
      url: 'https://example.com/search?secret=abc#private',
      state: 'ready' as const,
      openedAt: '2026-09-06T12:00:00.000Z',
    }]);
    const api = await boot({
      listWebActivity: vi.fn(async () => [{
        sessionId, webProfileId: webProfile().id, profileName: 'Investigación pública', profileKind: 'public-research' as const,
        state: 'running' as const, startedAt: '2026-09-06T12:00:00.000Z', controlState: 'agent_control' as const, tabCount: 1,
      }]),
      getWebLiveViewerState: vi.fn(async () => ({
        visible: false as const,
        displays: [{ id: '101', ordinal: 1, label: 'Principal', isPrimary: true }],
        recommendedDisplayId: '101',
      })),
      listWebTabs,
      showWebLiveViewer,
    });
    click('#nav-activity');
    await vi.waitFor(() => expect(document.querySelector('[data-web-view-pinned]')).not.toBeNull());
    expect(document.querySelector('.web-tab-row img')).toBeNull();
    expect(document.body.textContent).toContain('<img src=x onerror=alert(1)> Resultados');
    expect(document.body.textContent).toContain('example.com/search');
    expect(document.body.textContent).not.toContain('secret=abc');
    click('[data-web-view-follow]');
    await vi.waitFor(() => expect(showWebLiveViewer).toHaveBeenCalledWith(sessionId, 'follow', '101', undefined, 'fit'));
    click('[data-web-view-pinned]');
    await vi.waitFor(() => expect(showWebLiveViewer).toHaveBeenCalledWith(sessionId, 'pinned', '101', tabId, 'fit'));
    expect(api.listWebTabs).toHaveBeenCalledWith(sessionId);
  });

  it('explica la frontera y habilita un perfil solo mediante acción local', async () => {
    const profile = webProfile();
    const snapshot = { state: 'ready' as const, document: { schemaVersion: 1 as const, profiles: [profile] }, sha256: 'd'.repeat(64) };
    const updateWebProfile = vi.fn(async (_hash: string | null, next: WebProfile) => ({
      state: 'ready' as const,
      document: { schemaVersion: 1 as const, profiles: [next] },
      sha256: 'e'.repeat(64),
    }));
    const api = await boot({ getWebProfiles: vi.fn(async () => snapshot), updateWebProfile });
    click('#nav-web');

    expect(document.body.textContent).toContain('No usa tu Chrome personal ni controla aplicaciones de Windows');
    expect(document.body.textContent).toContain('Loopback, LAN, link-local, metadata');
    expect(document.body.textContent).toContain('no requiere conexiones entrantes desde redes privadas o públicas');
    expect(document.querySelector(`[data-web-toggle="${profile.id}"]`)?.textContent).toContain('Habilitar acceso');
    click(`[data-web-toggle="${profile.id}"]`);
    await vi.waitFor(() => expect(updateWebProfile).toHaveBeenCalledWith('d'.repeat(64), expect.objectContaining({ id: profile.id, enabled: true })));
    expect(api.createWebProfile).not.toHaveBeenCalled();
  });

  it('guarda permisos separados y no convierte investigación pública en inicio de sesión', async () => {
    const profile = webProfile();
    const snapshot = { state: 'ready' as const, document: { schemaVersion: 1 as const, profiles: [profile] }, sha256: 'a'.repeat(64) };
    const updateWebProfile = vi.fn(async (_hash: string | null, next: WebProfile) => ({ ...snapshot, document: { schemaVersion: 1 as const, profiles: [next] } }));
    await boot({ getWebProfiles: vi.fn(async () => snapshot), updateWebProfile });
    click('#nav-web');
    const download = document.querySelector<HTMLInputElement>(`input[data-web-profile="${profile.id}"][data-web-permission="download"]`);
    if (download === null) throw new Error('permiso de descarga no encontrado');
    download.checked = true;
    const assetLimit = document.querySelector<HTMLSelectElement>(`select[data-web-profile="${profile.id}"][data-web-limit="maxDownloadBytes"]`);
    const totalLimit = document.querySelector<HTMLSelectElement>(`select[data-web-profile="${profile.id}"][data-web-limit="maxTotalDownloadBytes"]`);
    if (assetLimit === null || totalLimit === null) throw new Error('cuotas web no encontradas');
    expect([...assetLimit.options].map((option) => option.value)).toContain(String(1024 * 1024 * 1024));
    assetLimit.value = String(100 * 1024 * 1024);
    totalLimit.value = String(2 * 1024 * 1024 * 1024);
    click(`[data-web-save="${profile.id}"]`);
    await vi.waitFor(() => expect(updateWebProfile).toHaveBeenCalledWith('a'.repeat(64), expect.objectContaining({
      permissions: { read: true, interact: true, download: true, humanControl: false },
      limits: expect.objectContaining({ maxDownloadBytes: 100 * 1024 * 1024, maxTotalDownloadBytes: 2 * 1024 * 1024 * 1024 }),
    })));
  });

  it('falla cerrado con registro corrupto y restablece usando el hash observado', async () => {
    const corrupt = { state: 'corrupt' as const, document: { schemaVersion: 1 as const, profiles: [] }, sha256: 'f'.repeat(64) };
    const resetWebProfiles = vi.fn(async () => ({ state: 'ready' as const, document: { schemaVersion: 1 as const, profiles: [] }, sha256: '1'.repeat(64) }));
    await boot({ getWebProfiles: vi.fn(async () => corrupt), resetWebProfiles });
    click('#nav-web');
    expect(document.body.textContent).toContain('acceso está bloqueado');
    expect(document.querySelector<HTMLButtonElement>('#add-public-web-profile')?.disabled).toBe(true);
    click('#reset-web-profiles');
    await vi.waitFor(() => expect(resetWebProfiles).toHaveBeenCalledWith('f'.repeat(64)));
  });

  it('muestra el handoff y entrega control únicamente desde la UI local', async () => {
    const profile = webProfile({
      kind: 'site-account', destinations: [{ hostname: 'example.com', includeSubdomains: true }],
      permissions: { read: true, interact: true, download: false, humanControl: true },
    });
    const takeWebHumanControl = vi.fn(async () => undefined);
    const listWebTabs = vi.fn(async () => [{ tabId: `webtab_${'d'.repeat(24)}`, title: 'Privado', url: 'https://example.com/private', state: 'ready' as const, openedAt: '2026-09-05T00:00:00.000Z' }]);
    await boot({
      getWebProfiles: vi.fn(async () => ({ state: 'ready' as const, document: { schemaVersion: 1 as const, profiles: [profile] }, sha256: 'a'.repeat(64) })),
      listWebActivity: vi.fn(async () => [{
        sessionId: `websession_${'b'.repeat(24)}`, webProfileId: profile.id, profileName: profile.name, profileKind: profile.kind,
        state: 'running' as const, startedAt: '2026-09-05T00:00:00.000Z', controlState: 'waiting_for_human' as const, tabCount: 1,
      }]),
      listWebTabs,
      takeWebHumanControl,
    });
    click('#nav-activity');
    expect(document.body.textContent).toContain('ChatGPT pausado');
    expect(document.body.textContent).not.toContain('Privado');
    expect(listWebTabs).not.toHaveBeenCalled();
    click(`[data-web-take="websession_${'b'.repeat(24)}"]`);
    await vi.waitFor(() => expect(takeWebHumanControl).toHaveBeenCalledWith(`websession_${'b'.repeat(24)}`, undefined));
  });
});

describe('renderer desktop — control humano y visor local', () => {
  it('abre un visor de solo lectura, muestra el frame efímero y deja de capturar al ocultarlo', async () => {
    const project = workspace({
      permissions: { ...PERMISSIONS, browserRead: true, browserInteract: true, browserHumanControl: true },
    });
    const api = await boot({
      listWorkspaces: vi.fn(async () => [project]),
      listDevelopmentActivity: vi.fn(async () => ({
        processes: [], applications: [],
        browsers: [{
          workspaceId: project.id,
          sessionId: 'session_aaaaaaaaaaaaaaaaaaaaaaaa',
          profile: 'dev', state: 'running' as const, title: 'App', path: '/form',
          startedAt: '2026-08-25T00:00:00.000Z', controlState: 'agent_control' as const,
        }],
      })),
      captureBrowserViewer: vi.fn(async (sessionId) => ({
        state: 'ready' as const,
        sessionId,
        dataUrl: 'data:image/png;base64,cG5n',
        width: 1280,
        height: 800,
        path: '/form',
        capturedAt: '2026-08-25T00:00:01.000Z',
      })),
    });
    click('#nav-activity');
    await vi.waitFor(() => expect(document.querySelector('[data-view-browser]')).not.toBeNull());
    click('[data-view-browser]');

    await vi.waitFor(() => expect(api.captureBrowserViewer).toHaveBeenCalledWith('session_aaaaaaaaaaaaaaaaaaaaaaaa'));
    await vi.waitFor(() => expect(document.querySelector<HTMLImageElement>('#browser-viewer-image')?.src).toContain('data:image/png'));
    expect(document.querySelector('#browser-viewer-path')?.textContent).toContain('/form');
    const dialog = document.querySelector<HTMLElement>('.browser-viewer-backdrop');
    expect(dialog?.getAttribute('role')).toBe('dialog');
    expect(document.activeElement?.id).toBe('close-browser-viewer');
    dialog?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    expect(document.activeElement?.hasAttribute('data-show-live-browser')).toBe(true);
    dialog?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true }));
    expect(document.activeElement?.id).toBe('close-browser-viewer');
    dialog?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(document.querySelector('.browser-viewer-backdrop')).toBeNull();
  });

  it('oculta el frame y ofrece control local cuando la intervención humana está pendiente', async () => {
    const project = workspace({
      permissions: { ...PERMISSIONS, browserRead: true, browserInteract: true, browserHumanControl: true },
    });
    const api = await boot({
      listWorkspaces: vi.fn(async () => [project]),
      listDevelopmentActivity: vi.fn(async () => ({
        processes: [], applications: [],
        browsers: [{
          workspaceId: project.id,
          sessionId: 'session_bbbbbbbbbbbbbbbbbbbbbbbb',
          profile: 'dev', state: 'running' as const, title: 'Carga', path: '/upload',
          startedAt: '2026-08-25T00:00:00.000Z', controlState: 'waiting_for_human' as const,
          humanReason: 'file_selection' as const,
        }],
      })),
    });
    click('#nav-activity');
    await vi.waitFor(() => expect(document.body.textContent).toContain('ChatGPT necesita tu intervención: selección de archivo'));
    expect(document.querySelector('[data-view-browser]')).toBeNull();
    click('[data-human-take]');
    await vi.waitFor(() => expect(api.takeBrowserHumanControl).toHaveBeenCalledWith('session_bbbbbbbbbbbbbbbbbbbbbbbb'));
  });

  it('bloquea doble clic mientras entrega el control humano', async () => {
    const project = workspace({
      permissions: { ...PERMISSIONS, browserRead: true, browserInteract: true, browserHumanControl: true },
    });
    let resolveTake!: () => void;
    const takeBrowserHumanControl = vi.fn(() => new Promise<void>((resolve) => { resolveTake = resolve; }));
    await boot({
      listWorkspaces: vi.fn(async () => [project]),
      listDevelopmentActivity: vi.fn(async () => ({
        processes: [], applications: [], browsers: [{
          workspaceId: project.id,
          sessionId: 'session_eeeeeeeeeeeeeeeeeeeeeeee',
          profile: 'dev', state: 'running' as const, title: 'App', path: '/',
          startedAt: '2026-08-25T00:00:00.000Z', controlState: 'agent_control' as const,
        }],
      })),
      takeBrowserHumanControl,
    });
    click('#nav-activity');
    await vi.waitFor(() => expect(document.querySelector('[data-human-take]')).not.toBeNull());
    const button = document.querySelector<HTMLButtonElement>('[data-human-take]')!;
    button.click();
    button.click();

    expect(button.disabled).toBe(true);
    expect(button.textContent).toContain('Entregando control');
    expect(takeBrowserHumanControl).toHaveBeenCalledTimes(1);
    resolveTake();
  });

  it('abre la ventana en vivo, evita el visor por capturas y permite ocultarla', async () => {
    const project = workspace({
      permissions: { ...PERMISSIONS, browserRead: true, browserInteract: true, browserHumanControl: true },
    });
    const sessionId = 'session_cccccccccccccccccccccccc';
    let liveViewerSessionId: string | undefined;
    let liveViewerDisplayId: string | undefined;
    const displays = [
      { id: '101', ordinal: 1, label: 'Monitor principal', isPrimary: true },
      { id: '202', ordinal: 2, label: 'Monitor lateral', isPrimary: false },
    ];
    const listDevelopmentActivity = vi.fn(async () => ({
      processes: [], applications: [], displays, recommendedDisplayId: '101',
      ...(liveViewerSessionId === undefined ? {} : {
        liveViewerSessionId,
        ...(liveViewerDisplayId === undefined ? {} : { liveViewerDisplayId }),
      }),
      browsers: [{
        workspaceId: project.id,
        sessionId,
        profile: 'dev', state: 'running' as const, title: 'App', path: '/video',
        startedAt: '2026-08-25T00:00:00.000Z', controlState: 'agent_control' as const,
        ...(liveViewerSessionId === undefined ? {} : { viewerPresentation: {
          mode: 'fit' as const, renderWidth: 1920, renderHeight: 1080,
          viewWidth: 1536, viewHeight: 864, scale: 0.8, panX: 0, panY: 0,
        } }),
      }],
    }));
    const showBrowserLiveViewer = vi.fn(async (_sessionId: string, displayId?: string) => {
      liveViewerSessionId = sessionId;
      liveViewerDisplayId = displayId ?? '101';
    });
    const moveBrowserLiveViewer = vi.fn(async (_sessionId: string, displayId: string) => { liveViewerDisplayId = displayId; });
    const hideBrowserLiveViewer = vi.fn(async () => { liveViewerSessionId = undefined; });
    const setBrowserLiveViewerPresentation = vi.fn(async () => undefined);
    const api = await boot({
      listWorkspaces: vi.fn(async () => [project]),
      listDevelopmentActivity,
      showBrowserLiveViewer,
      moveBrowserLiveViewer,
      hideBrowserLiveViewer,
      setBrowserLiveViewerPresentation,
    });
    click('#nav-activity');
    await vi.waitFor(() => expect(document.querySelector('[data-show-live-browser]')).not.toBeNull());

    setValue('[data-live-display]', '202');
    document.querySelector<HTMLSelectElement>('[data-live-display]')?.dispatchEvent(new Event('change', { bubbles: true }));
    click('[data-show-live-browser]');
    await vi.waitFor(() => expect(showBrowserLiveViewer).toHaveBeenCalledWith(sessionId, '202', 'fit'));
    await vi.waitFor(() => expect(document.body.textContent).toContain('ventana en vivo abierta'));
    expect(api.captureBrowserViewer).not.toHaveBeenCalled();
    expect(document.querySelector('[data-view-browser]')).toBeNull();
    expect(window.localStorage.getItem('localbridge.liveViewerDisplayId')).toBe('202');
    await vi.waitFor(() => expect(document.body.textContent).toContain('Render 1920×1080 · visible 1536×864 · 80%'));
    click('[data-viewer-presentation="browser"][data-mode="actual"]');
    await vi.waitFor(() => expect(setBrowserLiveViewerPresentation).toHaveBeenCalledWith(sessionId, 'actual', 0, 0));
    expect(window.localStorage.getItem('localbridge.liveViewerPresentationMode')).toBe('actual');

    setValue('[data-live-display]', '101');
    document.querySelector<HTMLSelectElement>('[data-live-display]')?.dispatchEvent(new Event('change', { bubbles: true }));
    await vi.waitFor(() => expect(moveBrowserLiveViewer).toHaveBeenCalledWith(sessionId, '101'));

    click('[data-hide-live-browser]');
    await vi.waitFor(() => expect(hideBrowserLiveViewer).toHaveBeenCalledWith(sessionId));
    await vi.waitFor(() => expect(document.querySelector('[data-show-live-browser]')).not.toBeNull());
  });

  it('cambia del visor ligero a la ventana en vivo sin mantener capturas activas', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const project = workspace({ permissions: { ...PERMISSIONS, browserRead: true, browserInteract: true } });
    const sessionId = 'session_dddddddddddddddddddddddd';
    const captureBrowserViewer = vi.fn(async () => ({
      state: 'ready' as const, sessionId, dataUrl: 'data:image/png;base64,cG5n', width: 1280, height: 800,
      path: '/video', capturedAt: '2026-08-25T00:00:01.000Z',
    }));
    const api = await boot({
      listWorkspaces: vi.fn(async () => [project]),
      listDevelopmentActivity: vi.fn(async () => ({
        processes: [], applications: [], browsers: [{
          workspaceId: project.id, sessionId, profile: 'dev', state: 'running' as const, title: 'App', path: '/video',
          startedAt: '2026-08-25T00:00:00.000Z', controlState: 'agent_control' as const,
        }],
      })),
      captureBrowserViewer,
    });
    click('#nav-activity');
    await vi.waitFor(() => expect(document.querySelector('[data-view-browser]')).not.toBeNull());
    click('[data-view-browser]');
    await vi.waitFor(() => expect(captureBrowserViewer).toHaveBeenCalledTimes(1));
    click('[data-show-live-browser]');
    await vi.waitFor(() => expect(api.showBrowserLiveViewer).toHaveBeenCalledWith(sessionId, undefined, 'fit'));
    await vi.waitFor(() => expect(document.querySelector('.browser-viewer-backdrop')).toBeNull());
    await vi.advanceTimersByTimeAsync(2_000);
    expect(captureBrowserViewer).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});
