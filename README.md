# Agente de registro de contratos vigentes

Reto técnico 02 · Periferia IT Group · Alexis Dorado Muñoz (24 BYTES).
Agente conversacional que actúa como punto único de recepción de contratos: lee el buzón, extrae los datos con confianza por campo, detecta duplicados y actualizaciones, archiva tipo SharePoint, alimenta el maestro y genera alertas. Pide confirmación humana antes de registrar un dato dudoso.

**Link para probar:** https://nuevo.24bytes.pro (sin clave de acceso). El botón «Reiniciar demo» deja el buzón con los 6 mensajes otra vez.

## Levantar en local

Requiere Node 22 (el PRD admite Node 20+).

```bash
cp .env.example .env          # poner ANTHROPIC_API_KEY
npm install && npm run dev    # http://localhost:3000
```

Alternativa con Docker: `docker compose up --build` (lee `.env` y publica solo en `127.0.0.1:3000`).

Sin clave se puede levantar con `LLM_PROVEEDOR=simulado`: el chat responde, pero sin modelo real.

## Variables (`.env.example`)

| Variable | Por defecto | Para qué |
|---|---|---|
| `ANTHROPIC_API_KEY` | (vacía) | Clave del modelo. Solo en el backend; nunca llega al front, al repositorio ni a los logs |
| `LLM_PROVEEDOR` | `anthropic` | `anthropic` o `simulado` (sin clave, para pruebas) |
| `LLM_MODELO` | `claude-opus-5-5` | Modelo. Alternativa: `claude-sonnet-5-5` |
| `LLM_ESFUERZO` | `low` | Esfuerzo de razonamiento: `low`, `medium`, `high`, `xhigh` o `max`; un valor desconocido usa `low` |
| `LLM_TIMEOUT_MS` | `90000` | Tiempo máximo de espera al proveedor |
| `MAX_ITERACIONES` | `25` | Tope de idas modelo → herramientas por turno (CA1) |
| `MAX_TOKENS_SESION` | `600000` | Tope de tokens de entrada y salida por sesión (costo) |
| `MAX_TOKENS_GLOBAL` | `3000000` | Tope de tokens del motor sumando todas las sesiones; se persiste en `out/uso.json` |
| `LIMITE_TURNOS_HORA` | `40` | Turnos por IP y por hora en la API pública |
| `ENFRIAMIENTO_UMBRAL` | `6` | Turnos seguidos sin herramientas desde una IP antes de pausarla (0 la desactiva) |
| `ENFRIAMIENTO_MINUTOS` | `5` | Minutos de la primera pausa; cada reincidencia la triplica |
| `ENFRIAMIENTO_MAXIMO_MINUTOS` | `1440` | Techo de la pausa (24 h) |
| `PORT` | `3000` | Puerto HTTP |
| `TZ` | `America/Bogota` | Solo para los timestamps de los logs; ninguna regla usa el reloj |
| `BUZON_DIR` | `fixtures/reto-02/buzon` | Opcional: otro buzón para probar casos nuevos |
| `OUT_DIR` | `out` | Opcional: otra carpeta de salida, dentro del proyecto |

## Demo sin modelo

```bash
npm run demo        # también: bun run demo.ts (misma salida)
```

No necesita clave. Limpia `out/`, procesa los 6 mensajes con las mismas herramientas del agente e imprime por mensaje la clasificación, los campos en revisión y la acción:

| Mensaje | Resultado |
|---|---|
| msg-001 | `nuevo`, registrado en `Contratos/2026/industrias-delta/CT-2026-015.txt` |
| msg-002 | `nuevo`, registrado sin póliza (`no_aplica`) |
| msg-003 | `actualizacion` de CT-2026-011 (otrosí archivado como `CT-2026-011-otrosi-1.txt`) |
| msg-004 | `duplicado`, sin escritura |
| msg-005 | `rechazado`: es una cotización, no un contrato |
| msg-006 | `nuevo` con revisión en `valor, fecha_fin`: primero queda sin registrar; en la segunda pasada la analista confirma (valor 0, fin 2027-08-31) y se registra |

Cierra con las alertas para `hoy = 2026-09-03` y el estado final: maestro con 11 filas, 4 líneas de historial y 6 mensajes procesados.

## Pruebas

```bash
npm test             # 151 pruebas (node:test), sin clave ni red
npm run typecheck    # tsc --noEmit, modo strict
npm run cobertura    # cobertura con la herramienta de Node
npm run modulo       # regenera modulo/ (prompt, conocimiento y herramientas empaquetadas)
```

Cobertura medida: 97,02 % de líneas, 87,44 % de ramas y 96,01 % de funciones. Las reglas de negocio (`src/tools/`) están entre 98 % y 100 % de líneas. El adaptador de Anthropic (84,62 % de líneas) depende de la API real: se verificó con una corrida en vivo del caso completo del §11 (ver `SOLUCION.md`, sección 4).

## API

| Método | Ruta | Entrada → salida |
|---|---|---|
| `POST` | `/api/chat` | `{ sessionId, message }` → `{ reply, toolCalls[], needsConfirmation, pendientes, aviso? }` (`aviso` llega desde el segundo mensaje seguido fuera de propósito) |
| `POST` | `/api/chat` con `Accept: text/event-stream` | Stream SSE: eventos `texto`, `herramienta`, `resultado`, `uso`, `error` y un `fin` con el mismo objeto de arriba. Latido (`: latido`) cada 15 s |
| `GET` | `/api/sessions/:id` | `{ id, creada, turnos[], tokens }`, o 404 si no existe |
| `GET` | `/api/health` | `{ ok, provider, model }`, sin claves |
| `POST` | `/api/reset` | Borra `out/` y las sesiones; el buzón vuelve a tener los 6 mensajes. 409 si hay un turno en curso |

`needsConfirmation` y `pendientes` los calcula el servidor, no el modelo. Otros códigos: 400 (cuerpo inválido), 409 (la sesión ya tiene un turno en curso), 413 (más de 32 kb), 429 (límite de turnos por hora, o pausa por uso fuera de propósito; ambos con `Retry-After`).

## Estructura

```
agent/prompt.md                      comportamiento (system prompt)
src/knowledge/registro-contratos.md  conocimiento del proceso (reglas, columnas, convenciones)
src/tools/                           ejecución: herramientas contratos_* y reglas de negocio
src/agent/                           ciclo del agente, confirmación (CA3) y sesiones
src/llm/                             adaptador propio: Anthropic y simulado
src/server.ts                        API HTTP y front estático
src/enfriamiento.ts                  pausa por uso fuera de propósito
scripts/generar-modulo.ts            generador del módulo del bonus
modulo/                              bonus §9.4, generado desde las mismas fuentes
web/                                 chat en HTML y JavaScript plano
demo.ts                              herramientas sin modelo
tests/                               pruebas
fixtures/                            insumos de Periferia (solo lectura)
out/                                 generado en ejecución (no se versiona)
```

Cambiar una regla de negocio toca `src/tools/reglas.ts` o el conocimiento, no el servidor.

## Documentación

- [`SOLUCION.md`](SOLUCION.md): planteamiento de la solución (11 secciones del PRD §9.1).
- [`openspec/`](openspec/): propuesta, especificación, diseño, tareas y la revisión del PRD hecha antes de programar.
- [`modulo/`](modulo/): bonus §9.4, el agente empaquetado y generado desde las mismas fuentes. `npm run modulo` empaqueta las herramientas con esbuild en `modulo/tools/contratos.js` (solo requiere `zod`); las pruebas comparan ese archivo con el regenerado.
