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

El agente puede navegar, inspeccionar accesibilidad, consola y red, y tomar capturas
efímeras. **Ver navegador** permite observar la sesión sin duplicar la página.

Cuando necesites escribir credenciales, seleccionar un archivo o completar un paso privado,
usa **Tomar control**. Durante ese intervalo el agente queda excluido. Devuelve la sesión
explícitamente cuando termines. Usa cuentas y datos de prueba: una aplicación abierta puede
copiar lo introducido a su propio DOM o servidor.

## Git

La consulta de estado, diff e historial respeta la raíz autorizada. `git.commit` y
`git.push` son operaciones separadas y protegidas. Antes de aprobar:

1. revisa archivos staged y diff;
2. confirma el mensaje del commit;
3. verifica remoto, rama y commits que se publicarán;
4. comprueba el estado final en el proveedor Git.

LocalBridge no hace force-push.

## Actividad y diagnóstico

La vista **Actividad** muestra procesos, navegadores y operaciones auditadas. El detalle
técnico permanece plegado. **Copiar diagnóstico** redacta información sensible, pero debes
revisarla antes de compartirla.

Nunca publiques claves, rutas personales, contenido de proyectos, bases SQLite ni archivos
de configuración de LocalBridge.

## Cerrar y revocar

Cerrar la ventana puede dejar LocalBridge en la bandeja. Usa **Salir** para desconectar y
terminar. Para una revocación completa, elimina o pausa el proyecto, olvida la clave local y
revoca también el túnel en su proveedor.
