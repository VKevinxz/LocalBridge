import type {
  DesktopSettings,
  OnboardingViewSnapshot,
  RuntimeReadinessReport,
} from "../../preload/index.js";

export interface OnboardingRenderModel {
  readonly snapshot: OnboardingViewSnapshot;
  readonly settings: DesktopSettings;
  readonly runtimeReport?: RuntimeReadinessReport;
  readonly apiKeyDraft: string;
  readonly keySaved: boolean;
  readonly diagnosticOutput: string;
  readonly projectName: string;
  readonly projectDescription: string;
  readonly busy?: "runtime" | "connection" | "folder" | "access" | "complete" | "navigation";
  readonly feedbackHtml: string;
}

const STEPS = [
  ["welcome", "Bienvenida"],
  ["runtime", "Sistema"],
  ["connection", "Conexión"],
  ["project", "Proyecto"],
  ["access", "Acceso"],
  ["review", "Confirmar"],
] as const;

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ?? character);
}

function runtimeHtml(report: RuntimeReadinessReport | undefined): string {
  if (report === undefined) return '<p class="onboarding-empty">Todavía no se ejecutó la comprobación local.</p>';
  const checks = [
    ["Node.js incluido", report.node],
    ["Cliente de túnel", report.tunnel],
    ["Conexión HTTPS", report.connectivity],
    ["Servidor MCP local", report.server],
  ] as const;
  return `<ul class="onboarding-checks">${checks
    .map(([label, item]) => `<li class="${item.ok ? "check-ok" : "check-error"}"><strong>${item.ok ? "✓" : "×"} ${label}</strong><span>${escapeHtml(item.detail)}</span></li>`)
    .join("")}</ul>`;
}

function progressHtml(snapshot: OnboardingViewSnapshot): string {
  const activeIndex = STEPS.findIndex(([id]) => id === snapshot.effectiveStep);
  return `<ol class="onboarding-progress" aria-label="Progreso de configuración">${STEPS.map(([_id, label], index) => {
    const state = index < activeIndex ? "complete" : index === activeIndex ? "current" : "pending";
    return `<li class="progress-${state}" ${state === "current" ? 'aria-current="step"' : ""}><span>${index + 1}</span><small>${label}</small></li>`;
  }).join("")}</ol>`;
}

function navigationHtml(model: OnboardingRenderModel, options: { next?: string; complete?: boolean; back?: boolean }): string {
  const disabled = model.busy !== undefined;
  return `<div class="onboarding-actions">
    ${options.back === true ? `<button type="button" data-onboarding-back ${disabled ? "disabled" : ""}>Atrás</button>` : ""}
    ${options.next === undefined ? "" : `<button type="button" class="primary" data-onboarding-next ${!model.snapshot.canContinue || disabled ? "disabled" : ""}>${escapeHtml(options.next)}</button>`}
    ${options.complete === true ? `<button type="button" class="primary" id="complete-onboarding" ${!model.snapshot.canContinue || disabled ? "disabled" : ""}>${model.busy === "complete" ? "Guardando…" : "Guardar y terminar"}</button>` : ""}
  </div>`;
}

function welcomeHtml(model: OnboardingRenderModel): string {
  return `<section class="onboarding-step" aria-labelledby="onboarding-title">
    <p class="eyebrow">Primera configuración</p>
    <h1 id="onboarding-title">Trabaja con ChatGPT desde una carpeta</h1>
    <p class="onboarding-lead">Configura la conexión una vez, elige un proyecto y decide qué puede hacer LocalBridge. Podrás cambiar o revocar todo después.</p>
    <div class="onboarding-benefits">
      <article><strong>Tu proyecto sigue local</strong><p>Las rutas, claves y auditoría permanecen en este equipo.</p></article>
      <article><strong>Acceso explícito</strong><p>Ninguna carpeta ni capacidad se concede por instalar la aplicación.</p></article>
      <article><strong>Listo para conversar</strong><p>Al finalizar podrás pedir revisar, editar, ejecutar y navegar según el nivel elegido.</p></article>
    </div>
    <div class="trust-box"><strong>Límite de confianza</strong><p>Las operaciones de mayor impacto conservan sus controles. Control total requiere una confirmación nativa adicional.</p></div>
    ${navigationHtml(model, { next: "Empezar" })}
  </section>`;
}

function runtimeStepHtml(model: OnboardingRenderModel): string {
  return `<section class="onboarding-step" aria-labelledby="onboarding-title">
    <p class="eyebrow">Preparar el equipo</p><h1 id="onboarding-title">Comprobar componentes</h1>
    <p class="onboarding-lead">Esta prueba solo revisa el runtime incluido, HTTPS y una llamada MCP local. No inicia tus proyectos.</p>
    ${runtimeHtml(model.runtimeReport)}
    <div class="onboarding-inline-actions"><button type="button" id="run-runtime-check" ${model.busy !== undefined ? "disabled" : ""}>${model.busy === "runtime" ? "Comprobando…" : "Comprobar ahora"}</button></div>
    ${navigationHtml(model, { back: true, next: "Continuar" })}
  </section>`;
}

