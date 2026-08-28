# TOOL CATALOG — LocalBridge MCP v1

**Versión:** 1.0 · **Fecha:** 19 de agosto de 2026

Contrato de cada tool MCP expuesta por el servidor (v1 más las ampliaciones de v2 ya
implementadas — marcadas explícitamente como tales en su sección). Este catálogo es
normativo: una tool que no está aquí no se implementa, y una tool que está aquí no cambia
de forma sin actualizar este documento.

---

## 0. Reglas transversales

Aplican a **todas** las tools.

### 0.1 Entrada

- Toda entrada se valida con Zod antes de usarse. Entrada inválida → `INVALID_INPUT`.
- Las rutas son **siempre relativas** al workspace. Una ruta absoluta se rechaza con
  `ABSOLUTE_PATH_FORBIDDEN`, no se normaliza ni se reinterpreta.
- El root nunca viaja en la entrada. Solo `workspaceId`.
- Campos desconocidos se rechazan (`strict`), no se ignoran.

### 0.2 Salida

- Todo resultado incluye `resultType: "complete"` (MCP 2026-07-28).
- Ninguna salida contiene rutas absolutas, `rootPath`, stack traces ni datos de otros
  workspaces.
- Los resultados de `tools/list` se devuelven en **orden determinista** y con `ttlMs` y
  `cacheScope`.

### 0.3 Cacheabilidad

| Resultado | `cacheScope` | Motivo |
|---|---|---|
| `tools/list` | `private` | Las descripciones de Git reflejan el modo local de aprobación |
| Todo lo demás | `private` | Depende de los workspaces del usuario |

Marcar como `public` una salida dependiente del usuario permitiría a un intermediario
compartido servirla a otro usuario. Ver `SECURITY.md`.

### 0.4 Auditoría

Toda tool con permisos y recurso (es decir, todas salvo `system.health`) deja un
`AuditEvent` en `audit.db` por llamada — éxito o error, permitido o denegado por igual.
El `resource` que queda registrado es siempre el mismo
que viaja en la respuesta: relativo al workspace, nunca una ruta absoluta ni contenido, ni
siquiera cuando la llamada se rechaza por `ABSOLUTE_PATH_FORBIDDEN` (`SEC-026`). Un fallo al
escribir en la auditoría se registra en el log operativo pero nunca bloquea ni revierte la
operación — la auditoría es evidencia adicional, no una puerta de autorización.

### 0.4 Errores

Forma estándar:

```json
{ "ok": false, "error": { "code": "...", "message": "...", "recoverable": true } }
```

El mensaje debe orientar la recuperación. `HASH_MISMATCH` dice *"re-lee el archivo y
reintenta"*, no *"hash inválido"*.

### 0.5 RPC obligatorio del protocolo

Además de las tools, el servidor **DEBE** implementar `server/discover` anunciando
versiones de protocolo soportadas, capacidades e identidad. No es una tool: es un
requisito del transporte (Fase 1).

---

## 1. `system.health`

**Riesgo:** R0 · **Permiso:** ninguno · **Fase:** 1

Comprobación de vida. Sirve como primera tool para validar SDK, schemas, Inspector y —
crucialmente — la conectividad remota antes de que exista código de filesystem.

**Entrada:** `{}`

**Salida:**

```json
{
  "status": "ready",
  "version": "1.1.0",
  "protocolRevision": "2026-07-28"
}
```

No revela número de workspaces, rutas, ni información del host.

---

## 2. `workspace.list`

**Riesgo:** R1 · **Permiso:** ninguno (pero solo lista lo autorizado) · **Fase:** 2

Devuelve **únicamente** los workspaces autorizados y habilitados. Nunca revela otras
rutas del disco ni el `rootPath` absoluto.

**Entrada:** `{}`

**Salida:**

```json
{
  "workspaces": [
    {
      "workspaceId": "ws_7f3a91",
      "name": "Carpeta-Docente",
      "permissions": {
        "read": true, "write": true, "overwrite": false,
        "gitRead": true, "validations": true
      },
      "limits": { "maxFileBytes": 1048576, "maxTreeEntries": 300, "maxTreeDepth": 3 }
    }
  ]
}
```

Exponer los permisos permite al agente **no intentar** operaciones que fallarán, lo que
reduce ruido y llamadas denegadas.

**Errores:** ninguno específico.

---

## 3. `workspace.tree`

**Riesgo:** R1 · **Permiso:** `read` · **Fase:** 2

**Entrada:**

```json
{
  "workspaceId": "ws_7f3a91",
  "relativePath": "src",
  "maxDepth": 3,
  "maxEntries": 300
}
```

`relativePath` por defecto `"."`. `maxDepth` y `maxEntries` se acotan al mínimo entre lo
pedido y el límite del workspace.

**Salida:**

```json
{
  "path": "src",
  "entries": [
    { "path": "src/index.ts", "type": "file", "size": 1234 },
    { "path": "src/lib",      "type": "dir" }
  ],
  "truncated": false,
  "excluded": ["node_modules", "dist"]
}
```

**Protecciones:** profundidad máxima · entradas máximas · timeout · exclusión de
directorios pesados (`node_modules`, `vendor`, `.git/objects`, `dist`, `build`, `.cache`)
· omisión de archivos de la denylist de secretos.

`truncated: true` cuando se alcanzó un límite — el agente debe saber que la vista es
parcial, nunca creer que vio todo el árbol.

Nunca se sigue un symlink dentro del recorrido: ni se lista ni se desciende por él. Es una
simplificación deliberada — el árbol es un índice, no necesita pagar el coste de una
verificación completa por `realpath` en cada nodo; esa verificación sí ocurre, completa,
cuando el agente apunta `file.read`/`file.metadata` a una ruta concreta.

Apuntar `relativePath` a un **archivo** (no un directorio) no es un error: se devuelve
`entries: []`, ya que un archivo no tiene hijos que listar.

**Errores:** `WORKSPACE_NOT_FOUND`, `WORKSPACE_DISABLED`, `CAPABILITY_DISABLED`,
`PATH_OUTSIDE_WORKSPACE`, `ABSOLUTE_PATH_FORBIDDEN`, `SYMLINK_ESCAPE`, `FILE_NOT_FOUND`,
`TIMEOUT`.

