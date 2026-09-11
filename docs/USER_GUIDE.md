# Guía de uso

## Proyectos

Un proyecto representa una carpeta raíz elegida localmente. Puede contener un único
repositorio, frontend y backend separados, un monorepo o una carpeta inicialmente vacía.
Los hijos pertenecen al mismo proyecto y no necesitan autorización individual mientras
permanezcan dentro de la raíz reconocida.

Desde **Proyectos** puedes revisar la estructura detectada, cambiar el nivel de acceso o
revocar la ficha. Revocar LocalBridge no elimina archivos del disco.

## Acceso Guiado

Es el modo recomendado. Expone capacidades cerradas:

- lectura, búsqueda y metadatos;
- creación y reemplazo protegido por hash;
- Git de lectura y escritura con aprobación;
- validaciones y procesos previamente aprobados;
- navegador local aislado y auditoría.

Puedes empezar con un preset y revisar permisos individuales después. Habilitar una
capacidad no obliga al agente a usarla.

## Control total del equipo

Este modo habilita una terminal interactiva con los permisos de tu cuenta de Windows. La
carpeta seleccionada es el directorio inicial, no una frontera de seguridad. Actívalo solo
para proyectos y conversaciones de confianza. LocalBridge exige consentimiento local y
permite revocarlo.

`Agente en proyecto` permanece deshabilitado mientras no exista un sandbox de sistema
operativo demostrado y compatible.

## Servicios y aplicaciones web

ChatGPT puede iniciar perfiles detectados o configurados, consultar logs y solicitar los
listeners asociados. LocalBridge no confía únicamente en la URL impresa por un proceso:
comprueba en Windows que el puerto pertenece al árbol administrado.

Para varios servicios, como frontend y API, selecciona una carpeta padre o agrúpalos como
una aplicación. Cada servicio puede usar un puerto diferente. La vista principal suele ser
el frontend que se abrirá en el navegador.

Ejemplo de solicitud:

> Levanta los servicios del proyecto, valida la comunicación entre frontend y API, recorre
> las vistas principales y déjalos detenidos al terminar.

## Navegador e intervención humana

Para probar aplicaciones locales, el agente puede navegar, inspeccionar accesibilidad,
consola y red, y tomar capturas efímeras. **Ver navegador** permite observar la sesión sin
duplicar la página. Esa familia `browser.*` continúa limitada al servicio local del
proyecto.

Una prueba nueva iniciada desde un proceso o terminal renderiza en 1920×1080 por defecto,
independientemente del tamaño del monitor. Puedes pedir otra resolución, por ejemplo
1440×900, 1024×768 o 390×844; el agente la aplica con `browser.viewport`. El visor visible
ofrece **Encajar** para ver los cuatro bordes y **1:1** para inspeccionar detalle mediante
pan local. La banda y Actividad muestran render, área visible y escala. Después de
una intervención humana, LocalBridge restaura el viewport que el agente estaba usando.

Cuando necesites escribir credenciales, seleccionar un archivo o completar un paso privado,
usa **Tomar control**. Durante ese intervalo el agente queda excluido. Devuelve la sesión
explícitamente cuando termines. Usa cuentas y datos de prueba: una aplicación abierta puede
copiar lo introducido a su propio DOM o servidor.

## Navegador de Internet

El panel **Acceso a Internet**, dentro de Configuración, administra una autoridad distinta
de los proyectos. **Habilitar navegación por Internet** crea y habilita el acceso público
en un solo paso local. En opciones avanzadas puedes revisar o crear:

- **Investigación pública:** navega HTTPS público sin cuenta. Puede leer e interactuar; las
  descargas se habilitan por separado.
- **Sitios con cuenta:** navega únicamente los dominios que escribes en la UI local. Los
  hosts auxiliares pueden cargar recursos, pero no se convierten en destinos navegables.