function connectionHtml(model: OnboardingRenderModel): string {
  const settings = model.settings;
  return `<section class="onboarding-step" aria-labelledby="onboarding-title">
    <p class="eyebrow">Conectar ChatGPT</p><h1 id="onboarding-title">Validar el túnel</h1>
    <p class="onboarding-lead">El ID es público. La clave secreta solo se conserva cifrada por Windows después de un diagnóstico correcto.</p>
    <div class="onboarding-inline-actions"><button type="button" data-external="tunnels">Abrir Tunnels</button><button type="button" data-external="runtimeKeys">Abrir claves</button></div>
    <form id="settings-form" class="onboarding-form">
      <label>Confirmación de commit y push<select name="gitApprovalMode"><option value="host" ${settings.gitApprovalMode === "host" ? "selected" : ""}>Cuadro nativo de ChatGPT</option><option value="mrtr" ${settings.gitApprovalMode === "mrtr" ? "selected" : ""}>MRTR estricto</option></select><small>Para ChatGPT, el cuadro nativo evita una segunda aprobación incompatible.</small></label>
      <label>ID público del túnel<input type="text" name="tunnelId" required placeholder="tunnel_…" value="${escapeHtml(settings.tunnelId)}" autocomplete="off" spellcheck="false" aria-describedby="tunnel-id-error" /></label>
      <p id="tunnel-id-error" class="error-text field-error" role="alert"></p>
      <input type="hidden" name="tunnelBinaryPath" value="${escapeHtml(settings.tunnelBinaryPath)}" />
      <input type="hidden" name="tunnelProfile" value="${escapeHtml(settings.tunnelProfile)}" />
      <input type="hidden" name="tunnelProfileDir" value="${escapeHtml(settings.tunnelProfileDir)}" />
      <input type="hidden" name="serverCwd" value="${escapeHtml(settings.serverCwd)}" />
    </form>
    <label class="onboarding-secret">Clave secreta de runtime <span class="field-status">${model.keySaved ? "Guardada y cifrada" : "Sin guardar"}</span><input type="password" id="api-key" value="${escapeHtml(model.apiKeyDraft)}" autocomplete="off" aria-describedby="runtime-key-error" /></label>
    <p id="runtime-key-error" class="error-text field-error" role="alert"></p>
    <div class="onboarding-inline-actions"><button type="button" id="diagnose-tunnel" ${model.busy !== undefined ? "disabled" : ""}>${model.busy === "connection" ? "Diagnosticando…" : "Guardar y diagnosticar"}</button></div>
    ${model.diagnosticOutput === "" ? "" : `<pre id="diagnostic-output" class="log-panel">${escapeHtml(model.diagnosticOutput)}</pre>`}
    ${navigationHtml(model, { back: true, next: "Continuar" })}
  </section>`;
}

function projectHtml(model: OnboardingRenderModel): string {
  const folder = model.snapshot.folder;
  const detail = folder === undefined ? '<p class="onboarding-empty">Elige la carpeta raíz que contiene tu proyecto, monorepo o varios repositorios relacionados.</p>' : `
    <div class="onboarding-project-summary">
      <div><span class="status-badge">${escapeHtml(folder.topology)}</span><h2>${escapeHtml(folder.existingProjectName ?? model.projectName)}</h2></div>
      <dl><div><dt>Repositorios</dt><dd>${folder.repositoryCount}</dd></div><div><dt>Paquetes</dt><dd>${folder.packageCount}</dd></div><div><dt>Servicios</dt><dd>${folder.serviceCount}</dd></div><div><dt>Validaciones</dt><dd>${folder.validationCount}</dd></div></dl>
      ${folder.existingProjectId === undefined ? "" : '<p class="feedback feedback-success">Esta carpeta ya está registrada. Se usará la ficha existente sin duplicarla.</p>'}
      ${folder.requiresReview ? '<p class="risk-note risk-medium">La detección encontró advertencias o alcanzó un límite. Podrás revisar la estructura después.</p>' : ""}
    </div>`;
  return `<section class="onboarding-step" aria-labelledby="onboarding-title">
    <p class="eyebrow">Elegir proyecto</p><h1 id="onboarding-title">Selecciona una sola raíz</h1>
    <p class="onboarding-lead">Frontend, backend y repositorios dentro de esa raíz se detectan en modo lectura. La selección todavía no concede acceso.</p>
    ${detail}
    <div class="onboarding-inline-actions"><button type="button" id="onboarding-pick-folder" ${model.busy !== undefined ? "disabled" : ""}>${model.busy === "folder" ? "Analizando…" : folder === undefined ? "Elegir carpeta" : "Cambiar carpeta"}</button></div>
    ${folder === undefined || folder.existingProjectId !== undefined ? "" : `<div class="onboarding-form onboarding-project-fields"><label>Nombre<input id="onboarding-project-name" maxlength="80" value="${escapeHtml(model.projectName)}" /></label><label>Descripción opcional<textarea id="onboarding-project-description" maxlength="240">${escapeHtml(model.projectDescription)}</textarea></label></div>`}
    ${navigationHtml(model, { back: true, next: "Continuar" })}
  </section>`;
}

