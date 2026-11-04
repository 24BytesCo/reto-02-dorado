# Especificación: contratos

## ADDED Requirements

### Requirement: Leer el buzón (HU-1)
`contratos_leer_buzon` SHALL listar los mensajes de `fixtures/reto-02/buzon/` que no estén en `out/procesados.json`, con `{ id, de, asunto, fecha, adjuntos[], tiene_contrato }`. Un mensaje sin adjunto de contrato SHALL marcarse `tiene_contrato: false` y clasificarse `rechazado` con motivo.

#### Scenario: Cotización (msg-005)
- **WHEN** se lee el buzón y `msg-005` solo adjunta `cotizacion.txt`
- **THEN** aparece con `tiene_contrato: false`, clasificado `rechazado` y con motivo

#### Scenario: Mensaje ya procesado
- **WHEN** un mensaje está en `out/procesados.json`
- **THEN** no aparece en la lista

### Requirement: Extraer con confianza (HU-2)
`contratos_extraer` SHALL devolver el esquema del maestro (§7.2) con `confianza` en [0, 1] por campo, mediante extracción determinista sobre el adjunto. Un campo ausente SHALL ser `null` con confianza `0`, nunca inventado.

#### Scenario: Contrato completo (msg-001)
- **WHEN** se extrae `msg-001`
- **THEN** `id_contrato = CT-2026-015`, `cliente = Industrias Delta S.A.S.`, `nit_cliente = 890900111`, `pais = CO`, `valor = 265000000`, `moneda = COP`, `fecha_inicio = 2026-08-01`, `fecha_fin = 2027-07-31`, `requiere_poliza = true`, `tipo_poliza = cumplimiento`, todos con confianza ≥ 0,8

#### Scenario: Contrato en dólares sin póliza (msg-002)
- **WHEN** se extrae `msg-002`
- **THEN** `nit_cliente = 1790012345001`, `pais = EC`, `valor = 120000`, `moneda = USD`, `fecha_fin = 2027-08-14`, `requiere_poliza = false`

#### Scenario: Valor por demanda y plazo en meses (msg-006)
- **WHEN** se extrae `msg-006`, que dice «se firma en el mes de agosto de 2026» sin día y «doce (12) meses contados a partir de la fecha de su firma»
- **THEN** `id_contrato = CM-2026-03`, `valor = 0` con `valor_indeterminado = true` (confianza < 0,8), `fecha_inicio = 2026-08-31` (último día del mes de firma, igual a la fecha del correo) y `fecha_fin = 2027-08-31` propuesta con confianza < 0,8; el resto de campos con confianza ≥ 0,8

#### Scenario: Otrosí (msg-003)
- **WHEN** se extrae el otrosí
- **THEN** `id_contrato = CT-2026-011` (el contrato al que modifica, no el número del otrosí), `fecha_fin = 2027-11-01`, `valor = 520000`, `moneda = PEN`; los campos que el otrosí no trae son `null` con confianza 0

#### Scenario: Reglas genéricas
- **WHEN** se revisa el código del extractor
- **THEN** no existe ninguna regla escrita para un mensaje concreto: todo sale de patrones del texto

### Requirement: Validar y clasificar (HU-3, RN1-RN5)
`contratos_validar` SHALL clasificar en `nuevo`, `actualizacion`, `duplicado` o `rechazado` y devolver `requiere_revision[]` con los campos de confianza < 0,8 y los conflictos con el maestro. Un remitente fuera de `comerciales.json` SHALL reportarse sin bloquear.

#### Scenario: Cliente existente, contrato distinto (msg-001, msg-002)
- **WHEN** el NIT ya está en el maestro con otro `id_contrato` y un objeto con similitud < 0,9
- **THEN** se clasifica `nuevo`, no `actualizacion`

#### Scenario: Otrosí (RN2, msg-003)
- **WHEN** llega el otrosí de `CT-2026-011`
- **THEN** se clasifica `actualizacion` con diferencias `fecha_fin: 2027-05-01 → 2027-11-01` y `valor: 350000 → 520000`; los campos que no trae heredan la fila existente y no entran en `requiere_revision`

