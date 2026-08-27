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
        ├── Git estructurado
        ├── validaciones y procesos administrados
        ├── proyectos y terminal por confianza
        └── navegador local aislado
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

## Navegador

Cada sesión usa una partición efímera y una allowlist derivada de listeners verificados.
Las interacciones usan referencias de snapshot y la autoridad cambia de forma explícita
entre agente y usuario. Detener o revocar limpia procesos, navegador y almacenamiento
relacionado.

## Persistencia

Configuración, proyectos, confianza y onboarding usan schemas versionados y escrituras
atómicas. Las migraciones nunca conceden nuevas capacidades. Claves locales se cifran con
el almacén de Windows y no se incluyen en exportaciones portables.
