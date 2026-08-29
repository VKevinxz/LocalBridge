# LocalBridge MCP v1.2.1 — Preview 1 sin firma

> [!WARNING]
> Este es un **prerelease de evaluación sin firma Authenticode**. Windows mostrará
> `Editor desconocido` y puede advertir o bloquear su ejecución. No es una release estable
> ni debe usarse en equipos o proyectos críticos.

Esta publicación permite evaluar LocalBridge mientras el proyecto todavía no dispone de
un certificado comercial de firma de código. El binario se compila de forma reproducible
en GitHub Actions desde el tag `preview-v1.2.1.1`, se acompaña de checksum SHA-256, SBOM
SPDX y atestación de procedencia de GitHub, pero **eso no sustituye una firma digital de
Windows**.

## Antes de instalar

1. Descarga exclusivamente desde esta página de GitHub Releases.
2. Verifica `LocalBridge.MCP.Setup.1.2.1.exe` contra `SHA256SUMS.txt`.
3. Mantén Microsoft Defender, SmartScreen y Smart App Control activos.
4. Prueba primero en Windows Sandbox, una VM o un equipo no crítico sin credenciales ni
   proyectos sensibles.
5. Si Windows bloquea el ejecutable sin ofrecer una excepción local, no desactives la
   protección global; compila el código revisado o espera una versión firmada.

## Contenido

- instalador Windows x64 sin firma Authenticode;
- archivo `.blockmap` del paquete;
- `SHA256SUMS.txt` para verificar integridad;
- SBOM SPDX de los componentes incluidos;
- atestación de compilación emitida por GitHub Actions.

## Alcance funcional

El contenido funcional corresponde a `v1.2.1` e incorpora todo lo publicado desde la preview
anterior:

- una detección de estructura incompleta ya no retira capacidades a un proyecto autorizado;
- la detección de campos de credenciales compara palabras completas y reconoce términos en
  español;
- comprobación de diseño responsive desde el navegador controlado;
- más terminales simultáneas y liberación acotada de las ya cerradas.

Consulta [Instalación segura en Windows](../WINDOWS_INSTALLATION.md), la
[guía inicial](../GETTING_STARTED.md) y los [límites de la versión](v1.2.1.md).
