/**
 * CA3 en código: `confirmado: true` solo vale si la revisión de ese mensaje se pidió en un turno ANTERIOR
 * de la sesión, es decir, si entre la pregunta y la confirmación hubo un mensaje nuevo de la analista.
 * El prompt pide lo mismo; esto lo garantiza aunque el modelo intente confirmar por su cuenta.
 */

/** Resultado que recibe el modelo cuando intenta confirmar en el mismo turno. */
export const MENSAJE_BLOQUEO =
  "La confirmación debe venir de la analista en un mensaje nuevo: muéstrale los campos en revisión, pregúntale y termina el turno.";

const VALIDAR = "contratos_validar";
const REGISTRAR = "contratos_registrar";

interface ResultadoLeido {
  ok: boolean;
  data?: { requiere_revision?: unknown };
  error?: unknown;
}

/** `mensaje_id` de los argumentos de una llamada, si viene como texto. */
export function mensajeIdDe(argumentos: unknown): string | null {
  if (typeof argumentos !== "object" || argumentos === null || !("mensaje_id" in argumentos)) return null;
  return typeof argumentos.mensaje_id === "string" ? argumentos.mensaje_id : null;
}

const confirma = (argumentos: unknown): boolean =>
  typeof argumentos === "object" && argumentos !== null && "confirmado" in argumentos && argumentos.confirmado === true;

/**
 * CA3, RN5: ¿hay que bloquear esta llamada? Solo afecta a `contratos_registrar` con `confirmado: true`
 * cuyo mensaje no tiene un pendiente creado en un turno anterior al actual.
 */
export function confirmacionBloqueada(pendientes: Record<string, number>, turno: number, nombre: string, argumentos: unknown): boolean {
  if (nombre !== REGISTRAR || !confirma(argumentos)) return false;
  const id = mensajeIdDe(argumentos);
  const pedidoEn = id === null ? undefined : pendientes[id];
  return pedidoEn === undefined || pedidoEn >= turno;
}

function leer(contenido: string): ResultadoLeido | null {
  try {
    return JSON.parse(contenido) as ResultadoLeido;
  } catch {
    return null;
  }
}

/** ¿El resultado pide revisión humana? `validar` con `requiere_revision` no vacío o `registrar` rechazado por revisión (RN5). */
function pideRevision(nombre: string, r: ResultadoLeido): boolean {
  if (nombre === VALIDAR) return r.ok && Array.isArray(r.data?.requiere_revision) && r.data.requiere_revision.length > 0;
  return nombre === REGISTRAR && !r.ok && typeof r.error === "string" && r.error.startsWith("requiere revisión");
}

/**
 * Actualiza los pendientes de la sesión con el resultado de una herramienta (CA3).
 * Un pendiente conserva el turno en que se creó: volver a validar tras la confirmación no lo «rejuvenece»,
 * porque eso bloquearía el flujo legítimo validar(corregido) → registrar(confirmado). Un registro exitoso lo borra.
 */
export function actualizarPendientes(pendientes: Record<string, number>, turno: number, nombre: string, argumentos: unknown, contenido: string): void {
  const id = mensajeIdDe(argumentos);
  const r = leer(contenido);
  if (id === null || r === null) return;
  if (nombre === REGISTRAR && r.ok) delete pendientes[id];
  else if (pideRevision(nombre, r)) pendientes[id] ??= turno;
}
