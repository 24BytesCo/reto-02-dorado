# SOLUCION — Agente de registro de contratos vigentes

Alexis Dorado Muñoz · 24 BYTES · Reto técnico 02, Periferia IT Group.

## 1. Problema en una frase

El maestro de contratos está congelado desde el 2026-05-30 porque no hay un punto único de recepción y solo llegan los contratos con póliza. Le duele a la **analista administrativa**, que no sabe qué está vigente, y a la **dirección**, que no puede responder qué vence ni qué pólizas faltan. El proceso dependía de una persona y murió con su salida.

## 2. Arquitectura

```
navegador ── web/ (HTML + JS plano: historial, tarjeta por herramienta, confirmación resaltada)
   │  POST /api/chat (JSON o stream SSE con latido)
   ▼
src/server.ts ── API HTTP: valida el cuerpo con zod, límite por IP, 409 si la sesión está ocupada
   │
   ▼
src/agent/motor.ts ── ciclo: modelo → herramientas → modelo, topes, CA3, rollback
   │       ├─ src/agent/confirmacion.ts   compuerta de confirmación (CA3) en código
   │       ├─ src/agent/sesiones.ts       sesiones en memoria + out/sesiones/<id>.json
   │       └─ src/llm/adapter.ts          interfaz propia → anthropic.ts | simulado.ts
   ▼
src/tools/contratos.ts ── contratos_leer_buzon, _extraer, _validar, _registrar, _alertas
   │       (nucleo.ts: validación zod, log y nunca lanza; reglas.ts: umbrales y constantes)
   ▼
fixtures/reto-02/ (solo lectura)           out/ (escritura)
buzón, maestro, comerciales                sharepoint/maestro-contratos.csv, sharepoint/Contratos/…,
                                           historial.jsonl, procesados.json, log.jsonl,
                                           alertas.md, sesiones/
```

| Pieza | Dónde vive |
|---|---|
| Comportamiento | `agent/prompt.md` |
| Conocimiento | `src/knowledge/registro-contratos.md` |
| Ejecución | `src/tools/` (parámetros de negocio en `src/tools/reglas.ts`) |

El servidor concatena prompt y conocimiento al arrancar. `demo.ts` importa las mismas herramientas y las llama sin modelo. `src/tools/` no importa nada del servidor ni del adaptador.

## 3. Ciclo del agente

