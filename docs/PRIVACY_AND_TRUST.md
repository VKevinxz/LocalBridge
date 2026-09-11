# Privacidad, confianza y revocación

LocalBridge funciona como un puente bajo control del usuario. En modo Guiado, cada carpeta
y cada capacidad empiezan fuera de alcance hasta que se autorizan. **Control total del
equipo** es una excepción avanzada: ejecuta con la autoridad de la cuenta Windows y la
carpeta actúa como contexto, no como frontera de seguridad.

## Qué permanece local

- Rutas absolutas de proyectos y configuración interna de la aplicación.
- Claves de runtime, cifradas con el almacén de la cuenta de Windows.
- Base SQLite de auditoría y logs de la sesión.
- Contenido de archivos que ninguna tool haya solicitado.
- Credenciales y configuración local de Git.
- Comandos y salida de terminal, salvo el buffer temporal necesario durante una sesión.
- Cookies y almacenamiento de las sesiones web efímeras mientras LocalBridge siga abierto.
- Credenciales introducidas durante control humano; LocalBridge no las devuelve por MCP.

## Qué puede cruzar el túnel

Solo la entrada y el resultado de una tool MCP solicitada por el cliente: por ejemplo, el
contenido de un archivo autorizado al llamar `file.read`, un diff al llamar `git.diff` o
la salida acotada de una validación previamente aprobada. Los permisos del workspace, la
denylist, los hashes esperados y las aprobaciones humanas siguen aplicándose antes de cada
operación.

Al usar `web.*`, también pueden cruzar el túnel el texto visible extraído, la URL final
consultada, metadatos acotados de controles y capturas solicitadas. Las consultas y datos
enviados a una página salen a ese sitio por Internet. El perfil web no autoriza archivos:
guardar una descarga o informe necesita además un workspace escribible.

Durante **Tomar control**, el agente no puede listar pestañas, extraer texto, capturar ni
interactuar con esa sesión. Devolver el control crea una frontera nueva de observación; las
referencias anteriores ya no sirven. Un perfil de sitio puede permitir que ChatGPT vea el
contenido posterior al login cuando la persona devuelve el control.

En una sesión pública, devolver control requiere elegir localmente el hostname exacto que
podrá observarse durante 15 minutos. LocalBridge cierra las otras pestañas y conexiones,
limpia caché y workers, limita frames y solicitudes al mismo hostname y recarga la URL
actual antes de reinstalar observación. El diálogo avisa que puede perderse un formulario
no guardado. Después invalida las referencias anteriores.
**Recordar este acceso** guarda una regla separada sin cookies, contraseña ni historial. La
concesión temporal vive solo en memoria y no se renueva al reconectar.

**Ver y seguir** es una presentación local de la misma pestaña web. No genera capturas en
segundo plano, no duplica la navegación y no envía contenido adicional por el túnel. La
ventana rechaza entrada y no guarda qué sesión o pestaña se observó. Al comenzar un handoff
se retira antes de mostrar datos privados y no reaparece automáticamente al finalizar.

En Control total, el cliente puede interactuar con una terminal con la autoridad elegida
localmente. Esa capacidad se presenta y revoca por separado; no debe confundirse con los
límites de un workspace Guiado.

## Perfiles y claves

Cada perfil de conexión tiene un tunnel ID público, un directorio de `tunnel-client` y un
archivo de clave cifrada independientes. Cambiar de perfil exige desconectar primero. Un
blob DPAPI no es portable: otra cuenta de Windows u otra PC debe introducir una clave
nueva.

## Exportar e importar

El formato portable contiene nombres de perfiles, tunnel IDs, permisos, límites, denylist
y validaciones. Excluye claves, blobs cifrados, rutas absolutas, auditoría, logs y rutas
heredadas. Durante la importación se debe elegir de nuevo una carpeta local para cada
proyecto; no existe una opción para aceptar automáticamente las rutas del otro equipo.
La confianza de Control total tampoco se importa activa.

## Revocar acceso

1. En **Proyectos**, pausa o elimina la carpeta autorizada. Eliminarla de LocalBridge no
   borra la carpeta del disco.
2. En **Ajustes**, olvida la clave del perfil para eliminar su copia cifrada local.
3. En la página oficial de Tunnels de OpenAI, revoca o elimina el túnel para cortar el
   acceso remoto.
4. Si Git usa credenciales propias, revócalas en su proveedor por separado.
5. En **Acceso a Internet**, deshabilita o elimina el perfil para cerrar sus pestañas,
   conexiones y almacenamiento efímero sin detener proyectos o navegadores locales.

La auditoría local permite revisar operaciones permitidas, fallidas y denegadas sin
guardar contenido de archivos ni rutas absolutas.