Los accesos avanzados nacen deshabilitados. Revisa capacidades y límites y pulsa
**Habilitar**. La conversación puede descubrirlos; no necesitas indicar nombres de tools
en una petición normal como:

> Investiga en tres fuentes públicas las novedades del tema, compara sus fechas y dame los
> enlaces reales. No guardes archivos.

Las pestañas viven en un Chromium aislado y efímero, separado de tu navegador personal. No
importa cookies ni extensiones. Solo admite HTTPS público por puerto 443, bloquea red local,
permisos web y descargas iniciadas por la página. Las referencias de controles y recursos
caducan al cambiar la página o actuar.

Si habilitas descargas, un perfil nuevo propone 1 GiB por asset y 10 GiB acumulados por
sesión. Los perfiles que ya configuraste conservan sus valores; puedes elegir otro preset
local cuando quieras. La descarga sigue validando el contenido y
el espacio libre mientras escribe, por lo que no necesita cargar el archivo entero en memoria.
Puedes cambiar ambos presets en **Acceso a Internet**. Esta cuota es independiente del
límite de archivos de código: los assets llegan por chunks, se validan y solo entonces se
publican en la carpeta autorizada. Un límite superado no se soluciona repitiendo la misma
referencia; cambia la cuota local o elige un recurso más pequeño.

AVIF, MOV, MP4, WebM y fuentes binarias habituales se aceptan cuando MIME, contenedor y
firma coinciden. Si el servidor entrega otra extensión válida, LocalBridge corrige solo el
nombre final e informa la ruta que creó. SVG y ejecutables continúan bloqueados.

Este navegador también comienza en 1920×1080 y admite otras resoluciones cuando se las
pides a ChatGPT. El tamaño es el viewport lógico de la web; la ventana de observación puede
verse más pequeña para caber en tu monitor. Cambiar el preset no altera tu Chrome, Edge ni
la ventana principal de LocalBridge.

**Actividad** reúne las sesiones LOCAL e INTERNET. Sus filtros permiten ver navegadores o
recursos sin detenerlos. Cada sesión de Internet ofrece **Ver y seguir**, una lista de
pestañas y un selector de pantalla. La ventana muestra la pestaña real dentro de una banda
de LocalBridge, sin crear otra navegación. No acepta foco, ratón ni teclado. **Seguir**
cambia a la última pestaña que empieza a usar ChatGPT; **Fijar** conserva la elegida.
Ocultar o cerrar esa ventana conserva la sesión, su historial y sus referencias.

Puedes pulsar **Tomar control** en cualquier sesión elegible; no hace falta que ChatGPT lo
solicite antes. Solo una intervención humana puede estar activa entre desarrollo e Internet.
Mientras escribes, ChatGPT no puede listar pestañas, extraer texto, capturar ni actuar.
Las flechas cambian la única pestaña humana visible cuando la sesión tiene varias.

Al devolver una sesión pública, LocalBridge muestra el hostname que se compartirá. Puedes
continuar una vez, recordarlo como acceso exacto sin guardar cookies, o seguir con el control
humano. La concesión dura 15 minutos desde la primera devolución, restringe toda la sesión
a ese hostname y cierra las demás pestañas. Antes de reactivar a ChatGPT, corta conexiones,
limpia caché y workers y recarga la URL actual bajo esa frontera. El inicio de sesión puede
continuar, pero un formulario o estado solo presente en la página puede perderse; el diálogo
lo avisa antes de devolver. Para un acceso con cuenta ya configurado, la devolución usa su
autoridad vigente. **Cancelar sesión** destruye su estado efímero.

La solicitud de control humano retira cualquier vista pasiva antes de publicar el estado
privado. Al devolver el control, la ventana queda oculta hasta que vuelvas a abrirla de forma
local.

La auditoría de Actividad agrupa los diagnósticos técnicos bajo su operación y muestra
contadores separados de operaciones, fallos reales, recuperaciones y detalles. Puedes
elegir una acción de diagnóstico en el filtro si necesitas ver cada evento forense.

