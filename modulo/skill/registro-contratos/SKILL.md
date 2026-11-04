---
name: registro-contratos
description: Úsalo para registrar contratos vigentes, validar sus campos, detectar duplicados o actualizaciones y generar alertas de vencimiento y pólizas pendientes.
---

# Conocimiento: registro de contratos vigentes

## Problema
El maestro de contratos de Periferia está congelado desde el **2026-05-30**. Lo alimentaba un aprendiz que ya no está. Solo llegaban a administración los contratos con póliza, no existe un punto único de recepción ni área legal interna. El agente es ese punto único: lee el buzón, extrae, valida, archiva y alimenta el maestro. La dueña del maestro es la **analista administrativa**.

## Maestro (una fila por contrato)
| Columna | Significado |
|---|---|
| `id_contrato` | Número tal como aparece en el documento; si no existe, `AUTO-<año>-<secuencia>` |
| `cliente` | Razón social de la contraparte |
| `nit_cliente` | Identificador tributario sin puntos ni dígito de verificación |
| `pais` | CO, EC, PE, PA o HN |
| `objeto` | Máximo 200 caracteres; si excede, se recorta sin partir palabras |
| `valor` | Número sin separadores; `0` si es por demanda (`valor_indeterminado`) |
| `moneda` | COP, USD, PEN, PAB o HNL |
| `fecha_inicio`, `fecha_fin` | YYYY-MM-DD; `fecha_fin` puede derivarse de un plazo en meses |
| `requiere_poliza` | true o false |
| `tipo_poliza` | Lista separada por `;`; vacío si no requiere |
| `estado_poliza` | `vigente`, `pendiente`, `vencida` o `no_aplica` |
| `comercial` | Nombre resuelto desde el catálogo de comerciales; vacío si el remitente es desconocido |
| `ruta_sharepoint` | Ruta relativa del documento archivado |
| `fecha_registro` | Fecha del correo (no la del reloj) |
| `fuente` | `buzon`, `manual` o `migracion` |

## Clasificación (reglas en este orden)
1. **RN4 `rechazado`**: sin adjunto de contrato, o texto sin partes ni objeto identificables (por ejemplo una cotización). Se reporta con motivo.
2. **RN1 `duplicado`**: mismo `id_contrato` y mismos `valor`, `fecha_inicio` y `fecha_fin`. No se escribe en el maestro, el historial ni los archivos; el mensaje sí queda procesado.
3. **RN2 `actualizacion`**: mismo `id_contrato` (o mismo NIT **y** objeto con similitud ≥ 0,9), o el documento es un otrosí. Se actualiza la fila y el cambio queda en el historial. Un mismo NIT por sí solo no basta: un cliente puede tener varios contratos distintos.
4. **RN3 `nuevo`**: no hay coincidencia; se inserta.

Otras reglas: **RN5**, un campo con confianza menor a 0,8 (0,8 exacto pasa) entra en `requiere_revision` y no se registra sin `confirmado: true`. **RN6**, el maestro original es de solo lectura; se trabaja sobre una copia. **RN7**, toda llamada a una herramienta queda en el log.

En una actualización, los campos que el otrosí no trae se heredan de la fila existente y no cuentan para la revisión. Los cambios que trae un otrosí van en `diferencias`, no en `requiere_revision`; «conflicto» es solo un choque de identidad (mismo id con otro NIT u otra moneda).

## Convenciones
- **NIT**: sin puntos ni dígito de verificación (`890.900.111-4` queda `890900111`). Los identificadores de otros países se conservan completos. El NIT de Periferia (900.123.456-7) es el contratista y nunca el cliente.
- **País**: se infiere del identificador o del texto del contrato.
- **Ruta**: `Contratos/<año_inicio>/<cliente-slug>/<id_contrato>.<ext>`, con la extensión real del adjunto. El slug va en minúsculas, sin tildes ni sufijo societario. Un otrosí se archiva como `<id_contrato>-otrosi-<n>.<ext>` y la fila conserva su ruta original.
- **Póliza**: un contrato nuevo que la exige queda `pendiente`; uno que no, `no_aplica`. Un otrosí que obliga a ampliar las garantías pasa el `estado_poliza` a `pendiente`.
- **Póliza condicional** (contrato marco cuyas órdenes de servicio mayores a un umbral exigen póliza): el marco queda `requiere_poliza = false` y `no_aplica`, con una advertencia que recuerda la condición.
- **Fecha de firma sin día** («en el mes de agosto de 2026»): se toma el último día de ese mes. Es una fecha deducida: se informa como advertencia, no entra en la revisión por sí sola.
- **Plazo en meses**: `fecha_fin` es una fecha deducida con confianza baja y por eso va a revisión.
- **Comercial desconocido**: se informa y no bloquea; `comercial` queda vacío, no se inventa.
- **Confianza**: de 0 a 1 por campo. Dato explícito en el texto, alta; dato derivado, media; ausente, `null` con 0. Umbral de revisión: 0,8.
- **Similitud de objeto**: umbral 0,9.

## Alertas (`out/alertas.md`, con la fecha «hoy» dada por la analista)
Tres secciones:
1. **Vencen en ≤ 60 días**: ventana de 0 a 60 días desde «hoy». Los ya vencidos van en una subsección «Vencidos sin renovación registrada», no mezclados con los que vencen.
2. **Pólizas pendientes**: `requiere_poliza = true` y `estado_poliza` distinto de `vigente`.
3. **Registrados desde el 2026-05-30**: contratos registrados desde el corte (el vacío que se cubre).

Los días restantes los calcula la herramienta, nunca el agente.
