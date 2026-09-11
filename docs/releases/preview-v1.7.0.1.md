# LocalBridge MCP v1.7.0 — Preview 1 sin firma

**Prerelease de evaluación sin firma Authenticode.** Windows puede mostrar
**Editor desconocido**. Consulta [instalación en Windows](../WINDOWS_INSTALLATION.md)
y verifica el instalador con `SHA256SUMS.txt`.

Esta entrega actualiza la preview pública 1.2.1 con la base 1.7.0 probada localmente.
GitHub Actions compila el instalador desde el tag `preview-v1.7.0.1` y adjunta SBOM,
checksums y atestación. El binario de CI puede tener un hash distinto al candidato local.

## Cambios principales desde la preview anterior

- Navegador de Internet aislado junto al navegador de desarrollo, con vista en vivo,
  control humano y resolución lógica inicial de 1920×1080.
- Investigación web, descargas de recursos observados, inspección de animaciones y
  trazas de scroll para comparar la referencia con localhost.
- Lectura textual y visual de PDF e imágenes locales; render PDFium que conserva el
  contraste de escaneos en fuentes de hasta 64 MiB, con fallback por rangos para mayores.
- Trabajos de análisis y descarga observables, cancelables y recuperables; procesamiento
  incremental de archivos grandes y opción avanzada **Sin límite fijo** para la fuente.
- Reutilización de servidores entre conversaciones y revisión de setup específica por
  acción; cambiar una cuota de consumo conserva las sesiones web.
- **Eliminar desarrollo y accesos** para retirar de LocalBridge la configuración y los
  permisos exclusivos. Los archivos reales y recursos compartidos permanecen.

Consulta [los cambios de v1.7.0](v1.7.0.md), el [changelog](../../CHANGELOG.md) y la
[guía de uso](../USER_GUIDE.md).

## Actualización y alcance

El instalador incluye Desktop, servidor MCP y runtime. El registro migra a schema 5 sin
ampliar los permisos existentes; los proyectos conservan su política de consumo. Instala
el conjunto completo y reinicia LocalBridge para usar la misma versión en ambos procesos.

Las pruebas locales verificaron 1114 casos, 327 de seguridad y los recorridos Electron y
de empaquetado. GitHub Actions ejecuta sus propios gates antes de publicar los artefactos.
Esta preview no equivale a una release estable firmada.