- **Bucle.** El motor envía al modelo el system prompt, el historial y las definiciones de herramientas (JSON Schema generado desde los mismos esquemas zod que validan). Si la respuesta pide herramientas, las ejecuta en serie (varias escriben el mismo maestro), devuelve todos los resultados en un solo mensaje y repite. Termina cuando el modelo responde sin pedir herramientas.
- **Tope de iteraciones (CA1).** `MAX_ITERACIONES=25` por turno. Al llegar, el motor agrega un aviso y hace una última llamada **sin herramientas** (`tool_choice: none`) para que el modelo diga lo que hizo y lo que falta.
- **Tope de tokens.** `MAX_TOKENS_SESION=600000` suma entrada y salida por sesión. Superado, el turno responde con un aviso claro y no llama al modelo.
- **Tope global de tokens.** `MAX_TOKENS_GLOBAL=3000000` suma el gasto de todas las sesiones, así que abrir un `sessionId` nuevo no reinicia el costo. Se persiste en `out/uso.json`; un `POST /api/reset` no lo borra. Superado, el turno responde con aviso y no llama al modelo.
- **Pausa escalonada (`src/enfriamiento.ts`).** Si una IP encadena 6 turnos seguidos sin usar herramientas, queda en pausa 5 minutos y recibe un 429 que explica para qué sirve la herramienta. Cada reincidencia triplica la pausa, hasta 24 h. Un turno con trabajo real reinicia el contador. No llama al modelo, así que aplicarla no cuesta. Se configura con `ENFRIAMIENTO_UMBRAL`, `ENFRIAMIENTO_MINUTOS` y `ENFRIAMIENTO_MAXIMO_MINUTOS`.
- **Confirmación humana (CA3) en código.** Cuando `contratos_validar` devuelve `requiere_revision` no vacío, la sesión anota `pendientes[mensaje_id] = turno`. Una llamada a `contratos_registrar` con `confirmado: true` solo se ejecuta si ese pendiente se creó en un **turno anterior**, es decir, si hubo un mensaje nuevo de la analista entre la pregunta y la confirmación. Además, `src/agent/confirmacion.ts` exige que el mensaje de la analista afirme sin negar y que cada valor enviado sea el propuesto por la extracción o uno que ella escribió; así no se burla CA3 desde el turno siguiente ni se «redondea» un valor. Si algo falla, la herramienta no se ejecuta, el modelo recibe `{ ok: false }` con la instrucción de preguntar, y el bloqueo queda anotado en `out/log.jsonl`. `needsConfirmation` y `pendientes` se calculan del estado de la sesión, no del texto del modelo.
- **Turno atómico (CA5).** Al empezar el turno se copia el historial y los pendientes. Si el proveedor falla a mitad, se restaura la copia: nunca queda una llamada a herramienta sin su resultado, que haría fallar con 400 cada mensaje siguiente. Si una respuesta se corta con llamadas pedidas, cada una recibe un resultado de error. El error llega al chat en español y la sesión sigue.
- **Sesiones.** En memoria y persistidas en `out/sesiones/<id>.json` con escritura atómica. El historial vive en el backend: el navegador no puede inyectar resultados de herramientas ni una confirmación. Un motor nuevo recarga la sesión del disco.
- **Stream con latido.** El prompt del §11 tarda más de lo que aguantan el proxy (Nginx Proxy Manager corta a los 60 s sin bytes) y Cloudflare (100 s). Con `Accept: text/event-stream` la API emite cada paso como evento SSE y un comentario `: latido` cada 15 s. Si el navegador se desconecta, el turno termina igual y queda en la sesión.

## 4. Elección del modelo

| Elemento | Elección |
|---|---|
| Proveedor | Anthropic, detrás del adaptador propio (`src/llm/anthropic.ts` es el único archivo que importa el SDK) |
| Modelo | `claude-opus-5-5` |
| Configuración | Esfuerzo `low`, razonamiento adaptativo, caché automática de prompts, respaldo del servidor ante rechazos (si la cuenta no lo admite, se reintenta sin él y se recuerda) |
| Alternativa | `claude-sonnet-5-5` cambiando `LLM_MODELO`; `LLM_PROVEEDOR=simulado` corre sin clave |

**Por qué.** El trabajo del modelo es orquestar 18 llamadas a herramientas en un turno, respetar la compuerta de confirmación y redactar en español una tabla y una pregunta precisas. Ahí la calidad paga. El costo queda bajo por dos razones: la caché relee el prompt y el historial a una fracción del precio, y la extracción es determinista, así que el modelo no procesa el texto completo de cada contrato.

**Costo medido** (2026-11-03, API real, caso completo del §11: 6 correos y la confirmación de msg-006):

| Turno | Duración | Herramientas | Resultado |
|---|---|---|---|
| 1: prompt literal del §11 | 30 s | 18 | Tabla de 6 mensajes, alertas y la pregunta sobre msg-006 (valor y fecha_fin con evidencia) |
| 2: «confirmo el valor 0 y la fecha fin 2027-08-31» | 15 s | 3 | msg-006 registrado y alertas regeneradas |

| Concepto | Tokens |
|---|---|
| Llamadas al modelo | 10 |
| Entrada (incluye escritura de caché) | 21.317 |
| Salida | 3.822 |
| Lectura de caché | 134.987 |
| **Costo total** | **USD 0,1887** (unos 3 centavos por correo) |

