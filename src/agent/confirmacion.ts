/**
 * CA3 en código: `confirmado: true` solo vale si la revisión de ese mensaje se pidió en un turno ANTERIOR,
 * si el mensaje de la analista de ESTE turno confirma (y no niega), y si cada valor que el modelo manda
 * es el que propuso la extracción o la analista lo escribió. El prompt pide lo mismo; esto lo garantiza
 * aunque el modelo obedezca a una instrucción inyectada o «redondee» un valor (PRD §10 Riesgo).
 */

/** Resultado que recibe el modelo cuando intenta confirmar en el mismo turno. */
export const MENSAJE_BLOQUEO =
  "La confirmación debe venir de la analista en un mensaje nuevo: muéstrale los campos en revisión, pregúntale y termina el turno.";

/** Resultado cuando el mensaje de la analista no confirma o niega (CA3). */
export const MENSAJE_SIN_CONFIRMACION =
  "La analista no confirmó en su último mensaje (o lo negó): no se registra. Pregúntale de nuevo y termina el turno.";

/** Pendiente de confirmación de un mensaje del buzón (CA3, RN5). */
export interface Pendiente {
  /** Turno en que se pidió la revisión. */
  turno: number;
  /** Campos en `requiere_revision`. */
  campos: string[];
  /** Valores que propuso la extracción, en el formato de texto del maestro; solo los que no corrigió el modelo. */
  propuestos: Record<string, string>;
}

/** Pendientes de una sesión: `mensaje_id` → pendiente. */
export type Pendientes = Record<string, Pendiente>;

const VALIDAR = "contratos_validar";
const REGISTRAR = "contratos_registrar";
const AFIRMACION = /\b(confirm\w*|si|apruebo|aprobado|de acuerdo|correcto|adelante|registr\w*|procede\w*)\b/;
const NEGACION = /\b(no|nunca|jamas|ni)\b/;

interface ResultadoLeido {
  ok: boolean;
  data?: { requiere_revision?: unknown; clasificacion?: unknown; propuesta?: unknown };
  error?: unknown;
}

const esObjeto = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** `mensaje_id` de los argumentos de una llamada, si viene como texto. */
export function mensajeIdDe(argumentos: unknown): string | null {
  if (!esObjeto(argumentos)) return null;
  return typeof argumentos.mensaje_id === "string" ? argumentos.mensaje_id : null;
}

const confirma = (argumentos: unknown): boolean => esObjeto(argumentos) && argumentos.confirmado === true;

/** Contrato corregido que trae la llamada, o un objeto vacío. */
const contratoDe = (argumentos: unknown): Record<string, unknown> =>
  esObjeto(argumentos) && esObjeto(argumentos.contrato) ? argumentos.contrato : {};

/**
 * Pendiente propio de ese id, con el turno como número. `Object.hasOwn` evita que un id como `constructor`
 * lea `Object.prototype` y salte el candado.
 */
export function pendienteDe(pendientes: Pendientes, id: string | null): Pendiente | null {
  if (id === null || !Object.hasOwn(pendientes, id)) return null;
  const p: unknown = pendientes[id];
  return esObjeto(p) && typeof p.turno === "number" ? (p as unknown as Pendiente) : null;
}

/** Minúsculas y sin tildes, para comparar el texto libre de la analista. */
const normalizar = (texto: string): string => texto.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();

/** ¿El mensaje de la analista confirma? Afirma algo y no contiene ninguna negación (CA3). */
export function mensajeConfirma(mensaje: string): boolean {
  const t = normalizar(mensaje);
  return AFIRMACION.test(t) && !NEGACION.test(t);
}