---

## 4. `workspace.search` (v2.3)

**Riesgo:** R1 · **Permiso:** `read` · **Fase:** v2.3

Búsqueda de una subcadena **literal** en el contenido de los archivos de un workspace —
sin modo regex, a propósito: una expresión regular arbitraria puede exhibir backtracking
catastrófico (ReDoS) sobre una línea de apenas ~30 caracteres, y esa llamada síncrona
bloquearía el bucle de eventos sin que el timeout de la propia tool pudiera interrumpirla.
Es la misma postura que `:(literal)` en las tools de Git: se evita la clase de
vulnerabilidad entera en vez de intentar acotarla.

**Entrada:**

```json
{
  "workspaceId": "ws_7f3a91",
  "query": "TODO",
  "relativePath": "src",
  "caseSensitive": false,
  "maxResults": 200
}
```

`relativePath` por defecto `"."` y puede apuntar a un archivo concreto, no solo a un
directorio. `caseSensitive` por defecto `false`. `maxResults` se acota a un techo fijo
(1000), igual patrón que `maxEntries` en `workspace.tree`.

**Salida:**

```json
{
  "matches": [
    { "path": "src/index.ts", "line": 12, "text": "  // TODO: revisar esto" }
  ],
  "filesScanned": 34,
  "truncated": false
}
```

**Protecciones:** mismo sandbox de rutas y denylist de secretos que `file.read` ·
exclusión de los mismos directorios pesados que `workspace.tree` (`node_modules`,
`vendor`, `.git/objects`, `dist`, `build`, `.cache`) · symlinks nunca seguidos · archivos
binarios detectados por un byte NUL en los primeros bytes y omitidos silenciosamente ·
archivos mayores que `maxFileBytes` del workspace se saltan sin leerse (igual invariante
que `file.read`/`FILE_TOO_LARGE`, pero aquí se omiten en vez de fallar, porque una
búsqueda recorre muchos archivos y uno grande no debe abortar el resto) · timeout duro de
5s sobre el recorrido completo.

`truncated: true` cuando se alcanzó `maxResults` o el timeout — resultados parciales,
nunca hay que asumir que se vieron todas las coincidencias.

**Errores:** `WORKSPACE_NOT_FOUND`, `WORKSPACE_DISABLED`, `CAPABILITY_DISABLED`,
`PATH_OUTSIDE_WORKSPACE`, `ABSOLUTE_PATH_FORBIDDEN`, `SYMLINK_ESCAPE`, `FILE_NOT_FOUND`,
`INVALID_INPUT` (query vacía), `TIMEOUT`.

---

## 5. `file.read`

**Riesgo:** R1 · **Permiso:** `read` · **Fase:** 2

**Entrada:**

```json
{ "workspaceId": "ws_7f3a91", "path": "src/index.ts", "maxBytes": 65536 }
```

**Salida:**

```json
{
  "path": "src/index.ts",
  "content": "...",
  "sha256": "a3f1...",
  "size": 1234,
  "truncated": false,
  "modifiedAt": "2026-08-19T10:22:31.000Z"
}
```

**`sha256` es el hash del contenido completo del archivo en disco, no del fragmento
devuelto.** Es la pieza que hace posible la escritura guardada; si se calculara sobre el
contenido truncado, una escritura posterior compararía contra un valor sin significado.

Si el archivo se trunca, el agente **no debe** usar ese contenido como base de un
reemplazo total. Documentarlo en la descripción de la tool.

**Errores:** `FILE_NOT_FOUND`, `FILE_TOO_LARGE`, `NOT_A_FILE`, `PATH_DENIED`, más los de
workspace y ruta.

---

## 6. `file.metadata`

**Riesgo:** R1 · **Permiso:** `read` · **Fase:** 2

No devuelve contenido. Útil para que el agente compruebe si un archivo cambió sin
gastar contexto.

**Entrada:** `{ "workspaceId": "ws_7f3a91", "path": "src/index.ts" }`

**Salida:**

```json
{
  "path": "src/index.ts",
  "exists": true,
  "type": "file",
  "size": 1234,
  "sha256": "a3f1...",
  "modifiedAt": "2026-08-19T10:22:31.000Z"
}
```

Para un archivo inexistente devuelve `exists: false` **sin error** — es una consulta
legítima, no un fallo. Para una ruta denegada por la denylist sí devuelve `PATH_DENIED`.

Para un **directorio**, `type: "dir"` y sin `size`/`sha256` (no son significativos). Para
tipos especiales (sockets, dispositivos) se omiten `type`, `size` y `sha256`, pero
`exists: true` se mantiene.

`file.metadata` hashea el archivo completo igual que `file.read` — es lo que permite
comparar directamente el `sha256` de ambas tools. Por el mismo motivo respeta el mismo
techo de tamaño: un archivo que excede `maxFileBytes` no se hashea, para que esta tool no
sea una vía indirecta de forzar la lectura de algo que `file.read` rechazaría.

**Errores:** `FILE_TOO_LARGE`, `PATH_DENIED`, más los de workspace y ruta.

---

## 7. `file.create`

**Riesgo:** R2 · **Permiso:** `write` · **Fase:** 3

Crea un archivo **que no existe**.

**Entrada:**

```json
{
  "workspaceId": "ws_7f3a91",
  "path": "docs/new.md",
  "content": "...",
  "operationId": "op_a91f3c"
}
```

`operationId` es opcional y actúa como clave de idempotencia (ver `SECURITY.md`
amenaza J).

**Salida:**

```json
{ "path": "docs/new.md", "sha256": "b2c4...", "size": 512, "created": true }
```

**Condiciones:** `write = true` · el archivo **no** debe existir · no debe seguir un
symlink fuera del root · tamaño dentro del límite · directorios padre creados solo dentro
del workspace.

**Si el archivo existe → `FILE_ALREADY_EXISTS`.** Nunca convertir una creación en
sobrescritura, bajo ninguna circunstancia. Es la diferencia entre un permiso `write` y un
permiso `overwrite`, y el usuario los concedió por separado.

