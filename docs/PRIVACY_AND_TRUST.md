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

## Qué puede cruzar el túnel

Solo la entrada y el resultado de una tool MCP solicitada por el cliente: por ejemplo, el
contenido de un archivo autorizado al llamar `file.read`, un diff al llamar `git.diff` o
la salida acotada de una validación previamente aprobada. Los permisos del workspace, la
denylist, los hashes esperados y las aprobaciones humanas siguen aplicándose antes de cada
operación.

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

La auditoría local permite revisar operaciones permitidas, fallidas y denegadas sin
guardar contenido de archivos ni rutas absolutas.
