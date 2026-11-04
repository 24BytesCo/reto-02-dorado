# Proyecto: agente de registro de contratos vigentes

## Contexto
Reto técnico 02 de Periferia IT Group (`PRD.md`). El maestro de contratos está congelado desde el 2026-05-30 y no existe un punto único de recepción. Construimos un agente conversacional que lee un buzón, extrae los datos de cada contrato con confianza por campo, detecta duplicados y actualizaciones, archiva en una estructura tipo SharePoint, alimenta el maestro y genera alertas.

## Stack
| Capa | Elección | Motivo |
|---|---|---|
| Runtime | Node 22 + `tsx` | El PRD admite Bun o Node 20+; `tsx` ejecuta TypeScript sin paso de compilación |
| Validación | `zod` | Obligatorio por el PRD para los argumentos de las herramientas |
| API | `express` | Mínima y conocida; la lógica no depende de ella |
| Front | HTML y JavaScript plano | El PRD lo admite; cero paso de construcción |
| Modelo | Anthropic, detrás de un adaptador propio | Cambiar de proveedor no toca el ciclo del agente |
| Pruebas | `node:test` | Incluido en Node, sin dependencias |

## Estructura (PRD §6.5)
```
agent/prompt.md                     comportamiento (system prompt)
src/knowledge/registro-contratos.md conocimiento del proceso
src/tools/contratos.ts              ejecución: herramientas contratos_*
src/llm/adapter.ts                  interfaz del proveedor
src/llm/anthropic.ts                implementación elegida
src/agent/                          ciclo del agente y sesiones
src/server.ts                       API HTTP
web/                                front de chat
fixtures/                           insumos de Periferia (no se modifican)
out/                                generado en ejecución (no se versiona)
demo.ts                             herramientas sin modelo
```

## Reglas de codificación

### Generales
1. **TypeScript estricto y sin `any`.** `tsc --noEmit` en verde antes de cada commit.
2. **Funciones cortas y con un solo propósito** (guía: menos de 40 líneas).
3. **Nombres del dominio tal como los nombra el PRD**: `id_contrato`, `requiere_revision`, `contratos_validar`. Sin sinónimos propios.
4. **JSDoc en todo lo exportado** (herramientas, adaptador, ciclo, funciones de dominio): qué hace, `@param` y `@returns` cuando no sean obvios, y la regla del PRD que implementa (`RN1`, `HU-4`, `CA3`). En lo interno, comentarios solo para el porqué.
5. **Dependencias mínimas**, cada una justificada en `SOLUCION.md`.

### Herramientas
6. Contrato del PRD §6.2: `{ description, args, execute(args, ctx) }`; el modelo las ve como `contratos_<export>`.
7. **Nunca lanzan.** Devuelven un string JSON `{ ok: true, data }` o `{ ok: false, error }` legible.
8. Cada campo de `args` lleva `.describe()`. El backend valida con zod **antes** de ejecutar y devuelve el error al modelo si no cumple.
9. Independientes del servidor: se importan igual desde `server.ts`, `demo.ts` y las pruebas.
10. Rutas relativas a `ctx.directory`. Sin comandos de shell.
11. **Determinismo**: la fecha de negocio (`hoy`) se inyecta; el reloj solo se usa para el `ts` de los logs.

### Datos
12. `fixtures/` es de solo lectura (RN6). Todo lo escrito va a `out/`; la demo lo limpia al inicio.
13. Toda llamada a herramienta deja una línea en `out/log.jsonl` (RN7); toda escritura en el maestro, una en `historial.jsonl`.

### El código manda sobre el modelo
14. Las invariantes (duplicados, umbral de confianza 0,8, confirmación humana) se hacen cumplir en las herramientas, no solo en el prompt.
15. El modelo no afirma valores que no salieron de una herramienta (CA2).

### Seguridad y costo
16. La clave del modelo solo en el entorno del backend: nunca en el front, el repositorio, los logs ni las respuestas de la API. `.env.example` sin valores.
17. Tope de iteraciones por turno, tope de tokens por sesión y timeout al proveedor, configurables.

### Proceso
18. **Una tarea de `tasks.md` = un issue = un commit** («Cierra #n»), en español: `#Título` y viñetas. Las tareas y sus issues se titulan `T<fase>.<n> | <pieza>: <qué hace>` (por ejemplo, `T1.4 | contratos_extraer: extracción determinista con confianza por campo`); el issue se cierra con un comentario que enlaza el commit.
19. Antes de cada commit: `npm run typecheck && npm test && npm run demo`.
20. Cada regla de negocio (RN1-RN7) y cada correo del buzón (§7.4) tiene al menos una prueba.