**`SYMLINK_ESCAPE` se lanza ante *cualquier* symlink en la posición final de la ruta** —
no solo los que apuntan fuera del workspace. Un symlink interno legítimo tampoco es un
destino válido para `file.create`: distinguir "symlink seguro" de "symlink peligroso"
exigiría resolver su destino, y esa resolución es precisamente lo que no se puede hacer de
forma fiable cuando el symlink está colgante (destino inexistente todavía).

**Errores:** `CAPABILITY_DISABLED`, `FILE_ALREADY_EXISTS`, `FILE_TOO_LARGE`,
`PATH_DENIED`, `SYMLINK_ESCAPE`, `NOT_A_FILE` (un segmento intermedio de la ruta ya existe
como archivo, no como directorio), más los de workspace y ruta.

---

## 8. `file.write_guarded`

**Riesgo:** R3 · **Permiso:** `overwrite` · **Fase:** 3

Reemplaza el contenido de un archivo existente, protegido por hash.

**Entrada:**

```json
{
  "workspaceId": "ws_7f3a91",
  "path": "src/index.ts",
  "expectedSha256": "a3f1...",
  "content": "...",
  "operationId": "op_5d8e21"
}
```

`expectedSha256` es **obligatorio**. No existe modo "forzar" en la v1.

**Flujo:**

```text
file.read  →  sha256 = A
     ↓
el agente modifica el contenido
     ↓
file.write_guarded(expectedSha256 = A)
     ↓
el servidor revalida la ruta y recalcula el hash del disco
     ├── coincide  → escritura atómica → nuevo sha256
     └── difiere   → HASH_MISMATCH (no se escribe nada)
```

El recálculo ocurre **inmediatamente antes** de escribir, dentro del mutex de
`(workspaceId, path)`, no en la validación de entrada.

**Salida:**

```json
{ "path": "src/index.ts", "sha256": "c9d2...", "size": 1310, "previousSha256": "a3f1..." }
```

**Errores:** `CAPABILITY_DISABLED`, `HASH_MISMATCH`, `FILE_NOT_FOUND`, `FILE_TOO_LARGE`,
`NOT_A_FILE`, `PATH_DENIED`, `SYMLINK_ESCAPE`.

`HASH_MISMATCH` es `recoverable: true`: el camino de recuperación es re-leer y reintentar,
y el mensaje debe decirlo.

Igual que en `file.create`, `SYMLINK_ESCAPE` se lanza ante cualquier symlink en la
posición final, exista o no su destino, resuelva dentro o fuera del workspace — la
comprobación ocurre **antes** de leer el archivo para comparar el hash, así que un
`expectedSha256` cualquiera no sirve para sortearla.

`operationId` en ambas tools: si se repite el mismo valor, se devuelve el resultado de la
primera ejecución exitosa sin volver a aplicar la mutación (`SEC-022`). Solo se cachean
éxitos — un intento fallido con un `operationId` dado puede reintentarse con normalidad.

---

## 9. `file.delete` / `file.move` (v2.4)

**Riesgo:** R3 · **Permiso:** `overwrite` · **Fase:** v2.4

Guardadas por hash, **igual patrón que `file.write_guarded`** — no aprobación humana
(MRTR) como `git.commit`/`git.push`. Decisión deliberada: borrar o mover un archivo dentro
de un workspace ya autorizado con `overwrite` es la misma clase de riesgo que reemplazar su
contenido (ambas destruyen estado anterior sin posibilidad de deshacer desde este
servidor), y `file.write_guarded` ya resuelve esa clase con hash-guard + permiso, no con un
humano confirmando cada llamada. `git.push`, en cambio, sí tiene una razón concreta y
distinta para exigir aprobación: su efecto sale de la máquina.

### 9.1 `file.delete`

**Entrada:**

```json
{ "workspaceId": "ws_7f3a91", "path": "docs/viejo.md", "expectedSha256": "b2c4...", "operationId": "op_a91f3c" }
```

**Salida:** `{ "path": "docs/viejo.md", "deleted": true }`

Solo borra **archivos**: un directorio como `path` da `NOT_A_FILE`, nunca se borra un
árbol. No hay variante recursiva.

**Errores:** `HASH_MISMATCH`, `FILE_NOT_FOUND`, `NOT_A_FILE`, `PATH_DENIED`,
`SYMLINK_ESCAPE`, `FILE_TOO_LARGE`, `CAPABILITY_DISABLED`.

### 9.2 `file.move`

**Entrada:**

```json
{ "workspaceId": "ws_7f3a91", "sourcePath": "src/viejo.ts", "destPath": "src/nuevo.ts", "expectedSha256": "b2c4...", "operationId": "op_a91f3c" }
```

`expectedSha256` guarda el contenido de `sourcePath` en el momento del movimiento.

**Salida:** `{ "sourcePath": "src/viejo.ts", "destPath": "src/nuevo.ts", "sha256": "b2c4...", "size": 512 }`

**Si `destPath` ya existe → `FILE_ALREADY_EXISTS`.** Igual invariante que `file.create`:
crear (aquí, aparecer en el destino) y sobrescribir son actos separados; para reemplazar un
destino existente hace falta borrarlo primero con su propia llamada guardada por hash. Los
directorios intermedios que falten en `destPath` se crean automáticamente, igual que en
`file.create`. `sourcePath` igual a `destPath` → `INVALID_INPUT`.

**Errores:** `HASH_MISMATCH`, `FILE_NOT_FOUND`, `NOT_A_FILE`, `FILE_ALREADY_EXISTS`,
`INVALID_INPUT`, `PATH_DENIED`, `SYMLINK_ESCAPE`, `FILE_TOO_LARGE`, `CAPABILITY_DISABLED`.

`operationId` en ambas: mismo contrato de idempotencia que `file.create`/`file.write_guarded`
— repetir el valor devuelve el resultado ya aplicado en vez de fallar con `FILE_NOT_FOUND`
sobre un archivo que la primera llamada ya movió o borró.

---

## 10. Git de solo lectura

**Riesgo:** R1 · **Permiso:** `gitRead` · **Fase:** 4

Cuatro tools cerradas. **Ninguna acepta una cadena Git arbitraria.**

Incorrecto — nunca se implementa:

```json
{ "command": "git whatever ..." }
```

Correcto: parámetros acotados desde los que el servidor construye argumentos fijos.

```ts
spawn("git", ["status", "--porcelain=v1", "-b"], {
  cwd: workspace.rootPath,
  shell: false
});
```