function accessHtml(model: OnboardingRenderModel): string {
  const trust = model.snapshot.draft.trustMode ?? "guided";
  const preset = model.snapshot.draft.guidedPreset ?? "develop";
  return `<section class="onboarding-step" aria-labelledby="onboarding-title">
    <p class="eyebrow">Definir acceso</p><h1 id="onboarding-title">¿Qué quieres que pueda hacer?</h1>
    <p class="onboarding-lead">Los presets solo se aplican al confirmar el último paso. Puedes ajustar cada proyecto después.</p>
    <fieldset class="choice-grid"><legend>Capacidades en modo Guiado</legend>
      <label><input type="radio" name="onboarding-preset" value="review" ${preset === "review" ? "checked" : ""}/><span><strong>Revisar</strong><small>Leer archivos y consultar Git.</small></span></label>
      <label><input type="radio" name="onboarding-preset" value="develop" ${preset === "develop" ? "checked" : ""}/><span><strong>Desarrollar y probar</strong><small>Editar, validar, iniciar servicios y navegar. Sin publicar en Git.</small></span></label>
      <label><input type="radio" name="onboarding-preset" value="complete" ${preset === "complete" ? "checked" : ""}/><span><strong>Desarrollo completo</strong><small>Añade stage, commit y push; conservan aprobación.</small></span></label>
    </fieldset>
    <fieldset class="choice-grid trust-choice"><legend>Nivel de confianza</legend>
      <label><input type="radio" name="onboarding-trust" value="guided" ${trust === "guided" ? "checked" : ""}/><span><strong>Guiado — recomendado</strong><small>Solo tools y perfiles cerrados dentro de las carpetas autorizadas.</small></span></label>
      <label class="advanced-choice"><input type="radio" name="onboarding-trust" value="full-host" ${trust === "full-host" ? "checked" : ""}/><span><strong>Control total del equipo — avanzado</strong><small>Terminal con tu cuenta de Windows; la carpeta no es una frontera.</small></span></label>
      <label class="disabled-choice"><input type="radio" disabled/><span><strong>Agente en proyecto — no disponible</strong><small>Se habilitará solo cuando exista un sandbox de Windows demostrado.</small></span></label>
    </fieldset>
    <div class="onboarding-inline-actions"><button type="button" id="onboarding-confirm-access" ${model.busy !== undefined ? "disabled" : ""}>${model.busy === "access" ? "Guardando…" : "Aplicar selección"}</button></div>
    ${navigationHtml(model, { back: true, next: "Revisar" })}
  </section>`;
}

function reviewHtml(model: OnboardingRenderModel): string {
  const folder = model.snapshot.folder;
  const existing = model.snapshot.draft.existingProjectId !== undefined;
  const trust = model.snapshot.draft.trustMode === "full-host" ? "Control total del equipo" : "Guiado";
  const preset = model.snapshot.draft.guidedPreset ?? "develop";
  return `<section class="onboarding-step" aria-labelledby="onboarding-title">
    <p class="eyebrow">Confirmación final</p><h1 id="onboarding-title">Revisa antes de guardar</h1>
    <div class="review-grid">
      <article><span>Proyecto</span><strong>${escapeHtml(folder?.existingProjectName ?? model.projectName)}</strong><small>${existing ? "Usará la ficha existente" : escapeHtml(folder?.topology ?? "Sin selección")}</small></article>
      <article><span>Acceso</span><strong>${escapeHtml(trust)}</strong><small>Preset: ${escapeHtml(preset)}</small></article>
      <article><span>Conexión</span><strong>Validada</strong><small>La clave permanece cifrada por Windows.</small></article>
    </div>
    ${model.snapshot.draft.trustMode === "full-host" ? '<p class="risk-note risk-high">Antes de guardar, Windows mostrará una confirmación local adicional sobre el alcance de Control total.</p>' : ""}
    <p class="onboarding-lead">Finalizar crea o vincula el proyecto como una transacción. Si algo falla, LocalBridge revierte los cambios parciales.</p>
    ${navigationHtml(model, { back: true, complete: true })}
  </section>`;
}

export function onboardingHtml(model: OnboardingRenderModel): string {
  const step = model.snapshot.effectiveStep;
  const content = step === "welcome"
    ? welcomeHtml(model)
    : step === "runtime"
      ? runtimeStepHtml(model)
      : step === "connection"
        ? connectionHtml(model)
        : step === "project"
          ? projectHtml(model)
          : step === "access"
            ? accessHtml(model)
            : reviewHtml(model);
  const activeIndex = STEPS.findIndex(([id]) => id === step);
  return `<main class="onboarding-shell-v2" aria-busy="${model.busy !== undefined}">
    <div class="onboarding-card">
      <p class="onboarding-counter">Configuración inicial · Paso ${activeIndex + 1} de ${STEPS.length}</p>
      ${progressHtml(model.snapshot)}
      ${model.feedbackHtml}
      ${model.snapshot.redirected ? '<p class="feedback feedback-error" role="status">Volvimos al último paso que necesita verificación local.</p>' : ""}
      ${content}
    </div>
  </main>`;
}