Sin caché, esos 134.987 tokens se cobrarían como entrada normal (USD 4 por millón frente a 0,20): el caso costaría unos USD 0,70 en lugar de 0,19. Precios usados: los de la tabla `PRECIOS` de `src/agent/motor.ts`, que emite el costo de cada llamada en el evento `uso`.

## 5. Estrategia de extracción

La extracción es determinista: reglas genéricas sobre el texto, por cláusulas (PLAZO, VALOR, GARANTÍAS), nunca por mensaje concreto. Una prueba falla si aparece una regla escrita para un mensaje o un contrato del fixture.

| Campo | Cómo se obtiene |
|---|---|
| Tipo de documento | Por el contenido del adjunto (CONTRATO, CONTRATO MARCO, OTROSÍ), no por el nombre del archivo |
| `id_contrato` | Patrón `XX-AAAA-NNN`; en un otrosí, el del contrato que modifica («AL CONTRATO … No.»). Sin número: `AUTO-<año>-<secuencia>` y queda en revisión |
| Partes y `cliente` | El CONTRATANTE; se excluye el NIT de Periferia, que aparece en todos los contratos. Si el NIT ya está en el maestro, se usa la grafía del maestro |
| `nit_cliente`, `pais` | El dígito de verificación se quita solo en el formato colombiano `ddd.ddd.ddd-d`; RUC de Ecuador y Perú quedan intactos. País por identificador y domicilio |
| `valor`, `moneda` | Solo de la cláusula VALOR. Detecta el separador: `265.000.000` → 265000000; `120,000.00` → 120000. Moneda por código o palabra (M/CTE, DÓLARES, SOLES); una desconocida da `{ ok: false }`. Valor por demanda → 0 e indeterminado |
| Fechas | Solo de la cláusula PLAZO, en español («primero (1) de agosto de 2026»), validadas (31 de febrero es error). Plazo en meses: fin = inicio + N meses, con ajuste a fin de mes |
| Póliza | Cláusula GARANTÍAS: tipos separados por `;`. Si exige póliza solo para ciertas órdenes (póliza condicional), `requiere_poliza = false` con advertencia |
| `objeto` | Sin la fórmula inicial, máximo 200 caracteres, recortado sin partir palabras |

**Confianza por campo**, en [0, 1]:

| Situación | Confianza |
|---|---|
| Explícito en el texto | 0,95 (0,85 a 0,9 cuando la señal es indirecta: moneda por palabra, objeto, país por una sola señal) |
| Deducido | 0,5 a 0,8: fecha fin por plazo en meses 0,5; valor por demanda 0,5; día de firma ausente o póliza condicional 0,8 |
| Ausente | `null` con confianza 0, nunca inventado |

**Regla de la confianza mínima.** Un campo con confianza menor a 0,8 (estricto: 0,8 pasa) entra en `requiere_revision`, y `contratos_registrar` lo rechaza sin `confirmado: true` (RN5). En un otrosí solo cuentan los campos que el documento trae; los ausentes heredan la fila.

**Dónde entra el modelo.** Orquesta las herramientas, conversa con la analista, presenta los campos dudosos con su evidencia y recibe sus correcciones, que vuelven a pasar por `contratos_validar`.

**Dónde no.** Nunca extrae ni calcula valores. CA2 está en código: `contratos_validar` y `contratos_registrar` revalidan desde el buzón y no confían en lo que mande el modelo. Todo valor distinto de lo extraído entra en revisión aunque el campo no fuera dudoso, así que `registrar` lo rechaza si no fue confirmado por la analista en un turno anterior. Y al confirmar no se pueden cambiar campos que no estaban en revisión: `registrar` responde que no estaban en revisión y pide validar de nuevo. Los días restantes y los conteos de las alertas también salen de la herramienta.

## 6. Regla de gobierno

**Propuesta para Periferia: todo contrato pasa por un buzón, o no existe.**