`shell: false` siempre. Los valores controlados por el modelo que puedan empezar por `-`
van tras `--`, y además como pathspec **literal** (`:(literal)ruta`): sin esa magia, un
valor con `*` se interpretaría como comodín y podría coincidir con archivos que el agente
no nombró.

**Espacio de rutas.** Tanto en la entrada como en la salida, las rutas son **relativas al
workspace**, igual que en `file.read` y `workspace.tree` — un único espacio de rutas
coherente en todas las tools.

Esto exige dos traducciones cuando el workspace autorizado es un **subdirectorio** de un
repositorio mayor (caso normal), verificadas en la Fase 4:

1. **Acotado obligatorio.** Sin el pathspec `-- .`, `git status` desde un subdirectorio
   lista también los cambios del resto del repositorio (`../otro/secreto.txt`), revelando
   nombres de archivo **fuera del root autorizado**. Todas las operaciones basadas en
   rutas se acotan.
2. **Traducción de prefijo.** Git emite rutas relativas a la raíz del *repositorio*; se
   traducen restando el prefijo del workspace. Una ruta que caiga fuera se descarta en
   lugar de exponerse (defensa en profundidad sobre el acotado).

**Ejecución de comandos desde el repositorio.** `git.diff` pasa `--no-ext-diff` y
`--no-textconv` porque tanto `diff.external` (configurable en el propio repositorio) como
los filtros `textconv` de `.gitattributes` hacen que Git ejecute binarios arbitrarios. El
contenido del repositorio es material no confiable (`SECURITY.md` Amenaza C), así que esas
dos vías se cierran explícitamente.

El entorno del subproceso se **filtra**, no se hereda: sin variables del servidor, con
`GIT_TERMINAL_PROMPT=0` para que un repositorio que pida credenciales falle en vez de
quedarse colgado hasta el timeout.

### 8.1 `git.status`

**Entrada:** `{ "workspaceId": "ws_7f3a91" }`

**Salida:** rama actual, upstream, adelanto/retraso y lista de archivos con su estado
(rutas relativas).

### 8.2 `git.diff`

**Entrada:**

```json
{ "workspaceId": "ws_7f3a91", "filePath": "src/index.ts", "staged": false, "maxBytes": 65536 }
```

`filePath` opcional; si se omite, diff del working tree completo. Salida truncada con
`truncated: true` al superar `maxBytes`.

### 8.3 `git.log`

**Entrada:** `{ "workspaceId": "ws_7f3a91", "maxCount": 20, "filePath": "src/index.ts" }`

`maxCount` acotado (máximo 100). Salida: hash corto, autor, fecha ISO y asunto.

### 8.4 `git.branch`

**Entrada:** `{ "workspaceId": "ws_7f3a91" }` — lista de ramas locales y cuál es la actual.

**Errores de las cuatro:** `GIT_NOT_REPOSITORY`, `CAPABILITY_DISABLED`, `TIMEOUT`, más los
de workspace. `git.diff` y `git.log` añaden los de ruta (`PATH_DENIED`,
`PATH_OUTSIDE_WORKSPACE`, `ABSOLUTE_PATH_FORBIDDEN`) cuando se les pasa `filePath`.

El truncado no es un error: se reporta con `truncated: true` en la salida, igual que en
`file.read` y `workspace.tree`. `GIT_NOT_REPOSITORY` cubre también los casos de propiedad
dudosa del repositorio y de Git ausente en el sistema — un único código sin detalle, para
no revelar información del host.

**No se implementan:** `pull`, `checkout`, `reset`, `clean`, ni ninguna otra operación que
modifique el repositorio o el working tree. `stage`, `commit` y `push` sí existen —
ver §11, `Git de escritura`.

---

## 11. Git de escritura (v2)

**Riesgo:** R2 (`git.stage`) / R3 (`git.commit`, `git.push`) · **Permiso:** `gitWrite`

Tres tools, cerradas igual que las de solo lectura del §10 — ningún parámetro admite una
cadena Git ni un flag. **Nunca hay forma de forzar nada**: no existe un parámetro `force`
en ninguna de las tres, ni `--force`, ni `--force-with-lease`, ni `reset --hard`, ni `clean`
destructivo — es una ausencia en el código, no una validación en tiempo de ejecución.

`git.commit` y `git.push` exigen **aprobación humana**. El modo predeterminado usa el
protocolo multi-round-trip (MRTR, revisión 2026-07-28): la primera llamada devuelve un resultado `input_required` con
el contenido real de lo que se va a hacer (mensaje del commit, archivos, diff; o remoto,
rama y los commits que se publicarían), el cliente MCP se lo muestra al humano, y solo si
acepta se reintenta la llamada y se aplica la mutación. La aprobación está atada
criptográficamente (HMAC, `createRequestStateCodec` del SDK) al contenido exacto — un
`requestState` firmado para un commit no sirve para otro con distinto mensaje, ni para un
`git.push`, ni para otro workspace; si algo cambia entre pedir la aprobación y reintentar,
falla con `APPROVAL_INVALID` en vez de ejecutarse con datos obsoletos.

El modo explícito `host` para ChatGPT permite que el cliente muestre
su cuadro nativo antes de invocar y LocalBridge no añade una segunda ronda MRTR. No es una
aprobación inferida: `mrtr` sigue siendo el valor predeterminado y todo valor inválido cae
a él. El modo `host` conserva el permiso `gitWrite`, el estado exacto, el hardening y las
aprobaciones separadas de commit/push; su límite es que LocalBridge no recibe prueba
criptográfica del botón del host.

En modo MRTR, mientras esa primera ronda espera, LocalBridge muestra **“Esperando aprobación en
ChatGPT”** durante cinco minutos desde la última primera ronda. Los reintentos
idénticos se deduplican y refrescan el plazo para mantenerlo alineado con el token MRTR
más reciente; la vista nunca devuelve más de 100 pendientes. Es solo observabilidad local: no crea una vía de
aprobación en Electron ni permite ejecutar sin `inputResponses` MCP válidos. El cliente
debe presentar la elicitación al humano y esperar; repetir la primera llamada sin respuesta
no hace commit ni push.

### 9.1 `git.stage`

