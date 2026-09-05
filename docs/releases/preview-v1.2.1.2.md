# LocalBridge MCP v1.2.1 — Preview 2 sin firma

> [!WARNING]
> Este es un **prerelease de evaluación sin firma Authenticode**. Windows mostrará
> `Editor desconocido` y puede advertir o bloquear su ejecución. No es una release estable
> ni debe usarse en equipos o proyectos críticos.

Esta publicación reemplaza el intento `preview-v1.2.1.1`, cuyo tag se conserva como
evidencia pero cuyo workflow no llegó a publicar una release. El binario de esta segunda
preview se compila nuevamente en GitHub Actions desde `preview-v1.2.1.2`, con checksum
SHA-256, SBOM SPDX y atestación de procedencia de GitHub. Estas evidencias **no sustituyen
una firma digital de Windows**.

## Antes de instalar

1. Descarga exclusivamente desde esta página de GitHub Releases.
2. Verifica `LocalBridge.MCP.Setup.1.2.1.exe` contra `SHA256SUMS.txt`.
3. Mantén Microsoft Defender, SmartScreen y Smart App Control activos.
4. Prueba primero en Windows Sandbox, una VM o un equipo no crítico sin credenciales ni
   proyectos sensibles.
5. Si Windows bloquea el ejecutable sin ofrecer una excepción local, no desactives la
   protección global; compila el código revisado o espera una versión firmada.

## Correcciones del pipeline

- los hooks de pruebas que preparan y eliminan repositorios Git reales tienen un margen
  explícito de 30 segundos en Windows; las aserciones conservan el timeout global de 10
  segundos;
- `fast-uri` y `@xmldom/xmldom`, dependencias transitivas del empaquetador, quedan fijadas
  a versiones corregidas y la auditoría no reporta vulnerabilidades conocidas.

## Alcance funcional

El comportamiento de producto continúa siendo `v1.2.1`:

- una detección de estructura incompleta ya no retira capacidades a un proyecto autorizado;
- la detección de campos de credenciales compara palabras completas y reconoce términos en
  español;
- comprobación de diseño responsive desde el navegador controlado;
- más terminales simultáneas y liberación acotada de las ya cerradas.

Consulta [Instalación segura en Windows](../WINDOWS_INSTALLATION.md), la
[guía inicial](../GETTING_STARTED.md) y los [límites de la versión](v1.2.1.md).