1. **Canal único.** El buzón `contratos@` del dominio corporativo. Lo administra la **analista administrativa**, que es la **dueña del maestro**. Esto responde la pregunta abierta del §10: sin área legal, la dueña es quien opera el registro, no quien firma.
2. **Obligación del comercial.** Enviar todo contrato firmado, todo otrosí y toda acta de terminación, **con o sin póliza**, en un máximo de **2 días hábiles** desde la firma. Asunto: `CONTRATO | Cliente | Número`. Adjunto: el documento firmado.
3. **Acuse automático.** En minutos, el agente responde al comercial con lo registrado (contrato, clasificación, ruta del archivo) o con lo que falta para registrarlo.
4. **Excepciones y escalamiento.** Un contrato sin firma o sin valor no entra al maestro: se devuelve al comercial con el motivo. Si a los **3 días hábiles** no está corregido, se escala a su líder comercial. Como no hay área legal, el escalamiento final es **gerencia**.
5. **Cierre del gap junio a agosto de 2026.** Una campaña única: cruzar lo facturado en ese periodo contra el maestro, enviar a cada comercial la lista de lo que le falta y fijar una fecha límite. Lo que llegue se procesa por el mismo buzón.
6. **Indicador mensual.** Porcentaje de contratos facturados en el mes que existen en el maestro, con meta **≥ 98 %**. Se acompaña con el porcentaje de pólizas exigidas constituidas a tiempo.

Evidencia del buzón: msg-002 es un contrato sin póliza que hoy nunca llegaría a administración, y msg-006 llega de un remitente que no está en el catálogo de comerciales y sin valor fijo.

## 7. Decisiones y trade-offs

| Decisión | Alternativa descartada | Por qué |
|---|---|---|
| Extracción determinista con confianza por campo | Que el modelo extraiga | Repetible, auditable y sin costo; la demo debe correr sin modelo |
| Invariantes en `validar` y `registrar` (CA2, RN5) | Confiar en el prompt | El código garantiza aunque el modelo se equivoque o redondee |
| Confirmación como pregunta al final del turno + compuerta por turno en el backend | Pausar el ciclo con botones de aprobar y rechazar | El PRD pide una pregunta y la confirmación en el siguiente mensaje; la compuerta impide que el modelo confirme por su cuenta |
| Historial en el backend, persistido en `out/sesiones/` | Que el navegador mande el historial | Nadie puede falsificar resultados de herramientas ni una confirmación; aguanta reinicios |
| Adaptador con tipos propios y un adaptador simulado | Usar los tipos del SDK en el ciclo | Cambiar de proveedor no toca el ciclo; el simulado prueba ciclo y errores sin clave |
| No compactar el historial | Resumir conversaciones largas | Cabe en el contexto; resumir reescribe valores de herramientas (CA2); el estado vive en archivos |
| Stream SSE con latido cada 15 s (JSON si no se pide stream) | Respuesta bloqueante | El §11 supera el timeout del proxy (60 s) y de Cloudflare (100 s); además muestra cada herramienta en vivo |
| RN1 antes que RN2, comparando id, valor y fechas | RN2 literal («mismo id y algún campo distinto») | msg-004 reenvía el contrato con el objeto redactado distinto; con RN2 literal se reescribiría una fila buena |
| Mismo NIT no basta: exige además objeto con similitud de Jaccard ≥ 0,9 | Deduplicar solo por NIT | Tres contratos nuevos (msg-001, 002 y 006) comparten NIT con contratos existentes |
| Alcance en el prompt (`## Alcance`) + topes en código (pausa escalonada, tokens por sesión y globales, turnos por IP) | Clasificador previo de entrada (guardrails tipo Bedrock Guardrails o NeMo) | Suma costo y latencia a cada mensaje para un riesgo que los topes ya acotan. Queda como siguiente paso si el uso escala |
| CSP estricta sin `'unsafe-inline'` y HTML con `Cache-Control: no-transform` | Abrir `'unsafe-inline'` en la CSP | Cloudflare inyecta un script en línea de detección de bots que la CSP bloqueaba. `no-transform` evita la inyección (documentado en JavaScript Detections de Cloudflare). Alternativa: un nonce por petición en la cabecera CSP, que Cloudflare reutiliza |
| Node 22 + `tsx` | Bun como runtime principal | El PRD admite los dos; Node viene en la imagen oficial y `node:test` no agrega dependencias. La demo se probó también con Bun |

