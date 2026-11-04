/**
 * CA3 en código: `confirmado: true` solo vale si la revisión de ese mensaje se pidió en un turno ANTERIOR,
 * si el mensaje de la analista de ESTE turno confirma (y no niega), y si cada valor que el modelo manda
 * es el que propuso la extracción o la analista lo escribió. Con varios pendientes, la analista tiene que
 * nombrar el mensaje que confirma. El prompt pide lo mismo; esto lo garantiza aunque el modelo obedezca a
 * una instrucción inyectada o «redondee» un valor (PRD §10 Riesgo).
 */

/** Resultado que recibe el modelo cuando intenta confirmar en el mismo turno. */
export const MENSAJE_BLOQUEO =
  "La confirmación debe venir de la analista en un mensaje nuevo: muéstrale los campos en revisión, pregúntale y termina el turno.";

/** Resultado cuando el mensaje de la analista no confirma o niega (CA3). */
export const MENSAJE_SIN_CONFIRMACION =
  "La analista no confirmó en su último mensaje (o lo negó): no se registra. Pregúntale de nuevo y termina el turno.";

/** Resultado cuando hay varios pendientes y la analista no dijo de cuál habla (CA3). */
export const MENSAJE_PRECISAR =
  "Hay varios mensajes en revisión y la analista no nombró este: pídele que precise el mensaje (msg-00X), el id del contrato o el cliente que confirma, y termina el turno.";

/** Pendiente de confirmación de un mensaje del buzón (CA3, RN5). */
export interface Pendiente {
  /** Turno en que se pidió la revisión. */
  turno: number;
  /** Campos en `requiere_revision`. */
  campos: string[];
  /** Valores que propuso la extracción, en el formato de texto del maestro; solo los que no corrigió el modelo. */
  propuestos: Record<string, string>;
  /** Id del contrato y cliente propuestos: con varios pendientes, la analista puede nombrar el mensaje por ellos. */
  referencias?: string[];
}

/** Pendientes de una sesión: `mensaje_id` → pendiente. */
export type Pendientes = Record<string, Pendiente>;

const VALIDAR = "contratos_validar";
const REGISTRAR = "contratos_registrar";
/** «Sí» solo cuenta suelto («Sí», «sí, de acuerdo»): «si el valor es 0…» es una condición, no una confirmación. */
const AFIRMACION = /\b(confirm\w*|apruebo|aprobado|de acuerdo|correcto|adelante)\b|\bsi\s*(?:[,.;!]|$)/;
/** Verbos de acción: solo confirman si el mensaje nombra algo concreto (un valor, una fecha, un msg-00X). */
const ACCION = /\b(registr\w*|proced\w*)\b/;
/** Negaciones ligadas al verbo, aplazamientos y delegaciones vagas; «confirmo, no hay problema» no niega nada. */
const NEGACION = [
  /\b(no|nunca|jamas|tampoco)\s+(?:(?:lo|la|los|las|le|les|me|te|se|nos|todavia|aun|ya)\s+)*(?:confirm|registr|aprue|aprob|proced|guard|continu|sigas|estoy de acuerdo|es correcto|esta bien)/,
  /\b(todavia|aun)\s+(?:no\b|(?:lo|la|los|las)\s+(?:revis|verific|mir|chequ|valid|estudi))/,
  /\bno\s*(?:[,.;!]|$)/,
  /\blo que (?:te|le|se|usted|tu)?\s*(?:de la gana|parezca|quieras|quiera|sea)\b|\bcomo (?:quieras|quiera|veas|te parezca)\b/,
];
/** Id de contrato del maestro (`CT-2026-015`, `CM-2026-03`, `AUTO-2026-001`). */
const ID_CONTRATO = /^[A-Z]{2,4}-\d{4}-\d{1,4}$/;
/** Fechas e identificadores (`msg-006`, `CM-2026-03`): sus partes no cuentan como números escritos por la analista. */
const SIN_NUMEROS = /\b\d{4}-\d{1,2}-\d{1,2}\b|\b\d{1,2}[/-]\d{1,2}[/-]\d{4}\b|\b[a-z]{2,5}-\d+(?:-\d+)*\b/gi;
const RAZON_SOCIAL = /[\s,]+(?:s\.?\s?a\.?\s?s\.?|s\.?\s?a\.?|ltda\.?|e\.?\s?s\.?\s?p\.?)\s*$/i;