**Sin aprobación** — local y reversible con un `git reset` corriente.

**Entrada:** `{ "workspaceId": "ws_7f3a91", "paths": ["src/index.ts", "README.md"] }`

**Salida:** `{ "staged": ["src/index.ts", "README.md"] }`

Cada ruta pasa por el mismo sandbox que `file.read` (debe existir, resolver dentro del
workspace, no ser un symlink de escape) y por la denylist de secretos antes de llegar a
`git add` como pathspec literal — `git.stage` no es una vía para meter en el índice un
`.env` que ninguna otra tool podría tocar.

Solo acepta archivos regulares dentro del límite `maxFileBytes`. Si una ruta tiene un
atributo Git `filter` (por ejemplo Git LFS o un filtro `clean` personalizado), falla
cerrado con `INVALID_INPUT`: Git puede ejecutar ese filtro durante `add` y LocalBridge no
ejecuta programas implícitos definidos por el repositorio.

**Errores:** `PATH_DENIED`, `FILE_NOT_FOUND`, `INVALID_INPUT` (lista de rutas vacía), más
`GIT_NOT_REPOSITORY`, `CAPABILITY_DISABLED` y los de workspace.

### 9.2 `git.commit`

**Con aprobación**, siempre: MRTR firmado o cuadro nativo del host según la configuración
local explícita.

**Entrada:** `{ "workspaceId": "ws_7f3a91", "message": "fix: ...", "operationId": "op_a91f3c" }`

**Salida:** `{ "commitHash": "7cf5dbd1..." }`

Falla con `INVALID_INPUT` si no hay nada staged — nunca llega a pedir aprobación para un
commit vacío. La aprobación se ata al mensaje, árbol staged, padre y ref de rama exactos.
Tras aprobar se crea ese objeto con `commit-tree` y la rama avanza con un compare-and-swap
de `update-ref`; si otro proceso movió la rama, devuelve `APPROVAL_INVALID`. Nunca ejecuta
hooks de commit, `reference-transaction` ni firma GPG, y nunca usa `--amend`.

El workspace debe coincidir con la raíz del repositorio. Un subdirectorio autorizado no
puede commitear porque el índice Git es global y podría contener cambios externos. Una
ruta staged que coincida con la denylist también bloquea el commit aunque otro programa
la haya añadido al índice.

El mensaje está limitado a 4096 caracteres. `operationId` es opcional y actúa igual que en `file.create`/`file.write_guarded`: repetir
el mismo valor tras una conexión rota devuelve el resultado ya aplicado en vez de crear un
segundo commit — y no obliga a pedir aprobación otra vez.

**Errores:** `INVALID_INPUT`, `APPROVAL_DECLINED`, `APPROVAL_INVALID`, más
`GIT_NOT_REPOSITORY`, `CAPABILITY_DISABLED` y los de workspace.

### 9.3 `git.push`

**Con aprobación**, siempre — incluso justo después de aprobar el commit que se va a
publicar. Aprobar un commit no aprueba su push: son efectos distintos, uno local y uno
fuera de la máquina.

**Entrada:** `{ "workspaceId": "ws_7f3a91", "remote": "origin", "branch": "main", "operationId": "op_a91f3c" }`

`remote`/`branch` se proporcionan juntos o se omiten juntos; al omitirlos LocalBridge
resuelve el upstream configurado antes de pedir aprobación. Esta queda atada a remoto,
rama, URL resuelta y HEAD. El efecto usa el refspec exacto
`<hash-aprobado>:refs/heads/<rama>`: mover HEAD o cambiar la URL configurada después no
cambia qué se publica ni adónde.

**Salida:**

```json
{
  "status": "pushed",
  "commitHash": "7cf5dbd1...",
  "remote": "origin",
  "branch": "main",
  "remoteVerified": true,
  "localTrackingSynchronized": true
}
```

`status` vale `pushed` cuando Git aceptó una actualización y `up_to_date` cuando la rama
remota ya apuntaba al hash exacto antes del efecto; en ese segundo caso no se ejecuta un
push vacío. Después de publicar se comprueba por read-back que la rama remota apunta al
hash indicado. La referencia local correspondiente (`origin/main`, por ejemplo) se
sincroniza mediante compare-and-swap, nunca sobrescribiendo un cambio concurrente. Si el
upstream usa un refspec personalizado o hubo una carrera, el push puede estar verificado
con `localTrackingSynchronized: false`; eso no debe provocar otro push automático.

El mensaje de aprobación lista los commits que se publicarían (`git log <upstream>..HEAD`)
cuando se puede determinar; si no (primer push de una rama nueva, sin upstream y sin
`remote`/`branch` explícitos), lo dice explícitamente en vez de fingir una lista vacía.

Un rechazo del remoto (rama no fast-forward, protegida, etc.) es `GIT_PUSH_REJECTED` —
**nunca se reintenta con force**, ni automática ni manualmente: no hay parámetro para eso.

El push desactiva hooks y `core.fsmonitor`, ignora helpers de credenciales locales al repo,
restaura solo helpers de sistema/usuario y rechaza remote helpers, protocolos desconocidos,
múltiples push URLs y reescrituras URL locales. El workspace también debe ser la raíz del
repo. La salida nunca devuelve la URL ni el texto crudo de Git. El hash publicado se
registra también como recurso de auditoría.

**Errores:** `APPROVAL_DECLINED`, `APPROVAL_INVALID`, `GIT_PUSH_REJECTED`, más
`GIT_NOT_REPOSITORY`, `CAPABILITY_DISABLED` y los de workspace.

---

## 12. `validation.run`

**Riesgo:** R4 · **Permiso:** `validations` · **Fase:** 5

Ejecuta un comando **preaprobado por el usuario** en la configuración del workspace.

**Entrada:**

```json
{ "workspaceId": "ws_7f3a91", "profile": "test" }
```

El modelo elige el **perfil por nombre**. No aporta el comando, ni los argumentos, ni
variables de entorno, ni el directorio de trabajo.

**Configuración del workspace (no accesible al modelo):**

```json
{
  "validationProfiles": {
    "test":      ["pnpm", "test"],
    "lint":      ["pnpm", "lint"],
    "typecheck": ["pnpm", "typecheck"],
    "build":     ["pnpm", "build"]
  }
}
```