**Alcance.** `agent/prompt.md`, sección «Alcance»: el agente solo atiende el registro de contratos (buzón, maestro, alertas). Cualquier otra cosa se responde en una frase, sin herramientas, que explica para qué sirve la herramienta. Única excepción: si alguien dice que piensa hacerse daño, responde una vez, en dos frases, con la Línea 106 o la 192 opción 4 en Colombia, y vuelve a su propósito.

**Módulo del bonus autónomo.** `npm run modulo` empaqueta con esbuild las herramientas en `modulo/tools/contratos.js` (solo requiere `zod`, externa). Es el artefacto portable del §9.4; `tests/modulo.test.ts` regenera el paquete en memoria y lo compara con el del repositorio.

**Dependencias, todas justificadas:**

| Paquete | Para qué |
|---|---|
| `zod` | Obligatorio por el PRD: argumentos de herramientas, cuerpo de la API y JSON de los fixtures. Genera el JSON Schema que ve el modelo |
| `express` | API HTTP mínima y conocida; la lógica no depende de ella |
| `@anthropic-ai/sdk` | Cliente oficial del proveedor; solo lo importa `src/llm/anthropic.ts` |
| `tsx` | Ejecuta TypeScript sin paso de compilación |
| `typescript` (+ `@types/*`) | Solo para `npm run typecheck`, en modo strict y sin `any` |
| `esbuild` (desarrollo) | Solo para `npm run modulo`: empaqueta las herramientas en un archivo |

## 8. Supuestos

El §0 remite a una rúbrica «de la sección 10» que no aparece: la sección 10 trata de riesgos. Se asumió que se evalúan §5, §6, §8 y §9. Las demás ambigüedades salen de `openspec/changes/agente-registro-contratos/revision-prd.md`:

| # | Ambigüedad | Decisión |
|---|---|---|
| S1 | msg-006 se firma «en el mes de agosto de 2026», sin día | Inicio 2026-08-31 (último día del mes, coincide con la fecha del correo), con advertencia y fuera de revisión. Fin = inicio + 12 meses = 2027-08-31, confianza 0,5. Se respeta la lista literal `[valor, fecha_fin]` del §7.4 |
| S2 | La moneda de msg-006 no está en la cláusula VALOR | COP con confianza 0,85: aparece en otra cláusula y el NIT y el domicilio son colombianos |
| S3 | Estado de la póliza tras un otrosí que pide ampliar garantías | Pasa a `pendiente` cuando un otrosí extiende plazo o valor de un contrato con póliza. Va en `diferencias` y en el historial |
| S4 | msg-006 exige póliza solo para órdenes mayores a COP 100 M | `requiere_poliza = false`, `no_aplica`, con advertencia. Con `true` quedaría una alerta imposible de cerrar mientras no haya orden |
| S5 | «Conflictos con el maestro» (HU-3) frente al otrosí que se registra solo | Conflicto = choque de identidad (mismo contrato con otro NIT, otra moneda u otro id). Los cambios de un otrosí van en `diferencias` |
| S6 | RN2 dice «algún campo distinto» y msg-004 trae otro objeto | RN1 va antes que RN2 y compara solo id, valor y fechas |
| S7 | El §10 dice «dedupe por NIT» | NIT primero, nunca NIT solo: RN2 exige NIT y objeto similar |
| S8 | Métrica de similitud ≥ 0,9 no definida | Jaccard de tokens sin tildes, mayúsculas ni palabras vacías |
| S9 | `fecha_registro`: ¿reloj o correo? | Fecha del correo. Determinista y coherente con `hoy = 2026-09-03` |
| S10 | Duplicado: «no se escribe nada» frente a `procesados.json` | «Nada» es maestro, historial y archivo. Duplicados y rechazados sí se marcan procesados y van al log; si no, reaparecen siempre |
| S11 | La ruta `<id>.<ext>` del otrosí pisaría el contrato original | Se archiva como `<id>-otrosi-<n>.<ext>` y la fila conserva su ruta |
| S12 | Extensión `.txt` frente a `.pdf` del maestro | Extensión real del adjunto |
| S13 | Remitente desconocido y la columna `comercial` | `comercial` vacío y advertencia; no se inventa |
| S14 | Contratos ya vencidos en las alertas | Ventana de 0 a 60 días. Los vencidos van en una subsección de la sección 1, fuera de `vencen[]`, para mantener tres secciones |
| S15 | Rúbrica de «la sección 10» inexistente | Se declara aquí y se asume §5, §6, §8 y §9 |
| S16 | `bun install && bun run demo.ts` frente a Node + tsx | Node 22 + tsx; la demo se probó también con Bun con la misma salida |
| S17 | `out/` global en un link público | Estado global (el reto no pide multiusuario) y `POST /api/reset` con botón en el front |
| S18 | Objeto de más de 200 caracteres (msg-006 mide 222) | Recorte sin partir palabras y sin bajar la confianza |
| S19 | RUC de Panamá con guiones («155612345-2-2017») | Se compara con el maestro por su primer segmento, que es como el maestro lo guarda. Si ese segmento no está, se conserva el RUC completo para no fusionar contribuyentes distintos |
| S20 | Moneda que la cláusula VALOR no dice ni el texto menciona | Se deduce solo por el país con confianza 0,6, bajo el umbral: va a revisión |

## 9. Cobertura

151 pruebas (`npm test`), todas pasan; `npm run typecheck` sin errores. Cobertura (`npm run cobertura`): 96,87 % de líneas, 87,33 % de ramas y 95,98 % de funciones. Las reglas de negocio (`src/tools/`) están entre 98 % y 100 % de líneas. El adaptador de Anthropic (84,62 % de líneas) depende de la API real y se probó en vivo (sección 4).

