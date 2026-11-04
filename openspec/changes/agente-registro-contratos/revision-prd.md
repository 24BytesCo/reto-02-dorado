# Revisión del PRD antes de programar

**Cuándo:** minuto 0 a 15 de la sesión, antes de escribir código.
**Cómo:** cuatro revisiones independientes del PRD y de los fixtures, cada una con un enfoque distinto, y una síntesis que las fusiona y resuelve sus contradicciones contra el texto del PRD:

| Revisión | Enfoque |
|---|---|
| Literal | Toda obligación del PRD («debe», «obligatorio», nombres, rutas, formatos) |
| Valores esperados | El resultado de cada mensaje calculado a mano desde los fixtures |
| Adversaria | Lo que un evaluador exigente probaría y lo que suele pasarse por alto |
| Entrega y defensa | Link, README, seguridad, costo, SOLUCION.md y bonus |

Se hizo con agentes de IA (ver `SOLUCION.md`, sección de uso de IA). Las decisiones finales sobre las ambigüedades son mías y quedaron reflejadas en `design.md`, `specs/` y `tasks.md`.

**Decisiones tomadas sobre los puntos que la síntesis dejó en duda:**
- Póliza del contrato marco (msg-006): `requiere_poliza = false`, `no_aplica`, con advertencia de que cada orden de servicio mayor a COP 100.000.000 exige póliza de cumplimiento.
- `fecha_registro`: la fecha de recepción del correo, para que la demo sea determinista y coherente con `hoy = 2026-09-03`.
- Otrosí con garantías que «deberán ampliarse»: `estado_poliza` pasa a `pendiente`.
- `fecha_inicio` de msg-006 sin día: fuera de `requiere_revision` (el §7.4 enumera solo valor y fecha_fin), explicado en la advertencia de la pregunta.

---


Verifiqué todo contra el PRD y los 6 fixtures. Hay cuatro datos medidos a mano:

- El objeto de msg-006 mide **222** caracteres y hay que recortarlo.
- El objeto de msg-002 mide **200** exactos, así que pasa.
- Bun no está en el PATH de esta máquina: la demo se prueba también con Bun, invocándolo por su ruta.
- `.git` ya existe en el repo.

Prioridad: **C** = crítica, **A** = alta, **M** = media, **B** = baja.

---

## 1. Checklist por fases

### Fase 0: estructura y plan

- [ ] **C**: Consultar a Periferia por la rúbrica. El §0 remite a la "rúbrica de la sección 10", pero §10 trata de riesgos. Mientras no responda, se puntúa contra §5, §6, §8 y §9. Hay que declararlo en SOLUCION §8. (§0, §10)
- [ ] **C**: Estructura del repo según §6.5: `agent/prompt.md`, `src/server.ts`, `src/llm/adapter.ts`, `src/llm/anthropic.ts`, `src/tools/contratos.ts`, `src/knowledge/registro-contratos.md`, `web/`, `demo.ts`, `.env.example`, `README.md` y `SOLUCION.md`. (§6.5)
- [ ] **C**: El esqueleto de SOLUCION.md se crea en el **minuto 0**, con los 11 títulos numerados en el orden exacto. Supuestos y trade-offs se van llenando mientras se programa. (§9.1)
- [ ] **A**: Plan de tiempo:
  - 0–45 min: herramientas, `demo.ts` y tests de los 6 casos.
  - 45–75 min: adaptador, ciclo y CA3 en código.
  - 75–90 min: front mínimo y despliegue **temprano**.
  - 90–110 min: README y SOLUCION.
  - 110–120 min: reset, ensayo y commit.
  - Orden de sacrificio: `modulo/`, `leer_pdf`, streaming real, estética, docker.
  - **Nunca** se sacrifican la demo, el link, CA3, `log.jsonl` ni SOLUCION. (§0, §9.3, §9.4)
- [ ] **A**: `package.json` hoy tiene `"scripts": {}` y falta `tsconfig.json`. Agregar los scripts `dev`, `start`, `demo`, `typecheck` y `test`, y un tsconfig con `strict` y `noImplicitAny`. TypeScript 7 (tsgo) viene instalado: si da problemas, fijar la 5.x. (§8 Arranque y Legibilidad)
- [ ] **A**: Commits pequeños por hito: herramientas, demo, adaptador, ciclo, front, despliegue, docs. Un solo commit gigante parece código volcado. Verificar que `.gitignore` cubre `node_modules/`, `out/` y `.env`. **El `.env` con la clave real está en la raíz.** (§9.5)
- [ ] **M**: Constantes de negocio en `src/tools/reglas.ts`, nunca en `server.ts`: umbral 0.8, 60 días, corte 2026-05-30 y similitud 0.9. (§6.5 "un cambio de reglas no toca el servidor")

### Fase 1: herramientas zod con pruebas