/** Números del texto sin separadores de miles («$1.500.000» → «1500000»). */
function numerosDe(texto: string): Set<string> {
  return new Set((texto.match(/\d[\d.,']*\d|\d/g) ?? []).map((n) => n.replace(/\D/g, "")));
}

/** Fechas del texto en AAAA-MM-DD, escritas así o como DD/MM/AAAA. */
function fechasDe(texto: string): Set<string> {
  const iso = texto.match(/\d{4}-\d{2}-\d{2}/g) ?? [];
  const dma = [...texto.matchAll(/\b(\d{1,2})[/-](\d{1,2})[/-](\d{4})\b/g)].map((m) => `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`);
  return new Set([...iso, ...dma]);
}

/** ¿La analista escribió ese valor en su mensaje? Números sin separadores, fechas normalizadas, texto sin tildes. */
function apareceEn(mensaje: string, valor: unknown): boolean {
  if (typeof valor === "number") return Number.isInteger(valor) ? numerosDe(mensaje).has(String(Math.abs(valor))) : mensaje.replaceAll(",", ".").includes(String(valor));
  if (typeof valor !== "string" || valor.trim() === "") return false;
  if (/^\d{4}-\d{2}-\d{2}$/.test(valor)) return fechasDe(mensaje).has(valor);
  return normalizar(mensaje).includes(normalizar(valor.trim()));
}

/** Campos de `contrato` cuyo valor no es el propuesto por la extracción ni aparece en el mensaje de la analista. */
function camposInventados(p: Pendiente, mensaje: string, argumentos: unknown): string[] {
  return Object.entries(contratoDe(argumentos))
    .filter(([campo, valor]) => valor !== undefined && p.propuestos[campo] !== String(valor) && !apareceEn(mensaje, valor))
    .map(([campo]) => campo);
}

/** Decisión del candado sobre una llamada (CA3, RN5). */
export type Decision =
  | { tipo: "ejecutar" }
  /** Sin pendiente: se ejecuta sin `confirmado` y `registrar` decide (escribe si está limpio o pide revisión). */
  | { tipo: "sin_confirmado" }
  | { tipo: "bloquear"; motivo: string };

/**
 * CA3, RN5: decide qué hacer con una llamada. Solo afecta a `contratos_registrar` con `confirmado: true`.
 * @param mensaje texto de la analista en el turno actual.
 * @returns `ejecutar`, `sin_confirmado` (mensaje sin pendiente) o `bloquear` con el motivo para el modelo y el log.
 */
export function decidirConfirmacion(pendientes: Pendientes, turno: number, mensaje: string, nombre: string, argumentos: unknown): Decision {
  if (nombre !== REGISTRAR || !confirma(argumentos)) return { tipo: "ejecutar" };
  const p = pendienteDe(pendientes, mensajeIdDe(argumentos));
  if (p === null) return { tipo: "sin_confirmado" };
  if (p.turno >= turno) return { tipo: "bloquear", motivo: MENSAJE_BLOQUEO };
  if (!mensajeConfirma(mensaje)) return { tipo: "bloquear", motivo: MENSAJE_SIN_CONFIRMACION };
  const inventados = camposInventados(p, mensaje, argumentos);
  if (inventados.length > 0) {
    return { tipo: "bloquear", motivo: `Valores que ni propuso la extracción ni escribió la analista: ${inventados.join(", ")}. Pregúntale por ellos y termina el turno.` };
  }
  return { tipo: "ejecutar" };
}

function leer(contenido: string): ResultadoLeido | null {
  try {
    const r = JSON.parse(contenido) as ResultadoLeido | null;
    return esObjeto(r) ? r : null;
  } catch {
    return null;
  }
}

/** Campos en revisión del resultado: los de `validar`, o los del error «requiere revisión: a, b» de `registrar` (RN5). */
function camposEnRevision(nombre: string, r: ResultadoLeido): string[] {
  if (nombre === VALIDAR && r.ok && r.data?.clasificacion !== "duplicado" && Array.isArray(r.data?.requiere_revision)) {
    return r.data.requiere_revision.filter((c): c is string => typeof c === "string");
  }
  if (nombre === REGISTRAR && !r.ok && typeof r.error === "string" && r.error.startsWith("requiere revisión")) {
    return r.error.replace(/^requiere revisión:?/, "").split(",").map((c) => c.trim()).filter(Boolean);
  }
  return [];
}

/** Valores propuestos por la extracción: la `propuesta` de `validar` sin los campos que el modelo corrigió en la llamada. */
function propuestosDe(r: ResultadoLeido, argumentos: unknown): Record<string, string> {
  const propuesta = r.data?.propuesta;
  if (!esObjeto(propuesta)) return {};
  const corregidos = contratoDe(argumentos);
  const pares = Object.entries(propuesta).filter(([k, v]) => typeof v === "string" && !Object.hasOwn(corregidos, k));
  return Object.fromEntries(pares) as Record<string, string>;
}

/**
 * Actualiza los pendientes de la sesión con el resultado de una herramienta (CA3).
 * Un pendiente conserva el turno en que se creó: volver a validar tras la confirmación no lo «rejuvenece»,
 * porque eso bloquearía el flujo legítimo validar(corregido) → registrar(confirmado). Un registro exitoso
 * o un `validar` que da duplicado (RN1: no hay nada que escribir) lo borra.
 */
export function actualizarPendientes(pendientes: Pendientes, turno: number, nombre: string, argumentos: unknown, contenido: string): void {
  const id = mensajeIdDe(argumentos);
  const r = leer(contenido);
  if (id === null || r === null) return;
  if ((nombre === REGISTRAR && r.ok) || (nombre === VALIDAR && r.ok && r.data?.clasificacion === "duplicado")) {
    delete pendientes[id];
    return;
  }
  const campos = camposEnRevision(nombre, r);
  if (campos.length === 0) return;
  const propuestos = propuestosDe(r, argumentos);
  const previo = pendienteDe(pendientes, id);
  if (previo === null) pendientes[id] = { turno, campos, propuestos };
  else previo.propuestos = { ...propuestos, ...previo.propuestos };
}