#### Scenario: Duplicado antes que actualización (RN1, msg-004)
- **WHEN** llega `CT-2026-012` con el mismo valor y las mismas fechas que el maestro, aunque el objeto y el nombre del cliente estén escritos distinto
- **THEN** se clasifica `duplicado` (RN1 se evalúa antes que RN2 y compara valor, fecha de inicio y fecha de fin)

#### Scenario: Remitente desconocido (msg-006)
- **WHEN** el remitente `jperez@periferia-ficticia.com` no está en `comerciales.json`
- **THEN** se reporta como advertencia y la clasificación continúa: `nuevo` con `requiere_revision = [valor, fecha_fin]`

### Requirement: Registrar y archivar (HU-4, RN5, RN6)
`contratos_registrar` SHALL escribir solo si `requiere_revision` está vacío o `confirmado = true`, sobre `out/sharepoint/maestro-contratos.csv` (copia del fixture). SHALL archivar en `out/sharepoint/Contratos/<año_inicio>/<cliente-slug>/<id_contrato>.<ext>`, guardar esa ruta en la fila, anotar `{ ts, id_contrato, accion, cambios, mensaje_id }` en `historial.jsonl` y marcar el mensaje en `out/procesados.json`.

#### Scenario: Registro con póliza (msg-001)
- **WHEN** se registra `msg-001`
- **THEN** la fila queda con `estado_poliza = pendiente`, `fuente = buzon` y `ruta_sharepoint = Contratos/2026/industrias-delta/CT-2026-015.txt`

#### Scenario: Registro sin póliza (msg-002)
- **WHEN** se registra `msg-002`
- **THEN** `estado_poliza = no_aplica`

#### Scenario: Actualización (msg-003)
- **WHEN** se registra el otrosí
- **THEN** se modifica la fila existente (no se agrega otra) y el historial guarda el antes y el después

#### Scenario: Duplicado sin escritura (msg-004)
- **WHEN** se registra `msg-004`
- **THEN** el maestro no cambia

#### Scenario: Bloqueo por revisión (msg-006)
- **WHEN** se registra `msg-006` sin `confirmado`
- **THEN** responde `{ ok: false, error: "requiere revisión: valor, fecha_fin" }` y el maestro no cambia

#### Scenario: Registro confirmado (msg-006)
- **WHEN** la analista confirma valor 0 y fecha fin 2027-08-31 y se registra con `confirmado: true`
- **THEN** la fila queda en el maestro con esos valores y el historial guarda lo propuesto y lo confirmado

#### Scenario: El modelo no puede cambiar valores sin revisión (CA2)
- **WHEN** se registra un contrato cuyo valor difiere de la extracción en un campo que no estaba en revisión
- **THEN** responde `{ ok: false }` y no escribe

#### Scenario: Idempotencia
- **WHEN** se vuelve a registrar un mensaje ya registrado
- **THEN** no se duplica la fila y el resultado es `duplicado`

### Requirement: Confirmación humana en código (CA3)
El backend SHALL aceptar `confirmado: true` para un mensaje solo si la revisión se pidió en un turno anterior de la misma sesión y el nuevo mensaje del usuario es el que confirma.

#### Scenario: El modelo intenta confirmar solo
- **WHEN** en el mismo turno en que se detectó la revisión el modelo llama a `contratos_registrar` con `confirmado: true`
- **THEN** el backend lo rechaza y el turno termina con la pregunta a la analista y `needsConfirmation = true`

### Requirement: Alertas (HU-5)
`contratos_alertas` SHALL generar `out/alertas.md` con tres secciones: contratos que vencen en ≤ 60 días desde `hoy`; contratos con `requiere_poliza = true` y `estado_poliza != vigente`; contratos registrados desde el corte 2026-05-30.

#### Scenario: Fecha determinista
- **WHEN** se piden alertas con `hoy = 2026-09-03` dos veces
- **THEN** el resultado es idéntico

### Requirement: Errores y trazabilidad (HU-6, RN7)
Cada herramienta SHALL devolver `{ ok: false, error }` legible ante texto vacío, fecha inválida o moneda desconocida, y el lote SHALL continuar con el siguiente mensaje. Toda llamada SHALL quedar en `out/log.jsonl` con `{ ts, herramienta, mensaje_id, ok, resumen }`.