**Contrato de forma** (§6.2)
- [ ] **C**: Exports `leer_buzon`, `extraer`, `validar`, `registrar` y `alertas` en `contratos.ts`. El nombre `contratos_<export>` se genera en código (`Object.entries`), no se escribe a mano. (§6.2)
- [ ] **C**: `args` es un **objeto de esquemas** zod (no un `z.object`). `.describe()` va en **cada** campo, también dentro de `contrato`. Un test falla si falta algún `.describe()`. (§6.2)
- [ ] **C**: `execute(args, ctx:{directory, sessionId})` devuelve un **string** JSON `{ok:true,data}` o `{ok:false,error}` y **nunca lanza**. Va envuelto en un try/catch genérico. (§6.2)
- [ ] **C**: Un único wrapper `ejecutarHerramienta` dentro del módulo de herramientas, usado por el servidor **y** por la demo. Hace cuatro cosas: valida con zod, ejecuta, escribe `out/log.jsonl` `{ts, herramienta, mensaje_id, ok, resumen}` en **todos** los casos (también fallos de validación) y devuelve el string. (§7.3 RN7, CA4)
- [ ] **C**: Rutas solo desde `ctx.directory`, nunca absolutas. `mensaje_id` se valida con `^msg-\d{3}$` y contra el listado real del buzón (para evitar path traversal hacia `../../.env`). El slug admite solo `[a-z0-9-]`. Test con `'../../.env'` que espera `ok:false`. (§6.2, §8 Seguridad)
- [ ] **A**: Cero `child_process`, `exec`, `spawn` y `eval` (comprobar con grep). (§8 Seguridad)
- [ ] **A**: Todo JSON externo pasa por zod: `correo.json`, `comerciales.json` y el body de la API. Sin `any`. (§8 Legibilidad, §7.1)
- [ ] **M**: `BUZON_DIR` y `OUT_DIR` configurables por variable de entorno. Sirve para probar un msg-007 en vivo sin tocar los fixtures, y para que la demo no borre el `out/` del servidor desplegado. (§5 HU-6, §8)

**HU-1 `leer_buzon`**
- [ ] **C**: Lista los mensajes que no están en `out/procesados.json` (tolera que el archivo no exista). Cada uno lleva exactamente `{id, de, asunto, fecha, adjuntos[], tiene_contrato}` dentro de `data.mensajes[]`. (§5 HU-1, §6.2)
- [ ] **C**: `tiene_contrato` se decide por el **contenido** del adjunto (encabezado CONTRATO, CONTRATO MARCO u OTROSÍ, con partes y objeto), **no por el nombre**. msg-003 trae `otrosi.txt` y msg-005 trae `cotizacion.txt`. (§5 HU-1, §7.4)
- [ ] **A**: Si `tiene_contrato:false`, el ítem incluye `clasificacion:"rechazado"` y `motivo` (msg-005: "cotización COT-2026-088, no hay contrato"). (§5 HU-1, RN4)

**HU-2 `extraer`**
- [ ] **C**: Extracción determinista (regex y heurísticas), con `confianza` por campo en [0,1]. Un campo ausente es `null` con confianza 0, **nunca inventado**. (§5 HU-2)
- [ ] **C**: El tipo `Contrato` incluye las 16 columnas, `valor_indeterminado` y `confianza`. (§7.2)
- [ ] **C**: El id se extrae con `[A-Z]{2,3}-\d{4}-\d{2,3}`, que cubre `CM-2026-03`. En un otrosí se toma de "AL CONTRATO … No. X", **no** el "No. 1". Si no hay id, `AUTO-<año>-<secuencia>`. (§7.2)
- [ ] **C**: El parser de montos detecta el formato. Colombiano: `265.000.000` → 265000000. Estadounidense: `120,000.00` → 120000 y `520,000.00` → 520000. El valor se toma **de la cláusula VALOR** (no del umbral de póliza de msg-006 ni del NIT). (§7.2 valor)
- [ ] **C**: Fechas en español con numeral entre paréntesis ("primero (1) de agosto de 2026"), tomadas **solo de la cláusula PLAZO** (ignorar la fecha de firma y la de "suscrito el"). Hay que validar que la fecha exista: 31 de febrero → `ok:false`. (§7.2, HU-6)
- [ ] **C**: `fecha_fin` puede derivarse de un plazo en meses, con confianza < 0.8. Suma de meses con `Date.UTC` sobre YYYY-MM-DD y ajuste a fin de mes. **Sin `new Date()` local.** (§7.2, §8 Determinismo)
- [ ] **C**: NIT del **CONTRATANTE**: hay que excluir el de Periferia, 900.123.456-7, que aparece en todos los contratos. El DV se quita **solo** con el patrón colombiano `ddd.ddd.ddd-d`. Los RUC de Ecuador (13 dígitos) y Perú (11) y el RTN de Honduras quedan intactos. **No validar el DV**: los del fixture son ficticios. NIT siempre como string. (§7.2 nit_cliente)
- [ ] **A**: País por identificador o por texto: NIT → CO; RUC de 13 dígitos terminado en 001 → EC; RUC de 11 → PE. Moneda por código o palabra (M/CTE, DÓLARES, SOLES). Una moneda desconocida (EUR) da `ok:false`. (§7.2, HU-6)
- [ ] **A**: Cliente canónico: si el NIT ya está en el maestro, se usa la grafía del maestro. Si no, title-case conservando el sufijo societario. Las comparaciones ignoran mayúsculas y tildes. (§7.2, §10)
- [ ] **A**: Objeto de 200 caracteres como máximo, recortado sin partir palabras y sin bajar la confianza (msg-006 mide 222). (§7.2)
- [ ] **A**: Póliza desde la cláusula GARANTÍAS: `requiere_poliza`, `tipo_poliza` separado por `;` y, si es nuevo con póliza, `estado_poliza=pendiente`. Si no hay cláusula, `false`, vacío y `no_aplica` **con confianza alta** (una ausencia coherente no bloquea). (§7.2)
- [ ] **A**: El resultado al modelo va compacto, **sin** el texto completo del contrato (costo). (§8 Costo)
- [ ] **C** (HU-6): Texto vacío, fecha inválida o moneda desconocida devuelven `{ok:false, error}` en español claro. Test con un buzón temporal. (§5 HU-6)