**Salida:**

```json
{
  "profile": "test",
  "exitCode": 1,
  "stdout": "...",
  "stderr": "...",
  "truncated": true,
  "durationMs": 8421,
  "timedOut": false
}
```

**Protecciones:** perfil inexistente → `COMMAND_NOT_ALLOWED` · `spawn` con `shell: false`
salvo una excepción quirúrgica en Windows para binarios `.cmd`/`.bat` reales
(`npm`/`npx`/`pnpm`/`yarn` — ver `adr/0006-sin-shell-genérico.md` adenda; el comando sigue
siendo siempre configuración estática del workspace, nunca aportada por el modelo) · `cwd`
fijado al root del workspace · entorno filtrado a una allowlist mínima · timeout con
muerte del árbol de procesos · truncado de stdout/stderr con marca explícita · una sola
validación concurrente por workspace.

Un `exitCode` distinto de 0 **no es un error de la tool**: es un resultado válido. El
agente necesita ver los tests fallando. Solo son errores de tool el perfil no permitido,
el timeout y los fallos de arranque.

**Un timeout real siempre es un error de tool** (`TIMEOUT`, `isError: true`), nunca un
resultado con `timedOut: true`. El campo `timedOut` existe en el esquema de salida por
completitud y siempre vale `false` en un resultado devuelto — si hubiera valido `true`, la
llamada habría terminado en error en su lugar. Resuelto así en Fase 5 porque la salida
parcial de un proceso matado a mitad de ejecución no es un resultado con el que el agente
pueda razonar con seguridad.

**Salida infinita (SEC-019):** en cuanto `stdout` o `stderr` superan el techo, se mata el
árbol de procesos de inmediato en vez de esperar el timeout completo — el resultado vuelve
con `truncated: true` mucho antes del límite de tiempo.

Esta tool cubre la mayor parte del trabajo real de un agente de programación **sin abrir
shell arbitrario**, que es exactamente el objetivo.

---

## 13. Entorno de desarrollo controlado (v0.3.0)

Estas tools solo funcionan mientras la aplicación Electron está abierta. El servidor MCP
se comunica con Electron mediante un Named Pipe local autenticado; no abre un puerto TCP.
Todas vuelven a comprobar el workspace y su permiso en el servidor MCP y en el broker.

### 13.1 Procesos aprobados

| Tool | Riesgo | Entrada adicional | Resultado |
|---|---:|---|---|
| `process.start` | R4 | `profile`, `operationId?` | ID opaco, estado y límite de tiempo |
| `process.list` | R2 | — | procesos administrados del workspace |
| `process.listeners` | R2 | `processId` | listeners TCP verificados, clase de bind y refs opacas |
| `process.logs` | R2 | `processId`, `cursor`, `maxBytes` | stdout/stderr acotado y cursor siguiente |
| `process.stop` | R3 | `processId`, `operationId?` | estado final |

**Permiso:** `processes`. El modelo nunca aporta comando, argumentos, cwd ni entorno. El
perfil viene de Electron y conserva una huella de su definición en `package.json`,
`composer.json` o Makefile. Un cambio posterior produce `PROFILE_STALE` hasta que el
usuario lo revise. En Windows, el proceso se incorpora suspendido a un Job Object antes
de ejecutarse; detenerlo, revocar el permiso o cerrar LocalBridge elimina el árbol entero.
El lanzador usa exclusivamente el `node.exe` autocontenido resuelto por Electron, nunca
`process.execPath`. No se devuelven PID, comando ni rutas absolutas.

`process.listeners` no interpreta stdout. El host nativo cruza los PID contenidos en el
Job Object con las tablas TCP IPv4/IPv6 de Windows, dos veces. Clasifica escuchas exactas
en `127.0.0.1`/`::1` y wildcard administradas, y marca si la familia/puerto es exclusiva.
Rechaza LAN explícita, UDP y puertos ambiguos o de otros procesos. Un wildcard solo es
adoptable por una aplicación local revisada; la variante dinámica simple sigue exigiendo
bind loopback exacto. La referencia caduca al cerrar o reasignarse el puerto.

### 13.2 Aplicaciones locales revisadas (v0.5.0)

| Tool | Riesgo | Entrada | Resultado |
|---|---:|---|---|
| `application.list` | R1 | `{}` | IDs opacos, nombres, servicios y estado de revisión |
| `application.start` | R4 | `applicationId`, `operationId?` | `runId` y readiness acotado por alias |
| `application.status` | R2 | `applicationId`, `runId` | estado sin PID, comando, ruta, URL ni logs |
| `application.stop` | R3 | `applicationId`, `runId`, `operationId?` | cierre de navegador y árbol completo |

**Permisos:** todos los servicios exigen `processes` + `browserRead` en sus workspaces.
Una aplicación debe existir globalmente y estar `reviewed`. MCP no aporta comandos, cwd,
entorno, servicios, orden, perfiles, hosts, puertos ni URLs. `application.start` inicia los
perfiles en orden y solo declara un servicio listo cuando el helper nativo demuestra un
listener exclusivo perteneciente a su Job Object. Si un miembro falla, hace rollback de
los ya iniciados. `operationId` vuelve idempotente el reintento; un `runId` no puede cruzarse
entre aplicaciones.

Solo la UI local puede crear, reparar, probar o aprobar una aplicación. El registro `v3`
mantiene permisos por workspace; la aplicación nunca concede capacidades.

Errores: `APPLICATION_PROFILE_NOT_FOUND`, `APPLICATION_REVIEW_REQUIRED`,
`APPLICATION_RUN_NOT_FOUND`, `APPLICATION_START_FAILED`,
`APPLICATION_CLEANUP_FAILED`, `PROFILE_REVIEW_REQUIRED` y `CAPABILITY_DISABLED`.

### 13.3 Navegador aislado de solo lectura

