# Publicar el repositorio en GitHub

Esta guía parte de una copia pública generada por LocalBridge. No inicialices Git dentro
del repositorio privado de desarrollo: contiene historial y documentación interna que no
forman parte de la publicación.

## 1. Verificar la raíz pública

Desde la carpeta pública final:

```powershell
Test-Path .git
./scripts/audit-public-snapshot.ps1 -Path .
./scripts/check-publication-readiness.ps1
pnpm install --frozen-lockfile
pnpm build:native:test
pnpm lint
pnpm typecheck
pnpm test
pnpm test:sec
pnpm audit --audit-level moderate
```

`Test-Path .git` debe devolver `False` antes de iniciar el repositorio. Los demás comandos
deben terminar con código 0. No publiques si la postura `UNLICENSED`, el aviso de copyright,
el editor o cualquier prueba son incoherentes.

## 2. Crear el historial público

```powershell
git init -b main
git add .
git status --short
git commit -m "chore: publish LocalBridge MCP v1.1.0"
```

Revisa la lista completa antes del commit. Debe incluir `COPYRIGHT.md`, pero no un archivo
`LICENSE`. No debe contener `.env`, bases de datos,
instaladores, `node_modules`, `vendor`, rutas locales, `STATUS`, especificaciones maestras,
planes ni ADR internos.

## 3. Conectar el repositorio oficial

El repositorio vacío ya existe en `VKevinxz/LocalBridge`. Después del primer commit:

```powershell
git remote add origin https://github.com/VKevinxz/LocalBridge.git
git push -u origin main
```

No agregues otro README, licencia ni `.gitignore` desde la web: los archivos públicos ya
existen localmente. Antes del push, confirma `git remote -v` y verifica que ambas URLs de
`origin` apunten exactamente al repositorio oficial.

## 4. Activar protecciones

El repositorio incluye reglas versionadas para `main` y tags. Primero valida el plan sin
hacer cambios:

```powershell
./scripts/configure-github-repository.ps1 `
  -Repository 'VKevinxz/LocalBridge' `
  -ReleaseReviewer 'VKevinxz'
```

Para aplicarlo, crea un token fine-grained con administración del repositorio, mantenlo
solo en una variable del proceso y bórralo al terminar:

```powershell
$env:LOCALBRIDGE_GITHUB_ADMIN_TOKEN = 'token-temporal'
./scripts/configure-github-repository.ps1 `
  -Repository 'VKevinxz/LocalBridge' `
  -ReleaseReviewer 'VKevinxz' `
  -Apply
Remove-Item Env:LOCALBRIDGE_GITHUB_ADMIN_TOKEN
```

El script activa reglas de ramas y tags, aprobación del environment `release`, alertas de
vulnerabilidades, reporte privado e inmutabilidad de releases. Si tu plan de GitHub no
permite alguna protección, configúrala manualmente y documenta la excepción antes de crear
un tag.

## 5. Configurar firma y releases

En el environment `release` crea estos secrets:

- `WIN_CSC_LINK`: certificado de firma en formato aceptado por electron-builder;
- `WIN_CSC_KEY_PASSWORD`: contraseña del certificado.

No uses secrets del repositorio en forks ni los copies a archivos locales. El workflow
rechaza una release sin firma Authenticode válida, timestamp, checksum, SBOM y atestación.

Cuando CI esté verde y la aceptación en Windows limpio esté completa:

```powershell
git tag -a v1.1.0 -m "LocalBridge MCP v1.1.0"
git push origin v1.1.0
```

El tag debe apuntar a `main`. GitHub Actions compilará y publicará el instalador; no subas
manualmente un ejecutable diferente al producido por ese workflow.

## 6. Comprobar la publicación

- abre la release y descarga instalador y `SHA256SUMS.txt`;
- compara el hash completo;
- verifica firma y timestamp en Windows;
- comprueba que README, capturas y enlaces relativos funcionen desde GitHub;
- instala y desinstala en una cuenta o VM limpia;
- confirma que una actualización conserva datos y que una instalación nueva no contiene
  proyectos, claves ni configuración del equipo de desarrollo.

Consulta [Releases para mantenedores](MAINTAINER_RELEASES.md) y
[Descargas y verificación](DOWNLOADS.md).