**HU-3 `validar`**
- [ ] **C**: Orden fijo de reglas: **RN4** (rechazado) → **RN1** (mismo id **y** mismos valor, fecha_inicio y fecha_fin = duplicado) → **RN2** (mismo id, u otrosí, o mismo NIT **y** similitud de objeto ≥ 0.9 = actualización) → **RN3** (nuevo). (§7.3)
- [ ] **C**: **Nunca deduplicar solo por NIT.** msg-001, msg-002 y msg-006 comparten NIT con CT-2025-018, CT-2026-007 y CT-2026-002, y son **nuevos**. Similitud determinista (Jaccard o Dice de tokens sin tildes ni stopwords), con su valor en el resultado. (§7.3 RN2/RN3, §10)
- [ ] **C**: Salida `{clasificacion, id_contrato_existente?, requiere_revision[], diferencias?, advertencias[]}` con el enum exacto `nuevo|actualizacion|duplicado|rechazado`, sin tilde. (§6.2, HU-3)
- [ ] **C**: Los cambios de un otrosí van en `diferencias`, **no** en `requiere_revision`. "Conflicto" se reserva para choques de identidad, por ejemplo el mismo id con otro NIT u otra moneda. (§5 HU-3 contra §7.4 msg-003)
- [ ] **C**: En una actualización, los campos `null` del otrosí heredan de la fila existente y **no cuentan** para `requiere_revision`. (§7.3 RN2, HU-2)
- [ ] **C**: Remitente desconocido: va a `advertencias[]`, **no bloquea** y `comercial` queda vacío. (§5 HU-3)
- [ ] **C**: El umbral es `< 0.8` estricto (0.8 pasa), en una sola función compartida por `validar` y `registrar`. (RN5, O3)

**HU-4 `registrar`**
- [ ] **C**: Revalida por dentro: no confía en la clasificación ni en los valores que trae el modelo. Solo escribe si `requiere_revision` está vacío o hay `confirmado=true`. Si no, devuelve `{ok:false, error:"requiere revisión: valor, fecha_fin"}`. (HU-4, RN5)
- [ ] **C**: **CA2 en código.** Compara el `contrato` recibido contra la extracción guardada de ese `mensaje_id`. Solo acepta valores distintos en los campos que estaban en `requiere_revision` y vienen confirmados. El resto devuelve error. Las correcciones humanas vuelven a pasar por `validar`. (CA2, HU-2, §10)
- [ ] **C**: RN6: copia el fixture a `out/sharepoint/maestro-contratos.csv` **solo si no existe** (el arranque del servidor no reinicia el estado). Test de hash: el fixture no cambia. (RN6)
- [ ] **C**: CSV según RFC 4180, con comillas cuando hay comas (el objeto de msg-001 las tiene) y todo leído como string (el `08019995123456` de Honduras conserva el 0). Mismo orden de las 16 columnas, booleanos `true`/`false`, UTF-8 sin BOM y LF. Test: leer y escribir el fixture sin cambios da el mismo archivo **byte a byte**. Escritura atómica (temporal y rename) y una cola o mutex, porque el link es público. Neutralizar celdas que empiecen por `= + - @`. (§7.2, O2)
- [ ] **C**: Archivo en `Contratos/<año_inicio>/<slug>/<id>.<ext>`, con la extensión del adjunto (.txt). El slug se arma con NFD, sin tildes, sin S.A.S./S.A./S.A.C./S. de R.L., en kebab-case. Se prueba contra las 8 rutas del maestro. (HU-4, §7.2)
- [ ] **C**: `historial.jsonl` `{ts, id_contrato, accion, cambios:{campo:{antes,despues}}, mensaje_id}`: una línea por cada nuevo o actualización. (HU-4, O2)
- [ ] **C**: `procesados.json` marca registrados, **duplicados y rechazados**. msg-006 queda sin marcar hasta que se confirme. (HU-1, HU-4)
- [ ] **A**: Salida `{id_contrato, accion, ruta_archivo}`. Una segunda llamada sobre msg-001 da duplicado y no escribe (idempotencia). (§6.2, O2)

**HU-5 `alertas`**
- [ ] **C**: `hoy` llega por argumento (zod regex y validación de fecha real). **Prohibido `Date.now()`.** El reloj del equipo de desarrollo marca 2026-11-03, no la fecha del escenario. (HU-5)
- [ ] **C**: Tres secciones con estos títulos literales: "Vencen en ≤ 60 días", "Pólizas pendientes (requiere_poliza = true y estado_poliza != vigente)" y "Registrados desde el 2026-05-30 (gap cubierto)". Salida `{ruta, vencen[], polizas_pendientes[], registrados_desde_corte[]}`, con `dias_restantes` ya calculado. (HU-5, §6.2)
- [ ] **A**: La ventana es 0 ≤ días ≤ 60. Los ya vencidos van como **subsección dentro de la sección 1** ("Vencidos sin renovación registrada"), no como cuarta sección ni dentro de `vencen[]`. (HU-5, O4)
- [ ] **A**: Lee el maestro de `out/`, nunca el del fixture. (RN6)

