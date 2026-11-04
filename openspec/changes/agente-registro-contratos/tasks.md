# Tareas

Cada tarea es un issue y un commit («Cierra #n»), con sus pruebas. Bloque de 2 horas (20:00 a 22:00).

## 0. Estructura y plan (20:00-20:20)
- [ ] 0.1 Plan y especificación OpenSpec: contexto, reglas de codificación, propuesta, diseño, escenarios y tareas
- [ ] 0.2 Estructura del repositorio (PRD §6.5), scripts, tsconfig, `.env.example` sin valores y esqueletos de `README.md` y `SOLUCION.md` con sus 11 secciones

## 1. Herramientas con pruebas (20:20-21:05)
- [ ] 1.1 Núcleo de herramientas: contrato `{description, args, execute}`, nombre `contratos_<export>` generado desde los exports, validación zod previa, `out/log.jsonl` en todos los casos (RN7) y nunca lanza
- [ ] 1.2 Almacén en `out/`: CSV RFC 4180 de ida y vuelta idéntico (todo como texto), copia del maestro (RN6), `procesados.json`, `historial.jsonl` y archivo tipo SharePoint
- [ ] 1.3 `contratos_leer_buzon` (HU-1): `tiene_contrato` decidido por el contenido del adjunto, no por su nombre
- [ ] 1.4 `contratos_extraer` (HU-2): reglas genéricas para identificador, partes, NIT y país, objeto, valor y moneda, fechas y plazo en meses, póliza; confianza por campo; extracción guardada por mensaje
- [ ] 1.5 `contratos_validar` (HU-3): RN1 antes que RN2, RN2 con NIT y similitud de objeto ≥ 0,9, otrosí con herencia de campos, `requiere_revision`, `diferencias` y advertencia por remitente desconocido
- [ ] 1.6 `contratos_registrar` (HU-4): revalida, exige `confirmado`, solo acepta valores distintos a la extracción en campos en revisión (CA2), archiva, escribe historial con lo propuesto y lo confirmado, marca procesado y es idempotente
- [ ] 1.7 `contratos_alertas` (HU-5): `out/alertas.md` con tres secciones, vencimientos entre 0 y 60 días con `dias_restantes` calculado y vencidos como nota
- [ ] 1.8 Errores tipados (HU-6): texto vacío, fecha inválida y moneda desconocida; `BUZON_DIR` para probar casos nuevos
- [ ] 1.9 `demo.ts` (§6.6): limpia `out/`, procesa los 6 mensajes en orden, muestra el rechazo y la segunda llamada confirmada de `msg-006`, alertas con `hoy = 2026-09-03`; corre sin clave con Node y con Bun

## 2. Agente (21:05-21:35)
- [ ] 2.1 Adaptador LLM con tipos propios: implementación de Anthropic y un adaptador simulado para pruebas, elegibles por variable de entorno
- [ ] 2.2 Ciclo del agente: tope de iteraciones con cierre sin herramientas (CA1), llamadas y resultados siempre en pareja, tope de tokens por sesión, timeout, errores claros sin exponer la clave (CA5), confirmación aceptada solo en un mensaje posterior (CA3), `needsConfirmation` calculado en código y sesiones guardadas en `out/sesiones/`
- [ ] 2.3 `agent/prompt.md` (comportamiento) y `src/knowledge/registro-contratos.md` (conocimiento), cargados por el servidor
- [ ] 2.4 API (§6.4): `POST /api/chat` (JSON o stream de eventos con latido), `GET /api/sessions/:id`, `GET /api/health`, `POST /api/reset`
- [ ] 2.5 Front `web/`: historial que se reconstruye al recargar, indicador de «pensando», tarjeta por llamada a herramienta, confirmación resaltada y botón para reiniciar la demo

## 3. Entrega (21:35-22:00)
- [ ] 3.1 Despliegue temprano en https://nuevo.24bytes.pro (zona horaria de Bogotá, `out/` en volumen) y prueba completa del §11 desde fuera
- [ ] 3.2 `README.md`: un comando, variables, demo, link y API
- [ ] 3.3 `SOLUCION.md` con sus 11 secciones, la regla de gobierno y los supuestos
- [ ] 3.4 Verificación adversaria final con varios agentes y correcciones
- [ ] 3.5 Bonus `modulo/` generado desde las mismas fuentes (si hay tiempo)
- [ ] 3.6 Cierre: sin `out/` ni `.env` en el repositorio, sin claves, sin `any` ni casos fijos por mensaje; demo sin clave; link reiniciado

## Orden de sacrificio si falta tiempo
Bonus `modulo/` → `contratos_leer_pdf` → estética del front. Nunca: demo, pruebas de los 6 casos, CA3 en código, link público ni `SOLUCION.md`.

## Criterio de terminado
Los 6 casos del §7.4 dan el resultado esperado en `demo.ts`, en las pruebas y en el chat publicado; el prompt del §11 produce la tabla, la pregunta de confirmación de `msg-006` y el resumen de alertas; tras «confirmo el valor 0 y la fecha fin 2027-08-31», `msg-006` queda en el maestro.
