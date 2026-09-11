/** Modelo de datos de MASTER_SPEC.md §8. */

export interface WorkspacePermissions {
  readonly read: boolean;
  readonly write: boolean;
  readonly overwrite: boolean;
  readonly gitRead: boolean;
  readonly validations: boolean;
  /** `git.stage`/`git.commit`/`git.push` — cada mutación además exige aprobación humana (ADR-0016). */
  readonly gitWrite: boolean;
  /** Inicia y detiene exclusivamente perfiles de proceso aprobados por el humano. */
  readonly processes?: boolean;
  /** Abre perfiles web loopback y permite observar su estado sin interactuar. */
  readonly browserRead?: boolean;
  /** Interactúa con elementos referenciados por un snapshot vigente. Requiere `browserRead`. */
  readonly browserInteract?: boolean;
  /** Entrega temporalmente al usuario el navegador con exclusión mutua del agente. Requiere `browserRead`. */
  readonly browserHumanControl?: boolean;
}

export type ProcessProfileSource =
  | {
      readonly kind: "package-script";
      /** Ruta relativa segura; permite manifests de paquetes dentro de un monorepo. */
      readonly manifestPath: string;
      readonly script: string;
      readonly definitionSha256: string;
    }
  | {
      readonly kind: "composer-script";
      readonly manifestPath: string;
      readonly script: string;
      readonly definitionSha256: string;
    }
  | {
      readonly kind: "make-target";
      readonly manifestPath: string;
      readonly target: string;
      readonly definitionSha256: string;
    };

export interface ProcessProfile {
  readonly command: readonly string[];
  /** Directorio relativo al root autorizado; `.` representa el root. */
  readonly cwd: string;
  readonly source: ProcessProfileSource;
  readonly maxRuntimeSeconds: number;
}

export interface BrowserProfile {
  /** Origen HTTP loopback exacto, incluido el puerto. */
  readonly origin: string;
  /** Allowlist exacta de orígenes loopback accesibles durante la sesión. */
  readonly allowedOrigins: readonly string[];
  readonly viewport: {
    readonly width: number;
    readonly height: number;
  };
  readonly linkedProcessProfile?: string | undefined;
}

export interface BrowserApplicationService {
  /** Workspace ya autorizado que posee el perfil de proceso. */
  readonly workspaceId: string;
  readonly processProfile: string;
  /** Orden declarativo para que el agente inicie los perfiles de forma determinista. */
  readonly startupOrder: number;
  /** Conserva `localhost` del proyecto o usa el origen IP literal detectado. */
  readonly hostMode: "manual-localhost" | "listener-literal";
  /** Consentimiento local explícito para un bind wildcard propiedad del Job. */
  readonly allowManagedWildcard: boolean;
}

export interface BrowserApplicationProfile {
  readonly primaryService: string;
  readonly services: Readonly<Record<string, BrowserApplicationService>>;
  readonly viewport: {
    readonly width: number;
    readonly height: number;
  };
}

export type ApplicationReviewState = "reviewed" | "needs-review" | "conflict";

/** Servicio persistido en una aplicación global del registro v3. */
export interface LocalApplicationService extends BrowserApplicationService {
  readonly id: string;
  readonly alias: string;
}

/** Copia local y no ejecutable de una definición legacy ambigua. */
export interface LegacyApplicationCandidate {
  readonly ownerWorkspaceId: string;
  readonly profile: BrowserApplicationProfile;
}

/** Aplicación local global; nunca concede permisos por sí misma. */
export interface LocalApplication {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly primaryServiceId: string;
  readonly services: readonly LocalApplicationService[];
  readonly viewport: {
    readonly width: number;
    readonly height: number;
  };
  readonly reviewState: ApplicationReviewState;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly conflictCandidates?: readonly LegacyApplicationCandidate[] | undefined;
}

export interface WorkspaceLimits {
  readonly maxFileBytes: number;
  readonly maxTreeEntries: number;
  readonly maxTreeDepth: number;
  readonly largeArtifacts: LargeArtifactPolicy;
}

interface LargeArtifactPolicyCommon {
  readonly reserve: {
    readonly minimumFreeBytes: number;
    readonly minimumFreePercent: number;
  };
  readonly maxConcurrentJobs: 1 | 2;
}

export type LargeArtifactPolicy =
  | (LargeArtifactPolicyCommon & { readonly mode: "standard" })
  | (LargeArtifactPolicyCommon & { readonly mode: "custom"; readonly customSourceBytes: number })
  | (LargeArtifactPolicyCommon & { readonly mode: "adaptive" });

export interface AuthorizedWorkspace {
  readonly id: string;
  readonly name: string;
  /** Absoluto. Nunca sale del servidor: ni en respuestas MCP ni en logs (SEC-024). */
  readonly rootPath: string;
  readonly enabled: boolean;
  readonly createdAt: string;
  readonly permissions: WorkspacePermissions;
  readonly limits: WorkspaceLimits;
  readonly denyPatterns: readonly string[];
  /**
   * Nombre de perfil -> comando fijo (binario + argumentos). El modelo elige un
   * perfil por nombre en `validation.run`; nunca ve ni aporta este mapa.
   */
  readonly validationProfiles: Readonly<Record<string, readonly string[]>>;
  /** Perfiles de servidor cerrados; nunca contienen entrada aportada por una tool MCP. */
  readonly processProfiles?: Readonly<Record<string, ProcessProfile>>;
  /** Perfiles de navegador limitados a orígenes loopback preaprobados. */
  readonly browserProfiles?: Readonly<Record<string, BrowserProfile>>;
  /** Una importación portable conserva perfiles, pero exige revisión local antes de activarlos. */
  readonly automationReviewRequired?: boolean;
}

export interface WorkspaceRegistry {
  readonly schemaVersion: 5;
  readonly workspaces: readonly AuthorizedWorkspace[];
  readonly applications: readonly LocalApplication[];
}

export type WorkspaceCapability = keyof WorkspacePermissions;