**`demo.ts`**
- [ ] **C**: En este orden: `rm out/`, copia del maestro, `leer_buzon`, y para cada mensaje 001–006 `extraer` → `validar` → `registrar` si procede. Imprime por mensaje la clasificación, los campos en revisión y la acción. (§6.6)
- [ ] **C**: msg-006: primero `registrar` sin confirmar (rechazo visible), después **una segunda llamada con `confirmado:true`** (valor 0, fecha_fin 2027-08-31) y al final `alertas({hoy:"2026-09-03"})`. (§6.6)
- [ ] **C**: Corre sin clave. `src/tools` no importa nada de `llm/` ni del servidor. Probar con `env -u ANTHROPIC_API_KEY npm run demo` y **también con Bun** (instalarlo en el scratchpad). Correrlo dos veces y comparar con diff ignorando `ts`. (§6.6, §8 Determinismo)
- [ ] **C**: Test de aceptación que falla si no se cumple la tabla de la sección 2: maestro con 11 filas, historial con 4 líneas, CSV sin cambios tras msg-004. (§7.4, O1, O2)

### Fase 2: agente

**Adaptador LLM**
- [ ] **C**: `src/llm/adapter.ts` con tipos propios (`Mensaje`, `LlamadaHerramienta`, `Respuesta{texto, llamadas[], uso}`) y `enviar(mensajes, herramientas)`. `anthropic.ts` es el **único** archivo que importa el SDK. El ciclo no ve `tool_use` ni `tool_result`. (§6.1, §6.5)
- [ ] **A**: `simulado.ts` (guionizado) para probar el ciclo y CA5 sin clave, y para mostrar en la defensa el cambio de proveedor con una variable de entorno. (§6.1)
- [ ] **C**: Timeout configurable (`LLM_TIMEOUT_MS`), `maxRetries=1` y errores traducidos (401, 429, 529, timeout, red) a mensajes en español. **Nunca serializar el objeto `err` ni el cliente.** Redactor `/sk-ant-[\w-]+/` sobre todo lo que sale. (§8 Robustez y Seguridad, CA5)
- [ ] **A**: Verificar el ID de modelo con una llamada real. El costo por caso se calcula con el `usage` medido y la tarifa vigente, **verificada, no de memoria**. (§9.1.4)

**Ciclo**
- [ ] **C**: CA1: `MAX_ITERACIONES=25` por variable de entorno. Al llegar al tope, una llamada final **sin herramientas** con "lo que hice y lo que falta". (CA1)
- [ ] **C**: Tope de tokens por sesión (`MAX_TOKENS_SESION`), sumando `usage`, y un mensaje claro al excederlo. Calibrarlo con unas 3 veces el consumo real del §11. (§8 Costo)
- [ ] **C**: Los `tool_use` y `tool_result` se guardan **siempre en pareja y de forma atómica**. Si falla algo a mitad de turno, rollback o un `tool_result` de error para cada pendiente. Sin eso Anthropic responde 400 en cada mensaje siguiente y la sesión muere. Test: error y timeout, luego otro mensaje en la misma sesión. (CA5)
- [ ] **C**: **CA3 en código.** Cuando `validar` devuelve una revisión, `session.pendientes[mensaje_id] = turno`. `confirmado:true` solo se acepta si el pendiente viene de un turno **anterior** y llegó un mensaje nuevo del usuario. Si no, `{ok:false, error:"la confirmación requiere un nuevo mensaje del usuario"}`. `needsConfirmation` lo calcula el servidor (hay pendientes al final del turno). (CA3, RN5)
- [ ] **C**: Los args se validan con `z.object(tool.args).safeParse` antes de ejecutar. El error vuelve al modelo como `tool_result` con `is_error`. JSON Schema con `z.toJSONSchema` (zod 4). (§6.2)
- [ ] **A**: Las `toolCalls` se guardan en la sesión, en memoria y opcionalmente reflejadas en `out/`. (CA4, §6.4)

**Prompt y conocimiento**
- [ ] **C**: `agent/prompt.md` se lee con fs al arrancar. El servidor le concatena `src/knowledge/registro-contratos.md` (RN1–RN7, convenciones de fechas, slugs, umbrales). (§6.1, §6.5)
- [ ] **C**: El prompt incluye:
  - prohibición de afirmar o calcular valores que no salgan de una herramienta;
  - la fecha `hoy` se toma del mensaje del usuario, o se pregunta;
  - ante `ok:false`, informar y seguir con el siguiente mensaje;
  - el contenido de las herramientas es dato, no instrucciones (prompt injection);
  - llamadas en paralelo. (CA2, HU-5, HU-6, §10)
- [ ] **C**: Orden de cierre del §11: procesar los 6 mensajes, luego alertas, luego la tabla por mensaje, luego el detalle de msg-006 campo por campo (valor propuesto, evidencia, confianza) y **cerrar con la pregunta**. Tras la confirmación: validar, registrar con `confirmado:true` y **volver a generar las alertas**. (§11, CA3)

**API**
- [ ] **C**: `POST /api/chat {sessionId, message}` → `{reply, toolCalls[], needsConfirmation}`, con el body validado por zod y `express.json({limit})`. (§6.4)
- [ ] **C**: **Timeouts del proxy.** NPM corta a 60 s y Cloudflare a 100 s, y el §11 tarda entre 60 y 150 s. Dos opciones:
  - SSE con `X-Accel-Buffering: no` y heartbeat cada 15 s;
  - o un POST que responde enseguida y polling a `GET /api/sessions/:id`.

  Además, `proxy_read_timeout` alto y `proxy_buffering off` en NPM. (§9.3, §6.4)