| Tool | Riesgo | Entrada adicional | Resultado |
|---|---:|---|---|
| `browser.start` | R3 | perfil, listener dinámico, compatibilidad multiservicio detallada, **o preferido:** `applicationId` + `runId`; `operationId?` | ID de sesión y estado |
| `browser.list` | R2 | — | sesiones del workspace |
| `browser.navigate` | R3 | `sessionId`, `path`, `operationId?` | estado y ruta relativa |
| `browser.snapshot` | R2 | `sessionId`, límites | árbol de accesibilidad y refs opacas |
| `browser.screenshot` | R2 | `sessionId` | imagen PNG + dimensiones |
| `browser.viewport` | R2 | `sessionId`, `width` 320-3840, `height` 320-2160, `mobile?`, `operationId?` | viewport aplicado |
| `browser.events` | R2 | `sessionId`, cursor/límite | consola y estado de red sin cuerpos/cabeceras |
| `browser.stop` | R3 | `sessionId`, `operationId?` | estado final |

**Permiso:** `browserRead`. Cada sesión usa una partición no persistente sin cookies del
navegador personal, Node, preload ni permisos web. Solo admite orígenes `http` con IP
loopback literal. El origen puede venir de un perfil estático preaprobado o de una
referencia emitida por `process.listeners`; MCP nunca proporciona URL ni puerto. La
adopción dinámica requiere `processes` además de `browserRead`, y la sesión se destruye
si el listener deja de pertenecer al proceso. Popups, descargas, permisos, protocolos y
orígenes externos se bloquean. Para HMR, `ws:` puede reutilizar exclusivamente la misma
IP y puerto de un origen `http:` aprobado cuando Electron marca el recurso como
WebSocket; `wss`, credenciales y cualquier autoridad distinta se deniegan.

`browser.viewport` emula el tamaño de la vista para comprobar diseño responsive. No
redimensiona la ventana del usuario, no navega, no cambia el origen permitido y no altera el
agente de usuario ni la escala del dispositivo. Acepta únicamente dimensiones enteras dentro
del rango indicado y una bandera táctil. Invalida el snapshot vigente, porque tras el
recálculo del diseño las referencias de elementos dejan de ser válidas; el tamaño se
restablece cuando el usuario toma el control local.

Una aplicación multiservicio contiene entre 1 y 8 aliases configurados localmente. En el
flujo `v0.5.0`, MCP aporta únicamente `applicationId` + `runId`; Electron recupera las refs
internas verificadas del orquestador. El contrato detallado anterior se conserva por
compatibilidad, pero tampoco permite aportar URL, host, puerto, workspace, comando ni
servicios extra. La colección debe coincidir exactamente con el perfil revisado. Cada
miembro requiere `processes` + `browserRead`; `localhost` se resuelve
exclusivamente a loopback dentro de la sesión y cada request/WebSocket revalida el binding
correspondiente. LocalBridge no actúa como proxy y no reescribe `Host`, `Origin`, CORS,
cookies ni cuerpos.

### 13.4 Interacción por snapshot

| Tool | Riesgo | Entrada adicional |
|---|---:|---|
| `browser.click` | R4 | `sessionId`, `snapshotId`, `elementRef`, `operationId?` |
| `browser.fill` | R4 | lo anterior + `text` |
| `browser.press` | R4 | lo anterior + una tecla de allowlist |

**Permisos:** `browserRead` + `browserInteract`. No existen selectores CSS/XPath,
coordenadas, JavaScript aportado por el modelo ni secuencias de teclas arbitrarias. Las referencias
solo son válidas para el snapshot vigente y se invalidan después de cada acción. `fill`
rechaza password, file, hidden, OTP, tokens y campos de pago; su texto no se registra en
auditoría. Los `operationId` hacen idempotente un reintento de transporte.

Errores específicos: `FEATURE_UNAVAILABLE`, `PROFILE_NOT_FOUND`,
`PROFILE_SOURCE_MISSING`, `PROFILE_SOURCE_INVALID`, `PROFILE_STALE`,
`PROFILE_REVIEW_REQUIRED`, `PROCESS_NOT_FOUND`, `LISTENER_NOT_FOUND`,
`SESSION_NOT_FOUND`, `STALE_SNAPSHOT`, `ORIGIN_BLOCKED` y
`SENSITIVE_INPUT_BLOCKED`. Aplicaciones: `APPLICATION_PROFILE_NOT_FOUND`,
`APPLICATION_REVIEW_REQUIRED`, `APPLICATION_RUN_NOT_FOUND`,
`APPLICATION_START_FAILED`, `APPLICATION_CLEANUP_FAILED`,
`APPLICATION_SERVICE_MISMATCH`, `APPLICATION_ORIGIN_CONFLICT`,
`MANAGED_WILDCARD_NOT_APPROVED` y `LOCALHOST_RESOLUTION_BLOCKED`.

### 13.5 Intervención humana universal (`v0.8.0`)

| Tool | Riesgo | Entrada | Resultado |
|---|---:|---|---|
| `browser.human.request` | R5 | `workspaceId`, `sessionId`, `reason`, `operationId` | reserva opaca, estado y caducidad |
| `browser.human.status` | R2 | `workspaceId`, `sessionId` | estado acotado |

`reason` solo acepta `sign_in`, `file_selection` o `manual_step`. Es informativo: las tres
opciones entregan exactamente la misma autoridad humana exclusiva. Ninguna tool acepta o
devuelve credenciales, rutas, nombres, bytes, URL, selector, texto libre o contenido.

`request` pausa/reserva, pero nunca abre la ventana; el usuario puede iniciar desde el
botón local **Tomar control** sin request MCP. Toda devolución activa un TTL sensible no
renovable. El permiso es `browserRead` + `browserHumanControl` en todos los
workspaces de la aplicación.

Durante `waiting_for_human`, `human_control` y `returning_to_agent`, todas las demás tools
de navegador fallan con `HUMAN_CONTROL_ACTIVE`; CDP, capturas y eventos quedan privados.
El usuario devuelve desde la barra confiable de la misma ventana. Revocación, timeout,
listener perdido o carrera destruyen la sesión y limpian su partición.

Errores: `HUMAN_CONTROL_NOT_ALLOWED`, `HUMAN_CONTROL_REQUEST_NOT_FOUND`,
`HUMAN_CONTROL_ACTIVE`, `HUMAN_CONTROL_EXPIRED`, `HUMAN_CONTROL_DECLINED` y
`HUMAN_CONTROL_BUSY`.

### 13.6 Visores locales (sin tools MCP)