| Requisito | Estado | Prueba que lo demuestra |
|---|---|---|
| HU-1 Leer el buzón | Hecho | `tests/leer_buzon.test.ts` |
| HU-2 Extraer con confianza | Hecho | `tests/extraer.test.ts` |
| HU-3 Validar y clasificar | Hecho | `tests/validar.test.ts` |
| HU-4 Registrar y archivar | Hecho | `tests/registrar.test.ts`, `tests/almacen.test.ts` |
| HU-5 Alertar | Hecho | `tests/alertas.test.ts` |
| HU-6 Manejo de errores | Hecho | `tests/errores.test.ts` |
| CA1 Tope de iteraciones | Hecho | `tests/ciclo.test.ts` («CA1: al llegar al tope…») |
| CA2 Ningún valor fuera de herramientas | Hecho, en código | `tests/validar.test.ts` y `tests/registrar.test.ts` («CA2: …») |
| CA3 Confirmación humana | Hecho, en código | `tests/ciclo.test.ts` («CA3: confirmar en el mismo turno… se bloquea») y `tests/ca3.test.ts` (afirmación sin negación, valores propuestos o escritos por la analista) |
| CA4 Llamadas visibles y en el log | Hecho | `tests/ciclo.test.ts`, `tests/nucleo.test.ts` |
| CA5 Errores claros, sesión viva | Hecho | `tests/ciclo.test.ts` («CA5: si el proveedor falla a mitad de turno…») |
| RN1 Duplicado | Hecho | msg-004 en `tests/validar.test.ts` y `tests/registrar.test.ts` |
| RN2 Actualización | Hecho | msg-003 y «RN2 nunca solo por NIT» en `tests/validar.test.ts` |
| RN3 Nuevo | Hecho | msg-001 y msg-002 en `tests/validar.test.ts` |
| RN4 Rechazado | Hecho | msg-005 en `tests/validar.test.ts` y `tests/leer_buzon.test.ts` |
| RN5 Revisión bajo 0,8 | Hecho | msg-006 en `tests/registrar.test.ts` |
| RN6 Fixture de solo lectura | Hecho | `tests/almacen.test.ts`, estado final en `tests/registrar.test.ts` |
| RN7 `out/log.jsonl` | Hecho | `tests/nucleo.test.ts` |
| API y stream con latido | Hecho | `tests/api.test.ts` |
| Pausa escalonada y tope global de tokens | Hecho | `tests/enfriamiento.test.ts`, `tests/ca3.test.ts` |
| Casos nuevos de la verificación adversaria | Hecho | `tests/casos-nuevos.test.ts`, `tests/almacen-seguridad.test.ts` |
| `demo.ts` sin modelo | Hecho | `npm run demo` y `bun run demo.ts` |
| `contratos_leer_pdf` (P1) | No hecho | Los fixtures son `.txt` |
| Bonus `modulo/` | Hecho | `tests/modulo.test.ts` (falla si las piezas, incluido el paquete de herramientas regenerado, se separan de su fuente) |

**Qué falta para producción:**
- Exchange y SharePoint reales vía Microsoft Graph, en lugar de carpetas locales.
- Lectura de PDF (`contratos_leer_pdf`) y OCR para escaneados.
- Autenticación y roles: quién puede confirmar y quién solo consulta.
- Sesiones en base de datos y `out/` separado por usuario o por empresa.
- Monitoreo de errores y de costo por caso, con alertas de gasto.
- Evaluación continua del prompt, con los 6 casos del buzón como regresión.

## 10. Uso de IA

Se construyó con **Claude Code (Anthropic)** como asistente principal, orquestando subagentes en paralelo:
- **Claude Opus**: reglas de negocio, ciclo del agente, verificación adversaria y esta documentación.
- **Claude Sonnet**: alertas, errores, prompt, conocimiento, API, front y el módulo.

Un director integró, revisó y probó cada pieza antes de su commit: un commit por tarea.

**Ronda de verificación adversaria.** Con el sistema ya funcionando, 3 agentes intentaron romperlo: uno por la forma del PRD, otro con casos nuevos de negocio y otro por el ciclo y la seguridad. Encontraron, entre otros:
- CA3 se podía burlar desde el turno siguiente.
- Un correo roto tumbaba `leer_buzon`.
- Una respuesta vacía del modelo mataba la sesión.
- Variantes de redacción hacían perder la póliza o rechazaban contratos válidos.
- Inyección de fórmulas en el CSV.

4 agentes los corrigieron, con una prueba por arreglo (`tests/ca3.test.ts`, `tests/casos-nuevos.test.ts`, `tests/almacen-seguridad.test.ts`).

Antes de la sesión se preparó una base genérica de ciclo y chat a partir del instructivo. El repositorio de entrega se creó desde cero al iniciar. Antes de escribir código, cuatro agentes independientes revisaron el PRD (literal, valores esperados, adversaria y entrega); la síntesis está en `openspec/changes/agente-registro-contratos/revision-prd.md`.

**Qué se descartó de lo que propuso la IA, y por qué:**