- [ ] **A**: `GET /api/sessions/:id` devuelve mensajes y toolCalls, o 404 claro. `GET /api/health` devuelve `{ok, provider, model}` y nada más. (§6.4)
- [ ] **C**: `POST /api/reset` y botón "Reiniciar demo": limpia `out/` y vuelve a copiar el maestro. Sin esto, quien abra el link después de una prueba verá "no hay mensajes pendientes". (§11, HU-1)
- [ ] **A**: Límite por IP y por sesión, tamaño máximo de mensaje y límite de gasto en la consola de Anthropic. (§8 Costo)

**Front (HTML plano)**
- [ ] **C**: Historial, campo de entrada e indicador de "pensando…". (§6.1)
- [ ] **C**: Una tarjeta `<details>` por **cada** tool call: nombre, args en JSON, ok y resumen. (§6.1, CA4)
- [ ] **C**: Banner o borde de color cuando `needsConfirmation=true`. (§6.1, CA3)
- [ ] **A**: Errores del proveedor en lenguaje claro dentro del chat. `sessionId` en localStorage con try/catch. Al recargar se reconstruye desde GET. Funciona en móvil. Ninguna clave ni lógica en el front. (CA5, §8)

### Fase 3: entrega

**Despliegue en https://nuevo.24bytes.pro**
- [ ] **C**: Desplegar **en los primeros 90 min**, no al final. La cadena:
  1. compose **sin `ports:`**, con la red `proxy-net` y `restart: unless-stopped`;
  2. Proxy Host en NPM apuntando a `contenedor:puerto`, con Let's Encrypt;
  3. ingress en cloudflared hacia `https://localhost:443` con `noTLSVerify` y `originServerName`.

  Preferir Contabo antes que el portátil (que se reinicia a las 05:00). El dominio ya tiene túnel y proxy configurados, así que no hace falta tocar DNS ni túnel. Se pierden 10 puntos si no hay link. (§9.3, CLAUDE.md)
- [ ] **C**: Probar **desde fuera** (celular con datos) `/api/health` y el prompt del §11 **completo** con la confirmación. Después, reset y no tocar nada. (§9.3, §11)
- [ ] **A**: `TZ=America/Bogota` en el contenedor. Aun así, ninguna lógica de fechas usa el reloj. (§8 Determinismo)
- [ ] **A**: Healthcheck en el compose. Volver a probar el link 10 min antes de la defensa. Plan B: local con túnel (-10). (§9.3)

**README**
- [ ] **C**: Las 5 piezas:
  - un comando (`cp .env.example .env && npm install && npm run dev`);
  - las variables;
  - cómo correr la demo (`npm run demo`, y que `bun run demo.ts` también funciona);
  - el link;
  - "sin clave de acceso" (o la clave, si se protege).

  Más una tabla de la API, con reset incluido. (§9.2, §6.4)
- [ ] **C**: `.env.example` lista **todas** las variables sin valores ni `sk-ant-xxx`: `ANTHROPIC_API_KEY`, `LLM_PROVIDER`, `MODEL`, `PORT`, `MAX_ITERACIONES`, `MAX_TOKENS_SESION`, `LLM_TIMEOUT_MS`, `BUZON_DIR`, `OUT_DIR` y el límite de tasa. (§6.5, §8)
- [ ] **A**: Probar desde un clon limpio, cronometrado, en menos de 2 min. (§8 Arranque)

**SOLUCION.md (11 secciones en orden)** (§9.1)
- [ ] **A** §1: Problema en una frase. Le duele a la analista y a gerencia: maestro congelado desde 2026-05-30 y dependencia de una persona.
- [ ] **A** §2: Diagrama front → backend → herramientas → archivos, con las rutas de prompt, conocimiento y ejecución.
- [ ] **A** §3: Bucle, el tope de 25 iteraciones, la confirmación en código y el manejo de errores sin matar la sesión.
- [ ] **A** §4: Proveedor y modelo, por qué, y costo por caso medido con `usage` (marcado como estimación).
- [ ] **A** §5: Tabla campo → método → regla de confianza: explícito 0.95; derivado 0.5–0.75; ausente 0. Explicar dónde entra el modelo (proponer y conversar) y dónde no (valores, clasificación, escritura).
- [ ] **C** §6: Regla de gobierno en una página con los 6 puntos del §7.5:
  1. `contratos@periferia-ficticia.com`, administrado por la analista administrativa, que es **dueña del maestro** (responde la pregunta abierta del §10).
  2. El comercial envía PDF firmado, otrosíes y actas de terminación en 2 días hábiles, con asunto `[CONTRATO|OTROSI|TERMINACION] Cliente – No.`.
  3. Acuse con resultado (registrado, duplicado o en revisión) en menos de 1 h.
  4. Contratos sin firma o sin valor van a la cola de revisión; si no se resuelven en 5 días, se escala a gerencia comercial.
  5. Campaña única para junio–agosto: solicitud a los comerciales, cruzada con facturación, con fecha límite.
  6. Indicador: % de contratos facturados que existen en el maestro.

  Evidencia: msg-006 (practicante sin registrar, contrato sin valor). (§7.5, §10)