interface ResultadoLeido {
  ok: boolean;
  data?: { requiere_revision?: unknown; clasificacion?: unknown; propuesta?: unknown };
  error?: unknown;
}

const esObjeto = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

const esPendiente = (v: unknown): v is Pendiente =>
  esObjeto(v) && typeof v.turno === "number" && Array.isArray(v.campos) && esObjeto(v.propuestos);

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
 * Pendiente propio de ese id, con su forma validada. `Object.hasOwn` evita que un id como `constructor`
 * lea `Object.prototype` y salte el candado (CA3).
 */
export function pendienteDe(pendientes: Pendientes, id: string | null): Pendiente | null {
  if (id === null || !Object.hasOwn(pendientes, id)) return null;
  const p: unknown = pendientes[id];
  return esPendiente(p) ? p : null;
}

/** Minúsculas y sin tildes, para comparar el texto libre de la analista. */
const normalizar = (texto: string): string => texto.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();

/** Quita las preguntas («¿…?» o una frase que termina en «?»): una pregunta nunca confirma. */
const sinPreguntas = (texto: string): string => texto.replace(/¿[^?]*\?|[^.;!?¿\n]*\?/g, " ");

/**
 * ¿El mensaje de la analista confirma? (CA3) Afirma, o pide registrar nombrando algo concreto, y no niega
 * el verbo, no aplaza ni delega. Las preguntas no cuentan.
 */
export function mensajeConfirma(mensaje: string): boolean {
  const t = sinPreguntas(normalizar(mensaje));
  if (NEGACION.some((r) => r.test(t))) return false;
  return AFIRMACION.test(t) || (ACCION.test(t) && /\d/.test(t));
}

/** ¿`valor` aparece en `texto` como palabra completa? Sin tildes ni mayúsculas. */
function contienePalabra(texto: string, valor: string): boolean {
  const v = normalizar(valor.trim()).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return v !== "" && new RegExp(`(?<![\\p{L}\\p{N}])${v}(?![\\p{L}\\p{N}])`, "u").test(normalizar(texto));
}

