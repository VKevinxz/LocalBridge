# LocalBridge MCP v1.8.1 — Preview 1 sin firma

**Prerelease de evaluación sin firma Authenticode.** Windows puede mostrar
**Editor desconocido**. Consulta [instalación en Windows](../WINDOWS_INSTALLATION.md)
y verifica el instalador con `SHA256SUMS.txt`.

Esta entrega actualiza la preview pública 1.7.0 con la base 1.8.1 validada. GitHub
Actions compila el instalador desde el tag `preview-v1.8.1.1` y adjunta SBOM,
checksums y atestación. El binario generado por CI puede tener un hash distinto al
candidato local.

## Cambios principales desde la preview anterior

- Inspección acotada de estilos y estado, secuencias de teclado, acciones con captura,
  recarga explícita y mejor evidencia de consola para navegadores locales y de Internet.
- Comparaciones visuales y temporales con regiones paginadas, alineación por scroll real
  y advertencias cuando la posición, el entorno o la calidad no permiten comparar.
- Cinco tools `task.*` para coordinar lotes de análisis y validaciones finitas, consultar
  resultados parciales y cancelar trabajo sin ligarlo a una sola conversación.
- Actividad permite plegar sesiones, log, cobertura documental, auditoría, lotes y grupos
  de terminales sin detener los procesos ni ocultar intervenciones humanas.
- La clave de runtime puede conservarse cifrada con `safeStorage` después de comprobar
  una conexión válida. El secreto no se entrega al renderer ni se guarda en el DOM.
- Se mantienen las 113 tools, permisos, cuotas, límites y contratos MCP de 1.8.0.

Consulta [los cambios de v1.8.0](v1.8.0.md), [los cambios de v1.8.1](v1.8.1.md), el
[changelog](../../CHANGELOG.md) y la [guía de uso](../USER_GUIDE.md).

## Actualización y alcance

El instalador incluye Desktop, servidor MCP y runtime. Actualiza todos los componentes
juntos y reinicia LocalBridge para evitar mezclar revisiones privadas del broker.

Las verificaciones previas a esta preview aprobaron 1194 casos funcionales, 340 casos de
seguridad, los recorridos Electron, el empaquetado Windows y el servidor MCP incluido.
GitHub Actions repite sus propios gates antes de publicar los artefactos. Esta preview no
equivale a una release estable firmada.