- [ ] **A** §7: Al menos 3 trade-offs: extracción determinista frente a solo LLM; CA3 en código frente a prompt; CSV frente a SQLite; estado global de `out/` frente a estado por sesión; polling o SSE frente a POST que bloquea. Incluir la justificación de dependencias (express, zod, SDK, tsx). (§9.1.7, §8 Dependencias)
- [ ] **A** §8: Todos los supuestos de la sección 3 de este documento.
- [ ] **A** §9: Tabla HU-1…HU-6 con estado honesto y lo que falta para producción.
- [ ] **A** §10: Claude Code y subagentes, tareas concretas y **al menos 3 descartes reales**: dedupe solo por NIT, dejar que el modelo pase `confirmado`, `pdftotext` con shell, base de datos, dependencias extra. (§0, §9.1.10)
- [ ] **M** §11: OCR, falsos duplicados, redondeo del LLM, concurrencia sobre el CSV, prompt injection, costo, datos reales en un proveedor externo. Cada uno con su mitigación.

**Entrega**
- [ ] **C**: `git ls-files` sin `.env`, `out/` ni `node_modules/`. Además `git log -p | grep -c sk-ant` = 0. Si va en zip: `git archive -o reto-02-dorado.zip HEAD` y revisar con `unzip -l`. (§9.5)
- [ ] **A**: Greps finales: `: any|as any`, `child_process`, `sk-ant`, `msg-00` (no puede haber nada hardcodeado por fixture) y `.describe` en cada campo. Más `tsc --noEmit` y los tests. (§8, §0)
- [ ] **A**: Leer el código de punta a punta para poder explicar cada línea. (§0)

**Bonus `modulo/` (solo si sobran unos 15 min)** (§9.4)
- [ ] **M**: `modulo/tools/contratos.ts` con el código real, y `src/tools/contratos.ts` que hace `export *` de él (o al revés). Así es **un solo archivo**.
- [ ] **M**: `agent.md` con frontmatter `description`, `mode: primary` y `permission: {edit: deny, bash: deny}`; el cuerpo es `agent/prompt.md`. `skill/registro-contratos/SKILL.md` con frontmatter `name: registro-contratos` y `description`; el cuerpo es el knowledge. Ambos los genera un script. Un check (en predev y en los tests) falla si se separan de la fuente.

---

## 2. Resultado esperado (verificado contra los fixtures)

| Msg | Clasificación | requiere_revision | Acción | Valores clave |
|---|---|---|---|---|
| **001** | `nuevo` | `[]` | Inserta, copia el archivo, historial `nuevo`, procesado | CT-2026-015 · Industrias Delta S.A.S. · 890900111 · CO · 265000000 COP · 2026-08-01 → 2027-07-31 · `true` / `cumplimiento` / `pendiente` · Laura Gómez Restrepo · `Contratos/2026/industrias-delta/CT-2026-015.txt` · registro 2026-08-04 · buzon. Comparte NIT con CT-2025-018 (SAP), pero el objeto es otro. |
| **002** | `nuevo` | `[]` | Inserta, copia, historial, procesado | CT-2026-016 · Corporación Andina de Servicios S.A. · 1790012345001 (sin recortar) · EC · **120000** USD · 2026-08-15 → 2027-08-14 · `false` / vacío / `no_aplica` · Carlos Ruiz Medina · `Contratos/2026/corporacion-andina-de-servicios/CT-2026-016.txt` · registro 2026-08-18. Objeto de 200 caracteres exactos. Comparte RUC con CT-2026-007. |
| **003** | `actualizacion` (otrosí) | `[]` | Modifica la fila, historial con cambios, archiva el otrosí, procesado | CT-2026-011. `diferencias`: valor 350000 → **520000** PEN · fecha_fin 2027-05-01 → **2027-11-01** · estado_poliza vigente → pendiente (supuesto S3). El resto se hereda: fecha_inicio 2026-05-02, ruta `.pdf` original, registro 2026-05-05. Archivo: `Contratos/2026/minera-los-andes/CT-2026-011-otrosi-1.txt`. |
| **004** | `duplicado` | `[]` | **Ni maestro, ni historial, ni archivo.** Solo log y procesados | CT-2026-012 · 210000000 COP · 2026-05-15 → 2026-11-14 coinciden (RN1). El objeto y las mayúsculas difieren, pero se ignoran. |
| **005** | `rechazado`, `tiene_contrato:false` | n/a | Nada salvo log y procesados | Motivo: "cotización COT-2026-088, no es contrato (sin partes ni objeto contractual)". No se empareja con CT-2026-006. |
| **006** | `nuevo` | **`["valor","fecha_fin"]`** | 1.ª pasada: **no registra** (`requiere revisión: valor, fecha_fin`). 2.ª pasada, con `confirmado:true`: inserta, historial, procesado | CM-2026-03 · Distribuidora Caribe S.A.S. · 800222333 · CO · valor **0**, `valor_indeterminado:true` (0.5) · COP (0.85) · inicio 2026-08-31 (S1) · fin **2027-08-31** (0.5) · `false` / vacío / `no_aplica` (S4) · comercial vacío + advertencia "jperez@ no registrado" · objeto recortado de 222 a ≤200 · `Contratos/2026/distribuidora-caribe/CM-2026-03.txt` · registro 2026-08-31. |

**Estado final:** maestro con **11 filas** (8 + 3), `historial.jsonl` con **4 líneas** (001, 002, 003 y 006), `procesados.json` con los 6.

**`alertas.md` con hoy = 2026-09-03** (después de confirmar msg-006; el límite es 2026-11-02):

