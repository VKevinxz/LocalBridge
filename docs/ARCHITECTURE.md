# Arquitectura

LocalBridge separa transporte, políticas y acceso local para que ningún cliente remoto
pueda decidir por sí mismo una ruta raíz o una capacidad.

```text
ChatGPT / cliente MCP
        │ Secure MCP Tunnel
        ▼
Servidor MCP y schemas estrictos
        │
        ▼
Permisos · idempotencia · auditoría
        │
        ├── workspace y filesystem seguro
        ├── documentos PDF en worker limitado
        ├── Git estructurado
        ├── validaciones y procesos administrados
        ├── proyectos y terminal por confianza
        ├── navegador local ligado a listeners
        └── navegador de Internet ── proxy HTTPS mediado
```

## Monorepo

- `apps/desktop`: Electron, preload y renderer.
- `apps/server`: entrada MCP por stdio.
- `packages/workspace`: registro y resolución segura de rutas.
- `packages/filesystem`: lectura y mutaciones atómicas.
- `packages/git`: operaciones Git con argumentos estructurados.
- `packages/development`: procesos, aplicaciones y terminales administradas.
- `packages/mcp-server`: schemas, routing y resultados MCP.
- `packages/desktop-core`: persistencia y lógica reutilizable de escritorio.
- `packages/permissions` y `packages/audit`: autorización y evidencia.

## Identidad de proyectos

La persona elige una carpeta mediante un diálogo nativo. Durante el onboarding, el
renderer recibe una referencia efímera y no la ruta. La detección local clasifica la
topología y la revalida antes de registrar el proyecto.

Las tools MCP reciben `workspaceId`, `projectId` o referencias opacas, según la capacidad.
Nunca aceptan una raíz absoluta desde el modelo.

## Escritura

Crear un archivo usa exclusión. Reemplazar, mover o borrar exige un SHA-256 esperado y una
comprobación inmediatamente anterior a la mutación. La resolución segura rechaza escapes,
symlinks, junctions y rutas denegadas.

## Procesos y puertos

Los procesos aprobados se ejecutan bajo supervisión y límites. En Windows, el helper nativo
vincula el árbol de procesos y demuestra qué listeners le pertenecen. Las URLs impresas son
solo pistas; no sustituyen la prueba de propiedad.

## Navegadores

`browser.*` inspecciona aplicaciones locales y deriva su allowlist de listeners
verificados. `web.*` usa otro controlador, IDs, límites y perfiles. Sus sesiones se crean
en particiones efímeras y todo tráfico sale por un proxy HTTPS local que vuelve a comprobar
perfil, hostname, DNS e IP pública antes de conectar. Loopback, LAN, metadata, permisos de
Chromium, descargas iniciadas por páginas, QUIC y WebRTC no mediado quedan bloqueados.

Ambos controladores usan referencias de snapshot acotadas. En `web.*`, una referencia
pertenece a una sola pestaña y generación. Navegar o actuar la invalida. El control humano
vacía operaciones del agente, invalida referencias y excluye observación e interacción
hasta que la persona devuelve o cancela la sesión. Revocar un perfil web solo termina sus
sesiones; los recursos de desarrollo continúan.

Cada pestaña externa se compone desde su creación con una `BrowserWindow` de envoltura
local y un `WebContentsView` remoto. La envoltura muestra una banda confiable sin preload ni
red; la página conserva su partición, proxy, CDP, historial y viewport al mostrarse. Un
coordinador de presentación permite una sola vista pasiva visible entre `browser.*` y
`web.*`. Sus canales IPC reciben únicamente IDs opacos y de display validados; coordenadas,
URLs y JavaScript no forman parte de ese contrato local.

Un segundo coordinador serializa la autoridad humana entre ambas familias. La UI común de
**Actividad** solo adapta sus estados: los controladores, permisos y límites siguen
separados. En una sesión pública, la intervención local puede producir una concesión en
memoria por 15 minutos para un hostname exacto. Antes de devolverla se cierran las otras
pestañas y conexiones, se restringe el proxy, se limpian caché y workers y se recarga la URL
actual antes de reinstalar CDP. La concesión no modifica
el perfil público ni sobrevive al cierre de LocalBridge.

Los dos controladores aplican un viewport lógico independiente de la ventana física. Las
sesiones nuevas de investigación y los navegadores derivados de listeners usan 1920×1080;
`web.viewport` y `browser.viewport` permiten otros tamaños acotados y los restauran tras el
handoff. El visor separa el render lógico de la presentación física: **Encajar** usa una
escala uniforme y **1:1** desplaza una `View` recortada sin cambiar la página. El broker
privado usa revisión 22 y el catálogo MCP contiene 113 tools. Las operaciones de v1.7.0
siguen disponibles como trabajos individuales. En 1.8.0, un coordinador FIFO acotado
ordena efectos por sesión y permite que sesiones independientes avancen juntas; captura
motion conserva una exclusión global. Control humano y cierre eluden la cola ordinaria.

## Documentos y descargas

`document.read` y `document.render` abren PDF mediante un lector seguro por rangos. El
proceso padre conserva el `FileHandle`, calcula SHA-256 por streaming, revalida autoridad,
tamaño y mtime, y sirve únicamente rangos acotados. El worker recibe bytes y longitud,
nunca rutas ni handles, y opera con límites de memoria, tiempo, páginas, píxeles y bytes
codificados. La extracción clasifica cada página como textual, mixta, visual o vacía; el
render devuelve imágenes rotuladas sin escribir derivados. `image.read` aplica el mismo
modelo de lectura autorizada a PNG, JPEG y WebP pasivos. El techo demostrado es 250 MiB
por PDF y 100 MiB de fuente raster; ambos son internos y no amplían `maxFileBytes`.

`web.download` acepta una referencia producida por `web.extract` o `web.assets`, nunca una
URL libre. Documentos, imágenes —incluido AVIF—, vídeo —incluido MOV—, fuentes y CSS
admitidos se validan por extensión, MIME y firma mientras se escriben por chunks en
staging. Los perfiles nuevos proponen 1 GiB por asset y 10 GiB acumulados por sesión; los
perfiles existentes conservan su configuración. Esta cuota permanece separada de
`maxFileBytes`. El hash se
calcula durante el flujo y un rename publica el archivo completo sin sobrescritura. `web.screenshot.save` y
`browser.screenshot.save` guardan PNG con recibo; `visual.compare` lee dos PNG autorizados y
crea un diff verificable. Toda escritura se reautoriza dentro del workspace.

Las trazas temporales usan otro presupuesto administrado: hasta 1 GiB total, 256 MiB por
archivo y 512 MiB de reserva. El motor comprueba el peor caso antes del primer scroll. Las
operaciones ordinarias de texto siguen bajo el límite del workspace; metadata, move,
delete y stage pueden verificar assets administrados por streaming hasta 1 GiB.

## Persistencia

Configuración, proyectos, confianza y onboarding usan schemas versionados y escrituras
atómicas. Las migraciones nunca conceden nuevas capacidades. Claves locales se cifran con
el almacén de Windows y no se incluyen en exportaciones portables.

Los lotes 1.8 reutilizan `AnalysisJobSupervisor`, el runner de validación y los
controladores; no crean otro ejecutor. `task-batches.sqlite` persiste primero la relación
padre/hijo, dependencias, huellas, estados, cobertura, métricas y recibos. Las
especificaciones viven solo en memoria. Tras reinicio, trabajo no terminal queda
interrumpido y nunca se reproduce automáticamente. Una caída de este journal aísla
`task.*`; las tools individuales, Git, terminal y navegadores continúan.