/** Números del texto sin fechas ni identificadores, con sus separadores («$1.500.000», «1,5»). */
const numerosDe = (texto: string): string[] => texto.replace(SIN_NUMEROS, " ").match(/\d[\d.,']*\d|\d/g) ?? [];

/** ¿La analista escribió ese número? Enteros sin separadores de miles; decimales con coma o punto. */
function escribioNumero(mensaje: string, valor: number): boolean {
  const numeros = numerosDe(mensaje);
  if (Number.isInteger(valor)) return numeros.some((n) => n.replace(/\D/g, "") === String(Math.abs(valor)));
  return numeros.some((n) => Number(n.replace(",", ".")) === valor);
}

/** Fechas del texto en YYYY-MM-DD, escritas así o como DD/MM/YYYY. */
function fechasDe(texto: string): Set<string> {
  const iso = texto.match(/\d{4}-\d{2}-\d{2}/g) ?? [];
  const dma = [...texto.matchAll(/\b(\d{1,2})[/-](\d{1,2})[/-](\d{4})\b/g)].map((m) => `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`);
  return new Set([...iso, ...dma]);
}

/** ¿La analista escribió ese texto? Palabra completa de 3 o más caracteres; un id de contrato, con su patrón. */
function escribioTexto(mensaje: string, campo: string, valor: string): boolean {
  if (/^\d{4}-\d{2}-\d{2}$/.test(valor)) return fechasDe(mensaje).has(valor);
  if (valor.trim().length < 3 || (campo === "id_contrato" && !ID_CONTRATO.test(valor.trim()))) return false;
  return contienePalabra(mensaje, valor);
}

/** ¿La analista escribió el valor de ese campo en su mensaje? (CA3) */
function apareceEn(mensaje: string, campo: string, valor: unknown): boolean {
  if (typeof valor === "number") return escribioNumero(mensaje, valor);
  return typeof valor === "string" && escribioTexto(mensaje, campo, valor);
}

/** Campos de `contrato` cuyo valor no es el propuesto por la extracción ni aparece en el mensaje de la analista. */
function camposInventados(p: Pendiente, mensaje: string, argumentos: unknown): string[] {
  return Object.entries(contratoDe(argumentos))
    .filter(([campo, valor]) => valor !== undefined && p.propuestos[campo] !== String(valor) && !apareceEn(mensaje, campo, valor))
    .map(([campo]) => campo);
}

/** Frases del mensaje: corta en punto, punto y coma, signos y saltos de línea, nunca en «1.500.000». */
const frasesDe = (mensaje: string): string[] => mensaje.split(/[.;!?]+(?=\s|$)|\n/).map((f) => f.trim()).filter(Boolean);

const referenciasDe = (pendientes: Pendientes, id: string): string[] => [id, ...(pendienteDe(pendientes, id)?.referencias ?? [])];

const nombra = (frase: string, referencias: string[]): boolean => referencias.some((r) => contienePalabra(frase, r));

/**
 * CA3 con varios pendientes: el texto que habla de ESTE mensaje (las frases que lo nombran y las que no nombran
 * a ningún otro pendiente), o `null` si la analista no lo nombra. Con un solo pendiente, el mensaje entero.
 */
function textoSobre(pendientes: Pendientes, id: string, mensaje: string): string | null {
  const otros = Object.keys(pendientes).filter((o) => o !== id);
  if (otros.length === 0) return mensaje;
  const ajenas = otros.flatMap((o) => referenciasDe(pendientes, o));
  // Una referencia compartida (dos contratos del mismo cliente) no identifica a ninguno.
  const propias = referenciasDe(pendientes, id).filter((r) => !ajenas.includes(r));
  const frases = frasesDe(mensaje);
  if (!frases.some((f) => nombra(f, propias))) return null;
  return frases.filter((f) => nombra(f, propias) || !nombra(f, ajenas)).join(". ");
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
 * @param alInicio pendientes al empezar el turno: registrar uno no deja al otro como único y confirmado con el mismo texto.
 * @returns `ejecutar`, `sin_confirmado` (mensaje sin pendiente) o `bloquear` con el motivo para el modelo y el log.
 */
export function decidirConfirmacion(
  pendientes: Pendientes,
  turno: number,
  mensaje: string,
  nombre: string,
  argumentos: unknown,
  alInicio: Pendientes = pendientes,
): Decision {
  if (nombre !== REGISTRAR || !confirma(argumentos)) return { tipo: "ejecutar" };
  const id = mensajeIdDe(argumentos);
  const p = pendienteDe(pendientes, id);
  if (id === null || p === null) return { tipo: "sin_confirmado" };
  if (p.turno >= turno) return { tipo: "bloquear", motivo: MENSAJE_BLOQUEO };
  const texto = textoSobre({ ...alInicio, ...pendientes }, id, mensaje);
  if (texto === null) return { tipo: "bloquear", motivo: MENSAJE_PRECISAR };
  if (!mensajeConfirma(texto)) return { tipo: "bloquear", motivo: MENSAJE_SIN_CONFIRMACION };
  const inventados = camposInventados(p, texto, argumentos);
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

/** Id de contrato y cliente (sin «S.A.S.» ni «Ltda.») de la `propuesta`, para nombrar el mensaje sin su msg-00X. */
function referenciasDePropuesta(r: ResultadoLeido): string[] {
  const p = r.data?.propuesta;
  if (!esObjeto(p)) return [];
  const id = typeof p.id_contrato === "string" && ID_CONTRATO.test(p.id_contrato) ? [p.id_contrato] : [];
  const cliente = typeof p.cliente === "string" ? [p.cliente.replace(RAZON_SOCIAL, "").trim()] : [];
  return [...id, ...cliente].filter((x) => x.length >= 3);
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
  const referencias = referenciasDePropuesta(r);
  const previo = pendienteDe(pendientes, id);
  if (previo === null) {
    pendientes[id] = { turno, campos, propuestos, referencias };
    return;
  }
  previo.propuestos = { ...propuestos, ...previo.propuestos };
  previo.referencias = [...new Set([...(previo.referencias ?? []), ...referencias])];
}