| Sección | Contenido |
|---|---|
| 1. Vencen en ≤ 60 días | **CT-2026-009** Agroexport Sula, 2026-09-30, **27 días**, Carlos Ruiz. **CT-2026-004** Logística del Istmo, 2026-10-15, **42 días**, Carlos Ruiz. Fuera: CT-2026-012 (72 días). *Subsección "Vencidos sin renovación registrada":* CT-2025-018 (2026-06-30, −65 días, con póliza todavía "vigente") y CT-2026-002 (2026-07-09, −56 días). |
| 2. Pólizas pendientes | **CT-2026-004** (cumplimiento;calidad, pendiente desde enero, la más grave), **CT-2026-011** (ampliación por el otrosí, según S3) y **CT-2026-015** (cumplimiento 20 %). Si no se adopta S3, salen solo 004 y 015. |
| 3. Registrados desde 2026-05-30 | **CT-2026-015** (2026-08-04), **CT-2026-016** (2026-08-18), **CM-2026-03** (2026-08-31). Nota informativa: CT-2026-011 se actualizó por otrosí (msg-003), pero conserva su registro del 2026-05-05. |

---

## 3. Ambigüedades y decisión recomendada (para SOLUCION §8)

| # | Ambigüedad | Decisión |
|---|---|---|
| S1 | msg-006 dice "se firma en el mes de agosto de 2026", sin día. El §11 confirma fin 2027-08-31, mientras msg-002 y msg-004 usan la convención inicio + N meses − 1 día. (§7.2, §7.4, §11) | fecha_inicio = 2026-08-31: es la cota superior (el correo es del 31) y coincide con lo que confirma el evaluador. fecha_fin = inicio + 12 meses = 2027-08-31, con confianza 0.5. **Duda:** ¿fecha_inicio entra en revisión? Recomiendo **no**, para respetar la lista literal `[valor, fecha_fin]` del §7.4. Así "confirmo valor 0 y fecha fin 2027-08-31" lo cubre todo. La incertidumbre del inicio se explica dentro de la pregunta sobre fecha_fin y en `advertencias`. Hay que declarar la inconsistencia con la convención −1 día. |
| S2 | La moneda de msg-006 no está en la cláusula VALOR. (§7.2) | COP con confianza 0.85: aparece en la cláusula CUARTA, el NIT es colombiano y el domicilio es Barranquilla. No bloquea, pero se menciona en la pregunta. |
| S3 | ¿estado_poliza tras el otrosí? La cláusula TERCERA pide "ampliarse en vigencia". (§7.2, §7.4, O4) | Pasa a `pendiente` por regla determinista (otrosí que extiende plazo o valor sobre un contrato con póliza). Va en `diferencias` y en el historial, sin pedir confirmación. **Duda:** el §7.4 solo menciona fecha_fin. Es un cambio de una línea si el evaluador lo objeta. |
| S4 | msg-006 tiene póliza condicional (10 % para órdenes de más de COP 100 M). Las revisiones se contradicen: una dice `true`/`pendiente`, otra `false`. (§7.2) | `requiere_poliza=false`, `no_aplica`, y la condición anotada en el historial y en el chat. Razones: el contrato marco en sí no exige póliza, y `true` dejaría una alerta imposible de cerrar mientras no haya orden. Hay que defenderlo en la defensa. |
| S5 | "Conflictos con el maestro" (HU-3) frente a que el otrosí se registre solo (§7.4). | Conflicto = choque de identidad (mismo id con otro NIT u otra moneda). Un cambio de otrosí = `diferencias`. |
| S6 | RN2 dice "algún campo distinto" y msg-004 tiene objeto y mayúsculas distintos. (§7.3) | RN1 va antes que RN2 y compara solo id, valor y fechas. |
| S7 | §10 dice "dedupe por NIT". (§10, RN2) | Se interpreta como "NIT primero, **nunca NIT solo**". RN2 exige el mismo NIT **y** objeto ≥ 0.9. El NIT se usa para el nombre canónico y el slug. |
| S8 | Métrica de similitud ≥ 0.9 no definida. (RN2) | Jaccard de tokens normalizados (sin tildes ni stopwords), con test. |
| S9 | fecha_registro: ¿reloj o fecha del correo? (§7.2, §8) | Fecha del campo `fecha` del correo. Es determinista y siempre ≥ corte. El reloj solo va en los `ts`. |
| S10 | Duplicado: "no se escribe nada" frente a procesados.json. (RN1, HU-1) | "Nada" se refiere al maestro, al historial y a SharePoint. Duplicados y rechazados **sí** se marcan en procesados y en el log; si no, reaparecen siempre. |
| S11 | Ruta del otrosí: `<id>.<ext>` pisaría el contrato original. (HU-4) | Se archiva como `CT-2026-011-otrosi-1.txt` y la fila conserva su ruta. El archivo queda anotado en el historial. |
| S12 | Extensión .txt frente a .pdf en el maestro. (HU-4, §3.2) | Extensión real del adjunto (.txt). |
| S13 | Remitente desconocido y la columna `comercial`. (HU-3, §7.2) | `comercial` vacío y advertencia ("sugerido: Laura Gómez por CT-2026-002, confirmar"). No se inventa. |
| S14 | Contratos ya vencidos en alertas. (HU-5) | Ventana 0–60 días. Los vencidos van en una subsección de la sección 1, fuera de `vencen[]`. |
| S15 | Rúbrica de "la sección 10" inexistente. (§0) | Se declara y se asume que puntúan §5, §6, §8 y §9. |
| S16 | `bun install && bun run demo.ts` frente a Node + tsx. (§6.6) | Node 22 + tsx (el §0 lo admite). Se documentan los dos comandos y se **prueba con Bun**. |
| S17 | `out/` global en un link público. (§3.2) | Estado global (no hay multiusuario) más `/api/reset`. Se declara. |
| S18 | Objeto de más de 200 caracteres (msg-006). (§7.2) | Recorte sin partir palabras, sin bajar la confianza. |