| Propuesta | Por qué se descartó |
|---|---|
| Deduplicar solo por NIT, como sugiere una lectura literal del §10 | Habría pisado tres contratos existentes con msg-001, msg-002 y msg-006 |
| Marcar la póliza del contrato marco (msg-006) como pendiente | Una alerta imposible de cerrar mientras no haya orden de servicio |
| Usar la fecha del reloj como `fecha_registro` | Rompía el determinismo y quedaba «en el futuro» respecto a `hoy = 2026-09-03` |
| El extractor genérico de la base previa, por sinónimos «etiqueta: valor» | No sirve para contratos en prosa; se reescribió por cláusulas |
| Pausar el ciclo con botones de aprobar y rechazar | El PRD pide una pregunta y la confirmación en el siguiente mensaje |
| Compactar el historial | Reescribe valores de herramientas y no hace falta |
| Un clasificador previo de entrada (guardrails) para filtrar mensajes fuera de propósito | Costo y latencia en cada mensaje; el alcance en el prompt más los topes en código bastan por ahora |
| Construir el front con una herramienta externa (Lovable) | Riesgo, y se quiere poder explicar cada línea; el front es HTML y JavaScript plano |
| Reescribir la historia de git para cambiar el formato de los títulos de tareas | El historial de commits es parte de la entrega; no se reescribe |

**Errores de la IA que detectaron las pruebas:**
- El patrón `\b` de JavaScript no reconoce el límite de palabra después de la «Í» de «OTROSÍ», y el otrosí salía rechazado. Hay una prueba específica en `tests/leer_buzon.test.ts`.
- Un ejemplo del conocimiento traía un dígito de verificación equivocado.
- Una prueba confundía ejemplos en comentarios con reglas escritas para un fixture.
- El Dockerfile fijaba `NODE_ENV=production` antes de `npm ci`, así que no instalaba `tsx` y el servidor no habría arrancado. Se detectó al probar la imagen antes de desplegar.
- Reiniciar la demo borraba la carpeta `out/` completa; en producción es un volumen de Docker y eso falla. Ahora se vacía su contenido. Lo detectó la revisión de la API.

Todo el código fue revisado y puede explicarse línea a línea.

## 11. Riesgos

| Riesgo en producción | Mitigación |
|---|---|
| Contratos escaneados | OCR antes de extraer; mientras no exista, el documento sin texto se rechaza con motivo |
| Formatos de contrato que el extractor no conoce | Todo campo no reconocido queda ausente o con confianza baja y va a revisión humana. Las reglas se amplían con casos reales. El modelo puede proponer, pero la herramienta valida |
| Falsos duplicados por variaciones del nombre | Dedupe por NIT más similitud de objeto, nunca por nombre ni por NIT solo |
| El modelo «redondea» un valor o infiere una fecha | CA2 en código: un valor distinto de lo extraído no se registra sin confirmación de la analista |
| Costo sin control | Tope de iteraciones por turno, tope de tokens por sesión y global (`MAX_TOKENS_GLOBAL`, en `out/uso.json`), límite de turnos por IP, caché de prompts y costo medido por llamada |
| Uso del agente fuera de su propósito | Alcance en el prompt y pausa escalonada por IP (5 min, ×3 por reincidencia, hasta 24 h) con 429 explicativo que no llama al modelo. Si el abuso escala, clasificador previo de entrada |
| Inyección de fórmulas en el CSV del maestro | Todo texto que Excel leería como fórmula (`=`, `+`, `-`, `@`, tabulador, retorno) se neutraliza con un apóstrofo al escribir |
| Inyección de instrucciones dentro de un contrato o correo | El prompt trata el contenido como dato; aunque el modelo obedezca, el código impide registrar un dato dudoso sin confirmación en un turno posterior |
| Fallos del proveedor | Turno atómico con rollback, timeout configurable, errores traducidos al español y respaldo del servidor |
| Estado global de `out/` en el link público | Botón «Reiniciar demo»; en producción, estado por usuario y base de datos |
| El comercial no envía los contratos | Regla de gobierno (sección 6) e indicador mensual de cobertura del maestro |