**Visor ligero** muestra capturas efímeras en memoria. **Ventana en vivo** reutiliza la
misma instancia nativa con foco y ratón deshabilitados bajo control del agente. Ambos son
IPC local, mutuamente excluyentes y usan `browserRead`; no añaden catálogo ni autoridad.
La pantalla se elige por ID validado en el proceso principal y un hot-unplug usa fallback
local. Al tomar control humano, cualquier visor se oculta y la misma ventana se vuelve
interactiva solo para la persona.

Las tools heredadas `browser.auth.*` y `browser.manual.*` ya no forman parte del catálogo;
tras actualizar se debe refrescar o recrear el complemento y empezar un chat nuevo para
descubrir las tools vigentes.

### 13.7 Proyectos de desarrollo (`v0.9.0`)

| Tool | Riesgo | Entrada | Resultado acotado |
|---|---:|---|---|
| `project.list` | R1 | `{}` | IDs opacos, nombre, estado, cobertura del escaneo y cantidades |
| `project.status` | R1 | `projectId` | topología/estado, cantidades y recuperación sugerida |
| `project.setup.refresh` | R2 | `projectId` | nuevo análisis local y estado, sin ejecutar |

Las salidas nunca contienen roots, rutas absolutas, comandos, argumentos, entorno,
manifiestos, lockfiles, paquetes, dependencias, URLs, puertos ni huellas de toolchain.
Los campos desconocidos se rechazan.

`state` y `scanCoverage` describen la ficha local. `scanCoverage: "partial"` significa que
la estructura reportada está incompleta porque el recorrido local agotó su presupuesto;
**no** bloquea ninguna capacidad ni revela el tamaño del árbol. Solo `state` distinto de
`ready` limita la terminal, y únicamente por condiciones que un humano debe resolver:
varias raíces sin resolver, carpeta ausente o definiciones en conflicto. `refresh` puede invalidar una propuesta anterior,
pero no crea archivos, instala dependencias, concede permisos ni inicia procesos.

No existen `project.create`, `project.approve`, `project.execute` ni equivalentes. Crear,
adoptar, elegir política, aprobar y ejecutar son actos exclusivamente locales en Electron.
Una referencia de proyecto jamás autoriza un workspace que no siga visible y habilitado.

---

## 14. Diseño de descripciones de tools

Las descripciones que ve el modelo forman parte de la seguridad del sistema: una tool mal
descrita provoca llamadas inválidas, reintentos en bucle y presión para "ampliar
permisos".

Cada descripción debe indicar:

- qué hace y qué **no** hace;
- que las rutas son relativas al workspace;
- qué permiso requiere y qué ocurre si no lo tiene;
- para `file.read`, que `sha256` es del archivo completo y sirve para escribir después;
- para `file.write_guarded`, que hay que leer primero para obtener el hash;
- el camino de recuperación de sus errores más probables.

---

## 15. Terminal de proyecto

La terminal general se expresa mediante una máquina de sesiones y no mediante una tool
`shell.execute`. El nivel de confianza, root, shell, entorno y sandbox se resuelven
localmente desde el proyecto. MCP solo usa IDs opacos.

| Tool | Entrada principal | Resultado | Riesgo |
|---|---|---|---|
| `terminal.start` | `projectId`, `operationId` | sesión, estado y confianza efectiva | R6 |
| `terminal.write` | `projectId`, `sessionId`, texto/teclas, `operationId` | cursor aceptado | R6 |
| `terminal.read` | `projectId`, `sessionId`, cursor, límite | salida incremental acotada | R1 |
| `terminal.status` | `projectId`, `sessionId` | estado y exit code | R1 |
| `terminal.stop` | `projectId`, `sessionId`, `operationId` | estado final | R2 |

Protecciones obligatorias: schemas strict, IDs/epoch, confianza local no controlable por
MCP, `Guiado` deniega, sandbox fail-closed en `Agente en proyecto`, advertencia explícita
en `Control total`, Job Object, buffers acotados, sanitización ANSI/OSC, redacción de
secretos propios y cierre del árbol. No se aceptan rutas absolutas, roots, PIDs,
ejecutables, variables de entorno completas ni un trust mode en parámetros.

Concurrencia: hasta **8 sesiones por proyecto y 16 en total**; superarlo responde
`RATE_LIMITED`. El techo es fijo y ninguna tool puede elevarlo. Una sesión terminada conserva
su salida final durante 30 minutos o hasta que haya 24 sesiones cerradas retenidas; después,
`terminal.read` responde `TERMINAL_NOT_FOUND`. Cerrar cada terminal al acabar sigue siendo
responsabilidad del cliente.

### 14.1 `browser.start` desde un proyecto multiservicio

La variante terminal admite un listener principal y hasta siete secundarios:

```json
{
  "workspaceId": "ws_...",
  "projectId": "project_...",
  "terminalSessionId": "terminal_...",
  "listenerRef": "listener_...",
  "relatedListeners": [
    { "terminalSessionId": "terminal_...", "listenerRef": "listener_..." }
  ],
  "operationId": "opcional"
}
```

El primer par define la vista principal. Todos los pares deben ser únicos, pertenecer al
mismo proyecto y continuar vivos. MCP no aporta alias, URL, host, puerto, PID, comando,
root ni confianza. La salida de terminal puede conservar un hostname loopback compatible,
pero la autoridad continúa proviniendo del listener nativo. Wildcard exige Control total
activo y solo se expone al navegador como `localhost`.

Errores específicos: `PROJECT_BROWSER_LISTENER_MISMATCH`,
`PROJECT_BROWSER_ORIGIN_CONFLICT`, `PROJECT_BROWSER_PRIMARY_UNAVAILABLE`,
`LOCALHOST_ATTESTATION_FAILED`, `MANAGED_WILDCARD_NOT_APPROVED` y `LISTENER_STALE`.

## 16. Tools explícitamente no incluidas

| Tool | Motivo |
|---|---|
| `claim.*` | Coordinación multiagente no disponible |
| `agent.*` | Ciclo de vida de agentes no disponible |
| `workspace.add`, `workspace.setPermissions` | **Nunca vía MCP.** El modelo no amplía su propio acceso |

La última fila es la más importante: la autorización de workspaces y la concesión de
permisos son actos del **usuario**, realizados fuera del canal MCP. Exponerlos como tools
destruiría la primera invariante.