---

## 4. Riesgos de reprobación detectados y cómo los evitamos

1. **Deduplicar por NIT** (siguiendo literalmente el §10). msg-001, msg-002 y msg-006 salen como `actualizacion` y pisan CT-2025-018, CT-2026-007 y CT-2026-002: fallan 3 de 6 casos y se corrompe el maestro. **Cómo lo evitamos:** NIT **y** objeto ≥ 0.9, con tests de los 3 pares.
2. **El otrosí se bloquea o borra datos.** Se detecta por el nombre "contrato.txt", se toma "No. 1" como id, los campos ausentes (confianza 0) van a revisión, o el merge escribe `null`. **Cómo lo evitamos:** detección por contenido, id de "AL CONTRATO No.", merge sin nulos y cambios en `diferencias`.
3. **CA3 solo en el prompt.** En el mismo turno el modelo registra msg-006 con `confirmado:true` porque el usuario dijo "registra lo limpio". **Cómo lo evitamos:** gate en el servidor por turno y `needsConfirmation` calculado en código.
4. **El link muere en la demo.** El §11 tarda 60–150 s, NPM corta a 60 s (504) y Cloudflare a 100 s (524). O el buzón ya estaba procesado. **Cómo lo evitamos:** SSE o polling, timeouts en NPM, `/api/reset` y la prueba completa desde fuera.
5. **La sesión muere** por un `tool_use` sin `tool_result` (Anthropic responde 400 desde ese momento). **Cómo lo evitamos:** escritura en pareja y atómica, y rollback.
6. **Montos y fechas mal parseados.** `USD 120,000.00` se lee como 120 o como 12 000 000; se toma una fecha de firma en lugar de la del plazo; se toma el NIT de Periferia. **Cómo lo evitamos:** detección de formato, solo la cláusula VALOR y PLAZO, y exclusión de 900123456.
7. **La lista de revisión de msg-006 no cuadra.** Entran moneda, fecha_inicio, póliza u objeto, y "confirmo el valor 0 y la fecha fin…" ya no alcanza. O el valor confirmado no llega al CSV. **Cómo lo evitamos:** confianzas fijadas para que solo queden `[valor, fecha_fin]`, y un flujo validar → registrar que acepta las correcciones humanas, probado de punta a punta.
8. **No se cumple la forma que evalúan.** Prompt embebido, args sin `.describe()`, `execute` que lanza o devuelve un objeto, nombres que no son `contratos_*`, demo que pide clave, escritura en `fixtures/`, `any`, adaptador que filtra tipos del SDK. **Cómo lo evitamos:** un checklist de greps y un test de forma por herramienta.
9. **CSV corrupto.** Las comas del objeto de msg-001 desplazan columnas y `08019995123456` pierde el 0. **Cómo lo evitamos:** RFC 4180, todo como string y test de ida y vuelta byte a byte.
10. **No alcanza el tiempo para documentación y entrega.** Falta SOLUCION con 11 secciones y §7.5 de 6 puntos, no hay README de un comando, se cuela `.env`, no hay historial de commits, no se declara la IA, o hay `if (id==='msg-006')`. **Cómo lo evitamos:** esqueleto en el minuto 0, commits por hito, cero datos hardcodeados por fixture (pueden meter un msg-007 en vivo) y verificación final mecánica.

**Extra (determinismo):** `Date.now()` en alertas o en fecha_registro. El reloj real marca 2026-11-03 (no la fecha del escenario) y el contenedor en UTC se adelanta un día a partir de las 19:00 de Bogotá. **Cómo lo evitamos:** `hoy` como argumento, fecha del correo y `Date.UTC`.

---

## 5. Contradicciones entre revisiones (resueltas contra el PRD)

| Tema | Revisiones | Decisión |
|---|---|---|
| fecha_inicio de msg-006 en revisión | "esperados" y "entrega": sí. "adversarial": no. | **No.** El §7.4 enumera literalmente (valor, fecha_fin). Se explica en la pregunta y en las advertencias. **Dudoso:** también es defendible agregarla. |
| Póliza de msg-006 | "adversarial": `true`/`pendiente`. "esperados": `false`. | **`false`/`no_aplica` con nota** (S4). **Dudoso.** |
| fecha_registro | "adversarial": fecha real de ejecución. Los demás: fecha del correo. | **Fecha del correo.** Mantiene la demo determinista (§8). |
| Vencidos en alertas | Cuarta sección, o nota dentro de la sección 1. | **Subsección dentro de la sección 1.** HU-5 exige "tres secciones". |
| comercial desconocido | Vacío, o "NO REGISTRADO". | **Vacío.** §7.2 dice "nombre resuelto"; no hay nombre. |
| Objeto de msg-002 | "adversarial": exactamente 200. | **Verificado: 200 caracteres. Pasa.** |
| Bun | Se asumía disponible. | **Está fuera del PATH; se prueba la demo invocándolo por su ruta.** |