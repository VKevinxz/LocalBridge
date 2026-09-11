# Changelog

Los cambios relevantes de LocalBridge MCP se documentan aquí. El proyecto sigue
[Semantic Versioning](https://semver.org/lang/es/) y publica artefactos mediante GitHub
Releases.

## [Unreleased]

## [1.7.0] — 2026-09-11

### Añadido

- Trabajos durables de análisis y descarga con progreso, cancelación y recuperación.
- Lectura incremental, búsqueda y hash de archivos grandes, inspección PE pasiva y
  procesamiento PDF; opción avanzada **Sin límite fijo** para el tamaño de la fuente.
- **Eliminar desarrollo y accesos** retira configuración y permisos exclusivos de
  LocalBridge y conserva los archivos reales y referencias compartidas.

### Corregido

- Render visual PDFium para preservar contraste de escaneos de hasta 64 MiB, con PDF.js
  por rangos para fuentes mayores; falso positivo de sintaxis activa en streams pasivos.
- Continuidad entre chats, reutilización de servidores administrados, revisión de setup
  por acción y cambios de cuotas web sin cierre de sesiones.
- Las descargas de efecto incierto no se repiten automáticamente.

### Seguridad y compatibilidad

- Catálogo de 100 tools; se conservan las 91 anteriores. Registro schema 5 y broker 19.
- Fuentes grandes por streaming con memoria, concurrencia, respuestas y reserva de disco
  acotadas; revalidación de autoridad y publicación protegida.

## [1.6.3] — 2026-09-09

### Añadido

- `document.render` para entregar páginas PDF como bloques visuales MCP e `image.read`
  para PNG, JPEG y WebP pasivos;
- señales de clasificación, continuación y modo recomendado en `document.read`;
- lector seguro por rangos con SHA-256 streaming y techo demostrado de 250 MiB por PDF;
- resumen de cobertura documental en Actividad y recomendación de análisis posterior a
  una descarga.

### Seguridad y compatibilidad

- worker limitado sin rutas ni capacidades de filesystem/red/proceso, contenido activo
  PDF ignorado y presupuestos separados para fuente, píxeles y respuesta;
- catálogo de **91 tools**; las 89 anteriores y el broker revisión 18 se conservan;
- binding Windows x64 de canvas declarado y copiado explícitamente al paquete.

## [1.6.2] — 2026-09-07

### Corregido

- el resumen compartido de pestañas acepta estado de movimiento y presentación sin
  exponer la geometría del monitor por el broker;
- captura temporal separada de la cuota de texto, con preflight de hasta 4K/24 muestras,
  reserva de disco, rollback y restauración del scroll;
- timeouts diferenciados para operaciones ordinarias, movimiento y descargas largas;
- Actividad agrupa diagnósticos bajo su operación, muestra contadores reales y elimina
  aprobaciones vencidas al consultarlas;
- la descripción de `web.open` expresa la capacidad sin texto que induzca una alerta de
  aprobación del host.

### Mejorado

- perfiles nuevos con 1 GiB por asset y 10 GiB acumulados por sesión;
- metadata, move, delete y Git stage procesan assets administrados de hasta 1 GiB por
  streaming sin ampliar la lectura de contenido MCP;
- descarga compatible con AVIF, QuickTime/MOV y MIME genérico respaldado por firma fuerte,
  con extensión final normalizada y códigos de error accionables;
- mensajes de recuperación para parches inválidos, referencias vencidas, idempotencia y
  bundles de movimiento ausentes.

### Seguridad y compatibilidad

- se mantienen 89 tools, las rutas relativas, creación exclusiva, denylist, permisos y
  aislamiento de localhost;
- `maxFileBytes` conserva su función para texto y edición ordinaria; los presupuestos
  binarios son internos y no pueden elevarse desde una tool MCP;
- el broker privado usa revisión 18.

## [1.6.1] — 2026-09-07

### Corregido

- la captura temporal comprime normalmente los PNG 1920×1080 y comprueba frame, hoja de
  contacto y total estimado antes del primer scroll;
- los efectos inciertos conservan una causa catalogada y la auditoría muestra el código sin
  filtrar mensajes, rutas o contenido;
- `web.navigate` ya no colapsa excepciones operativas a `INTERNAL_ERROR` y verifica el
  destino observable ante rechazos tardíos de Chromium;
- Actividad distingue listeners wildcard y recomienda loopback para servidores locales.

### Mejorado

- cuota web independiente con base de 100 MiB por asset y 1 GiB acumulado por sesión;
- descarga por chunks a staging, hash incremental, reserva libre de 512 MiB, validación y
  publicación atómica;
- descripciones para relectura de parches, resultados truncados, esperas realistas y evitar
  reintentos idénticos tras una cuota.

### Seguridad y compatibilidad

- `maxFileBytes` continúa siendo el límite de operaciones ordinarias; ningún argumento MCP
  puede elevar la cuota web;
- se mantienen 89 tools y el broker privado sube a revisión 17 por `causeCode` opcional.

## [1.6.0] — 2026-09-07

### Añadido

- inventario estructurado de CSS Animations, CSS Transitions, Web Animations API,
  scroll timelines y elementos sticky para páginas externas y localhost;
- capturas temporales `stepped` o `screencast` en bundles `.lbmotion` atómicos, con
  manifiesto, 3–24 PNG, hoja de contacto, hashes, progreso, cancelación y recibo local;
- comparación estricta por progreso de scroll con diff y métricas por fotograma;
- modos del visor **Encajar** y **1:1**, pan local, métricas de render/vista/escala y
  preferencia persistente en Actividad.

### Corregido

- el visor ya no presenta silenciosamente un recorte de un render 1920×1080 cuando el
  monitor es menor; Encajar conserva los cuatro bordes sin alterar el viewport lógico;
- el contenido en modo 1:1 queda recortado por una `View` bajo la barra confiable, por lo
  que la página no puede cubrir la identificación local;
- una captura interrumpida no publica un directorio parcial y el arranque recupera staging
  abandonado tras un cierre abrupto.

### Seguridad y compatibilidad

- cinco tools nuevas con schemas estrictos, IDs web/browser no intercambiables y ninguna
  ruta absoluta, URL, selector, XPath o JavaScript en el contrato;
- límites de 24 frames, 64 MiB, 30 segundos, un capturador y un comparador globales;
- ningún frame cruza MCP o el broker; la toma de control invalida y drena capturas antes de
  exponer entrada privada;
- catálogo de **89 tools** y broker privado revisión **16**.

## [1.5.0] — 2026-09-06

### Añadido

- actividad unificada para navegadores LOCAL e INTERNET, procesos y terminales, con filtros,
  contadores y estados de intervención consistentes;
- toma de control humano desde cualquier sesión web elegible, selección privada de pestaña
  y exclusión global frente al navegador de desarrollo;
- alta de navegación pública en una acción y acceso progresivo a un hostname exacto después
  de una intervención humana.

### Mejorado

- las instrucciones del agente redescubren sesiones y pestañas antes de crear otra, y
  conservan los recursos cuando la tarea puede continuar;
- la configuración web queda dedicada a permisos y perfiles; las sesiones se operan desde
  Actividad y muestran su causa de cierre reciente;
- devolver una navegación pública cierra las otras pestañas y conexiones y permite guardar
  una regla exacta sin persistir cookies.

### Seguridad y compatibilidad

- concesión en memoria de 15 minutos, sin subdominios, con proxy, frames, workers y
  WebSockets restringidos al mismo hostname;
- schemas IPC estrictos, respuestas de UI por generación y referencias invalidadas en cada
  transición de autoridad;
- los paquetes locales se integran en los bundles y se excluyen como TypeScript fuente del
  ASAR para impedir el error de arranque por type stripping;
- se mantienen 79 tools y protocolo MCP `2026-07-28`; el broker privado sube a revisión 14.

## [1.4.1] — 2026-09-06

### Añadido

- vista nativa de solo lectura para observar la misma pestaña de investigación que usa
  ChatGPT, con seguimiento de actividad, pestaña fijada y selección de monitor;
- coordinador local que conserva una única vista pasiva visible entre investigación web y
  navegador de desarrollo sin detener ninguna sesión.

### Corregido

- aperturas tardías ya no pueden reaparecer después de ocultar, revocar o iniciar control
  humano;
- la captura de páginas dentro de `WebContentsView` usa CDP y funciona fuera de pantalla;
- cerrar la ventana pasiva equivale a ocultarla y no destruye la pestaña administrada.

### Seguridad y compatibilidad

- banda local aislada del contenido remoto, sin preload, red, permisos, foco, ratón o
  teclado;
- el handoff retira toda vista pasiva y no la reabre automáticamente tras contenido privado;
- se mantienen 79 tools, protocolo MCP `2026-07-28` y broker privado revisión 13.

## [1.4.0] — 2026-09-06

### Añadido

- 21 tools `web.*` sobre un navegador de Internet aislado y perfiles locales default-off;
- navegación multipestaña, referencias efímeras, extracción con fuentes, acciones comunes,
  transferencia humana y descargas documentales observadas;
- `document.read` para PDFs textuales mediante un worker limitado;
- lectura de archivos por rangos de líneas y parches contextuales guardados por hash;
- assertions, esperas y acciones tipadas para probar aplicaciones web locales;
- redescubrimiento de sesiones de terminal retenidas y diagnóstico de capacidades efectivas;
- selección segura de repositorios internos mediante `repositoryPath` en las siete tools
  `git.*` para proyectos multi-repo.

### Corregido

- commit inicial, stage de borrados/renombres, límites de tiempo y verificación remota de push;
- autoridad atómica e idempotencia ligada a intención, permisos y estado del recurso;
- cursores de terminal por bytes UTF-8, pertenencia de sesiones y retención ligada a la
  aprobación exacta;
- la auditoría de historia pública conserva allowlists por blob para fixtures sintéticos
  históricos y vigentes;
- commit y push de subrepositorios usan las tools Git estructuradas en lugar de recurrir a
  una terminal de control total.

### Seguridad y distribución

- proxy HTTPS con DNS/IP públicos revalidados, bloqueo de red privada/metadata, QUIC y
  WebRTC directo;
- idempotencia web que conserva la incertidumbre y no repite efectos sin respuesta;
- permisos web separados de workspaces y desarrollo, sesiones efímeras y exclusión completa
  durante control humano;
- schemas MCP estrictos, búsqueda cancelable con rutas revalidadas y límites previos a la
  expansión de parches;
- gates reales de Electron y del servidor MCP empaquetado en CI;
- Node.js 22.13 o posterior como runtime mínimo de desarrollo.

## [1.2.1] — 2026-08-28

### Mejorado

- el límite de terminales concurrentes pasa de 4 a 8 por proyecto y de 12 a 16 en total.

### Corregido

- una terminal cerrada dejaba de liberarse nunca y retenía su salida completa hasta cerrar la
  aplicación; ahora se conserva 30 minutos o hasta 24 sesiones cerradas.

### Seguridad y distribución

- se fijan versiones corregidas de dependencias transitivas del empaquetador para evitar
  vulnerabilidades conocidas en el pipeline de distribución;
- las preparaciones, limpiezas y pruebas de integración que operan repositorios Git reales
  disponen de un margen explícito de 30 segundos en Windows, sin ampliar el timeout global
  ni relajar aserciones de seguridad.

## [1.2.0] — 2026-08-28

### Añadido

- `browser.viewport`: emula un tamaño de vista para comprobar diseño responsive y puntos de
  ruptura, con emulación táctil opcional;
- las capturas informan el tamaño realmente renderizado.

### Seguridad

- el tamaño se emula sin redimensionar ventanas del usuario y se restablece cuando la persona
  toma el control local;
- la tool acepta solo dimensiones enteras acotadas y una bandera táctil: ni URL, ni puerto, ni
  selector, ni agente de usuario, ni escala de dispositivo.

## [1.1.2] — 2026-08-28

### Corregido

- la detección de campos de credenciales del navegador compara palabras completas y deja de
  bloquear campos inocentes como `secretaria` o `wizard`;
- se reconocen términos en español (`contraseña`, `clave de acceso`, `tarjeta`, `código de
  seguridad`) que antes no se detectaban;
- se distingue «palabra clave» de una clave real y se tiene en cuenta el texto de ayuda del
  campo.

## [1.1.1] — 2026-08-28

### Corregido

- un escaneo de estructura incompleto ya no degrada el estado de un proyecto ni revoca
  capacidades concedidas: la cobertura pasa a ser un metadato informado, no un estado;
- `project.list` informa estado y cobertura para que el cliente pueda explicar una
  estructura parcial;
- leer, consultar y cerrar una terminal existente dejan de bloquearse cuando el proyecto
  requiere revisión; iniciar y escribir conservan la revisión;
- un proyecto que quedó en revisión vuelve a evaluarse solo, incluso al arrancar;
- el presupuesto del escaneo respeta la denylist y omite directorios de datos y cachés.

## [1.1.0] — 2026-08-27

### Añadido

- onboarding project-first de seis pasos;
- detección read-only de carpeta vacía, repositorio, monorepo y multirepo;
- selección de confianza y presets Guiados antes de registrar el proyecto;
- estado de onboarding reanudable y compatible con downgrade.

### Mejorado

- comprobación automática del runtime incluido;
- finalización transaccional con rollback e idempotencia;
- interfaz compacta y recuperación orientada a acciones.

### Seguridad

- selector nativo representado mediante token efímero ligado a la ventana;
- `Agente en proyecto` continúa cerrado sin sandbox demostrado;
- no cambió el catálogo MCP ni el protocolo `2026-07-28`.

## [1.0.0] — 2026-08-26

- proyectos como unidad principal de producto;
- terminal interactiva opcional bajo confianza local explícita;
- listeners verificados y navegador multiservicio derivado de procesos administrados;
- intervención humana temporal y vista en vivo no interactiva.

## [0.9.0] — 2026-08-25

- creación y adopción asistida de proyectos;
- detección de topología y preparación mediante acciones cerradas;
- compatibilidad aditiva con configuraciones existentes.

## [0.3.0] — 2026-08-23

- runtime de desarrollo controlado;
- procesos aprobados, logs, puertos verificados y navegador local aislado.

## [0.2.0] — 2026-08-22

- operaciones Git de escritura con aprobación humana;
- aplicación de escritorio autocontenida y administración de conexión.

## [0.1.0] — 2026-08-21

- baseline funcional de filesystem, Git de lectura, validaciones, auditoría y Secure MCP
  Tunnel.

[1.2.1]: https://github.com/VKevinxz/LocalBridge/releases/tag/v1.2.1
[1.5.0]: https://github.com/VKevinxz/LocalBridge/releases/tag/v1.5.0
[1.6.0]: https://github.com/VKevinxz/LocalBridge/releases/tag/v1.6.0
[1.6.1]: https://github.com/VKevinxz/LocalBridge/releases/tag/v1.6.1
[1.6.2]: https://github.com/VKevinxz/LocalBridge/releases/tag/v1.6.2
[1.4.1]: https://github.com/VKevinxz/LocalBridge/releases/tag/v1.4.1
[1.4.0]: https://github.com/VKevinxz/LocalBridge/releases/tag/v1.4.0
[1.2.0]: https://github.com/VKevinxz/LocalBridge/releases/tag/v1.2.0
[1.1.2]: https://github.com/VKevinxz/LocalBridge/releases/tag/v1.1.2
[1.1.1]: https://github.com/VKevinxz/LocalBridge/releases/tag/v1.1.1
[1.1.0]: https://github.com/VKevinxz/LocalBridge/releases/tag/v1.1.0
[1.0.0]: https://github.com/VKevinxz/LocalBridge/releases/tag/v1.0.0
[0.9.0]: https://github.com/VKevinxz/LocalBridge/releases/tag/v0.9.0
[0.3.0]: https://github.com/VKevinxz/LocalBridge/releases/tag/v0.3.0
[0.2.0]: https://github.com/VKevinxz/LocalBridge/releases/tag/v0.2.0
[0.1.0]: https://github.com/VKevinxz/LocalBridge/releases/tag/v0.1.0