Puedes deshabilitar o eliminar el perfil en cualquier momento. Eso cierra sus sesiones y
conexiones sin detener terminales, procesos o pruebas web locales.

## Documentos e informes

`document.read` extrae texto de PDFs dentro de carpetas con permiso de lectura. Devuelve
páginas, hash y truncado. No ejecuta acciones o adjuntos, no sigue enlaces y no aplica OCR;
un escaneo sin capa de texto se informa como limitación.

Para guardar desde Internet, habilita **Descargar documentos y medios** en el perfil y
**Crear archivos** en la carpeta de destino. `web.extract` aporta documentos observados y
`web.assets` aporta imágenes, vídeos, posters, fuentes y CSS. `web.download` recibe una
referencia opaca, no una URL libre, y comprueba cuota, destino, extensión, MIME y firma. El
archivo debe ser nuevo; para renombrarlo usa la operación de archivo dentro del mismo
workspace. SVG se rechaza; una URL de recurso visible no muestra su consulta ni fragmento.
Reemplazar informes existentes requiere leer el SHA-256 actual.

Cuando necesitas evidencia visual persistente, ChatGPT puede guardar la captura web y la de
localhost como PNG en la carpeta autorizada. `visual.compare` exige que ambas tengan las
mismas dimensiones y crea un PNG de diferencias con hashes, cantidad de píxeles distintos y
proporción. Sin las dos capturas comparables, el resultado debe presentarse como aproximación
visual no verificada. La comparación automática admite hasta 2560×1440; los viewports de
navegación pueden ser mayores aunque no se comparen con esta operación.

Para estudiar movimiento, pide que recorra el mismo tramo de scroll en la referencia y en
localhost. LocalBridge puede inventariar animaciones CSS/WAAPI y elementos sticky, guardar
cada recorrido como un directorio `.lbmotion` y comparar sus fotogramas por progreso. Una
traza contiene manifiesto, hoja de contacto y 3–24 PNG; Actividad muestra progreso,
**Cancelar captura** y el recibo final. `stepped` es muestreo determinista y puede omitir
estados breves; `screencast` observa un scroll continuo y declara frames descartados. Las
páginas con anuncios, fuentes tardías, canvas, WebGL o iframes externos pueden variar entre
ejecuciones, por lo que conviene repetir antes de atribuir una diferencia a una animación.

Después de un clic web, `effect_pending` significa que LocalBridge demostró el despacho pero
aún no el resultado. ChatGPT debe esperar u observar otra vez antes de afirmar que navegó,
descargó o completó una acción. La lista de pestañas muestra contadores de descargas,
selectores de archivo y diálogos que Chromium haya bloqueado, incluidos los tardíos.

## Git

La consulta de estado, diff e historial respeta la raíz autorizada. `git.commit` y
`git.push` son operaciones separadas y protegidas. Antes de aprobar:

1. revisa archivos staged y diff;
2. confirma el mensaje del commit;
3. verifica remoto, rama y commits que se publicarán;
4. comprueba el estado final en el proveedor Git.

LocalBridge no hace force-push.

## Actividad y diagnóstico

La vista **Actividad** muestra navegadores LOCAL/INTERNET, procesos, terminales y operaciones
auditadas. **Cerrar recursos locales** conserva su alcance de desarrollo y no termina una
investigación; cada sesión de Internet se cierra desde su propia tarjeta. El contador refleja
recursos activos. El detalle técnico permanece plegado. **Copiar diagnóstico** redacta
información sensible, pero debes revisarla antes de compartirla.

Nunca publiques claves, rutas personales, contenido de proyectos, bases SQLite ni archivos
de configuración de LocalBridge.

## Cerrar y revocar

Cerrar la ventana puede dejar LocalBridge en la bandeja. Usa **Salir** para desconectar y
terminar. Para una revocación completa, elimina o pausa el proyecto, olvida la clave local y
revoca también el túnel en su proveedor.
