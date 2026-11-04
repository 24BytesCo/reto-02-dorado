import { z } from "zod";
import { esModificacion, normalizar, fechaIso, type Extraccion, type TipoDocumento } from "./extraccion.ts";
import { CAMPOS_CON_CONFIANZA, MONEDAS, PAISES, REGLAS, type CampoConConfianza, type FilaMaestro } from "./reglas.ts";

/**
 * Lógica pura de clasificación de un contrato contra el maestro (PRD §7.3, RN1-RN5, HU-3).
 * No lee ni escribe archivos: recibe la extracción, las correcciones y las filas del maestro.
 */

/** Las cuatro clasificaciones de HU-3, sin tildes, tal como las nombra el PRD. */
export type Clasificacion = "nuevo" | "actualizacion" | "duplicado" | "rechazado";

/** Cambio de un campo entre la fila del maestro y el documento (RN2). */
export type Diferencias = Record<string, { antes: string; despues: string }>;

/** Campo en revisión que la analista confirmó: lo que propuso la herramienta y lo que quedó (CA2, HU-4). */
export type Confirmados = Record<string, { propuesto: string | null; confirmado: string }>;

/**
 * Esquema de los valores corregidos por la analista o el modelo: todos opcionales y planos.
 * Lo omitido toma lo extraído por `contratos_extraer` (HU-2: el valor final pasa por `contratos_validar`).
 */
export const esquemaContratoCorregido = z.object({
  id_contrato: z.string().optional().describe("Número del contrato tal como aparece en el documento (letras, números y guiones)"),
  cliente: z.string().optional().describe("Razón social de la contraparte"),
  nit_cliente: z.string().optional().describe("Identificador tributario sin dígito de verificación ni puntos"),
  pais: z.string().optional().describe(`País de la contraparte: ${PAISES.join(", ")}`),
  objeto: z.string().optional().describe("Objeto del contrato, máximo 200 caracteres"),
  valor: z.number().optional().describe("Valor total sin separadores; 0 si el contrato es por demanda"),
  moneda: z.string().optional().describe(`Moneda del valor: ${MONEDAS.join(", ")}`),
  fecha_inicio: z.string().optional().describe("Fecha de inicio en formato YYYY-MM-DD"),
  fecha_fin: z.string().optional().describe("Fecha de fin en formato YYYY-MM-DD"),
  requiere_poliza: z.boolean().optional().describe("true si el contrato exige póliza"),
  tipo_poliza: z.string().optional().describe("Tipos de póliza separados por ';'; vacío si no requiere"),
});
export type ContratoCorregido = z.infer<typeof esquemaContratoCorregido>;

type ValoresFinales = Record<CampoConConfianza, string>;

/** Valor plano en el formato de texto del maestro: `null` → vacío, booleanos `true`/`false`, números sin separadores. */
export function aTexto(v: string | number | boolean | null | undefined): string {
  if (v === null || v === undefined) return "";
  return String(v);
}

// ── Validación de las correcciones (HU-6: errores legibles) ──

function validarFecha(campo: string, valor: string): void {
  const m = valor.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) throw new Error(`${campo} inválida: «${valor}» (se espera YYYY-MM-DD)`);
  fechaIso(Number(m[1]), Number(m[2]), Number(m[3]));
}

/**
 * Rechaza valores corregidos que no cumplen el esquema del maestro (§7.2, HU-6).
 * @throws Error legible con el campo y el valor que fallaron.
 */
export function validarCorregido(c: ContratoCorregido): void {
  // El id termina en una ruta de archivo: solo caracteres seguros para no salir de la carpeta.
  if (c.id_contrato !== undefined && !/^[A-Za-z0-9][\w-]*$/.test(c.id_contrato)) {
    throw new Error(`id_contrato inválido: «${c.id_contrato}» (solo letras, números y guiones)`);
  }
  if (c.moneda !== undefined && !(MONEDAS as readonly string[]).includes(c.moneda)) {
    throw new Error(`moneda desconocida: ${c.moneda} (se aceptan ${MONEDAS.join(", ")})`);
  }
  if (c.pais !== undefined && !(PAISES as readonly string[]).includes(c.pais)) {
    throw new Error(`país desconocido: ${c.pais} (se aceptan ${PAISES.join(", ")})`);
  }
  if (c.valor !== undefined && !(Number.isFinite(c.valor) && c.valor >= 0)) throw new Error(`valor inválido: ${c.valor} (número mayor o igual a 0)`);
  if (c.objeto !== undefined && c.objeto.length > 200) throw new Error("objeto inválido: supera los 200 caracteres");
  if (c.fecha_inicio !== undefined) validarFecha("fecha_inicio", c.fecha_inicio);
  if (c.fecha_fin !== undefined) validarFecha("fecha_fin", c.fecha_fin);
}

// ── Similitud de objeto (RN2, supuesto S8) ──

/** Palabras que no distinguen un objeto de otro: artículos, preposiciones y las fórmulas genéricas de todo contrato. */
const PALABRAS_VACIAS = new Set([
  "a", "al", "con", "de", "del", "e", "el", "en", "la", "las", "lo", "los", "o", "para", "por", "se", "su", "sus", "u", "un", "una", "y",
  "contratante", "contratista", "servicio", "parte", "presente", "contrato", "prestacion",
]);

/** Singular aproximado: «plataformas» → «plataforma», «migraciones» → «migracion». Basta para que el plural no cuente como otra palabra. */
function singular(t: string): string {
  if (t.length <= 3) return t;
  if (/[lnrdzj]es$/.test(t)) return t.slice(0, -2);
  return t.endsWith("s") ? t.slice(0, -1) : t;
}

/** Tokens de un objeto: minúsculas, sin tildes, sin signos, en singular y sin palabras vacías. */
export function tokensObjeto(texto: string): Set<string> {
  return new Set(normalizar(texto).split(/[^a-z0-9]+/).filter(Boolean).map(singular).filter((t) => !PALABRAS_VACIAS.has(t)));
}

/** Similitud de Jaccard entre dos objetos: tokens en común sobre tokens totales, en [0, 1] (RN2). */
export function similitudObjeto(a: string, b: string): number {
  const ta = tokensObjeto(a);
  const tb = tokensObjeto(b);
  const comunes = [...ta].filter((t) => tb.has(t)).length;
  const union = ta.size + tb.size - comunes;
  return union === 0 ? 0 : comunes / union;
}

// ── Valores finales y revisión (RN5, CA2) ──

/** Campos que el documento trae (valor extraído no nulo) o que la analista corrigió. */
function camposTraidos(ext: Extraccion, c: ContratoCorregido): CampoConConfianza[] {
  return CAMPOS_CON_CONFIANZA.filter((k) => ext.contrato[k].valor !== null || c[k] !== undefined);
}

/** Valor final de cada campo: lo corregido si viene, si no lo extraído. */
function valoresFinales(ext: Extraccion, c: ContratoCorregido): ValoresFinales {
  const pares = CAMPOS_CON_CONFIANZA.map((k) => [k, aTexto(c[k] !== undefined ? c[k] : ext.contrato[k].valor)]);
  return Object.fromEntries(pares) as ValoresFinales;
}

/**
 * Campos que exigen confirmación humana (RN5, CA2): confianza < umbral (en un otrosí o un acta, solo los que trae)
 * y todo valor corregido que difiera de lo extraído, porque no salió de una herramienta.
 */
export function camposEnRevision(ext: Extraccion, c: ContratoCorregido): CampoConConfianza[] {
  const evaluables = esModificacion(ext.tipo_documento) ? camposTraidos(ext, c) : CAMPOS_CON_CONFIANZA;
  return CAMPOS_CON_CONFIANZA.filter((k) => {
    const dudoso = evaluables.includes(k) && ext.contrato[k].confianza < REGLAS.umbralConfianza;
    const corregido = c[k] !== undefined && aTexto(c[k]) !== aTexto(ext.contrato[k].valor);
    return dudoso || corregido;
  });
}

/**
 * CA2 al confirmar: campos corregidos que la extracción, sin correcciones, no había puesto en revisión.
 * La confirmación humana solo cubre lo que se le preguntó; cualquier otro cambio es un valor que no salió de una herramienta.
 */
export function correccionesFueraDeRevision(ext: Extraccion, c: ContratoCorregido): CampoConConfianza[] {
  const enRevision = camposEnRevision(ext, {});
  return CAMPOS_CON_CONFIANZA.filter((k) => c[k] !== undefined && aTexto(c[k]) !== aTexto(ext.contrato[k].valor) && !enRevision.includes(k));
}

/** Lo propuesto por la herramienta y lo que queda en cada campo en revisión, para el historial (HU-4). */
export function confirmadosDe(ext: Extraccion, revision: string[], fila: FilaMaestro): Confirmados {
  const campos = CAMPOS_CON_CONFIANZA.filter((k) => revision.includes(k));
  return Object.fromEntries(campos.map((k) => {
    const extraido = ext.contrato[k].valor;
    return [k, { propuesto: extraido === null ? null : aTexto(extraido), confirmado: fila[k] }];
  }));
}

// ── Coincidencia con el maestro (RN1, RN2) ──

interface Coincidencia {
  fila: FilaMaestro;
  por: "id" | "nit_objeto";
  similitud?: number;
}

/** Fila del maestro con el mismo id o, en un contrato, con el mismo NIT y objeto similar. Nunca solo por NIT (S7). */
function buscarCoincidencia(v: ValoresFinales, tipo: TipoDocumento, maestro: FilaMaestro[]): Coincidencia | null {
  const porId = v.id_contrato ? maestro.find((f) => f.id_contrato === v.id_contrato) : undefined;
  if (porId) return { fila: porId, por: "id" };
  if (esModificacion(tipo) || !v.nit_cliente || !v.objeto) return null;
  for (const fila of maestro.filter((f) => f.nit_cliente === v.nit_cliente)) {
    const similitud = similitudObjeto(fila.objeto, v.objeto);
    if (similitud >= REGLAS.similitudObjeto) return { fila, por: "nit_objeto", similitud };
  }
  return null;
}

/** Choques de identidad con la fila encontrada (S5): otro NIT u otra moneda. Otro id con mismo NIT y objeto es una renovación. */
function conflictos(v: ValoresFinales, co: Coincidencia): string[] {
  const lista: string[] = [];
  for (const k of ["nit_cliente", "moneda"] as const) {
    if (v[k] && co.fila[k] && v[k] !== co.fila[k]) lista.push(`conflicto: ${k}`);
  }
  return lista;
}

/** Cambios de los campos que el documento trae; los ausentes heredan la fila (RN2). Más el supuesto S3 de póliza. */
function calcularDiferencias(fila: FilaMaestro, v: ValoresFinales, traidos: CampoConConfianza[]): Diferencias {
  const d: Diferencias = {};
  for (const k of traidos) if (k !== "id_contrato" && v[k] !== fila[k]) d[k] = { antes: fila[k], despues: v[k] };
  const conPoliza = (d.requiere_poliza?.despues ?? fila.requiere_poliza) === "true";
  const extiende = d.fecha_fin !== undefined && d.fecha_fin.despues > d.fecha_fin.antes;
  const sube = d.valor !== undefined && Number(d.valor.despues) > Number(d.valor.antes);
  // S3: una garantía exigida debe ampliarse cuando crecen plazo o valor; hasta constituirla queda pendiente.
  if (conPoliza && (extiende || sube) && fila.estado_poliza !== "pendiente") {
    d.estado_poliza = { antes: fila.estado_poliza, despues: "pendiente" };
  }
  return d;
}

// ── Clasificación completa ──

/** Datos de la clasificación que no salen del texto del contrato sino del correo y del catálogo. */
export interface EntradaClasificacion {
  extraccion: Extraccion;
  corregido: ContratoCorregido;
  /** Nombre resuelto desde `comerciales.json`, o vacío si el remitente no está (HU-3). */
  comercial: string;
  /** Fecha de recepción del correo (supuesto S9). */
  fecha_registro: string;
  maestro: FilaMaestro[];
}

/** Resultado de `contratos_validar` sin el envoltorio de la herramienta (HU-3). */
export interface ResultadoClasificacion {
  clasificacion: Clasificacion;
  id_contrato_existente?: string;
  requiere_revision: string[];
  diferencias?: Diferencias;
  motivo?: string;
  advertencias: string[];
  /** Fila del maestro que se escribiría; `null` si se rechaza. */
  propuesta: FilaMaestro | null;
  /** `true` si el mensaje no se marca procesado: queda en el buzón para escalarlo (otrosí sin contrato base). */
  pendiente?: boolean;
}

/** Rechazo con motivo y sin propuesta (RN4). */
export function rechazo(motivo: string, advertencias: string[] = []): ResultadoClasificacion {
  return { clasificacion: "rechazado", requiere_revision: [], motivo, advertencias, propuesta: null };
}

/**
 * RN4: solo se rechaza un texto sin partes NI objeto identificables. Si falta uno de los dos, el campo
 * ausente queda en null con confianza 0 y entra a revisión, para no perder un contrato válido (O1).
 * Un otrosí nunca trae objeto: sin partes se rechaza.
 */
function motivoRN4(v: ValoresFinales): string | null {
  if (!v.cliente && !v.nit_cliente && !v.objeto) return "el documento no identifica a las partes ni el objeto del contrato";
  return null;
}

/** Id para un contrato sin número: `AUTO-<año>-<secuencia de 3 dígitos>`, siguiente al mayor ya usado (§7.2). */
export function idAutomatico(anio: string, maestro: FilaMaestro[]): string {
  const prefijo = `AUTO-${anio}-`;
  const usados = maestro.filter((f) => f.id_contrato.startsWith(prefijo)).map((f) => Number(f.id_contrato.slice(prefijo.length)) || 0);
  return `${prefijo}${String(Math.max(0, ...usados) + 1).padStart(3, "0")}`;
}

/** Fila nueva (RN3): estado de póliza según requiere_poliza, fuente buzón y fecha de registro del correo. */
function filaNueva(v: ValoresFinales, e: EntradaClasificacion): FilaMaestro {
  const anio = (v.fecha_inicio || e.fecha_registro).slice(0, 4);
  return {
    ...v,
    id_contrato: v.id_contrato || idAutomatico(anio, e.maestro),
    estado_poliza: v.requiere_poliza === "true" ? "pendiente" : "no_aplica",
    comercial: e.comercial,
    ruta_sharepoint: "",
    fecha_registro: e.fecha_registro,
    fuente: "buzon",
  };
}

/** Una fila con la fecha de fin antes del inicio corrompería las alertas (HU-5): se rechaza con error legible. */
function verificarFechas(fila: FilaMaestro): void {
  if (fila.fecha_inicio && fila.fecha_fin && fila.fecha_fin < fila.fecha_inicio) {
    throw new Error(`fecha_fin ${fila.fecha_fin} es anterior a fecha_inicio ${fila.fecha_inicio}`);
  }
}

/**
 * S2: el id ya es de otro cliente. Pisar la fila borraría un contrato ajeno, así que no hay propuesta ni confirmación
 * que lo permita: queda pendiente en el buzón (no se marca procesado) hasta que la analista corrija el id o lo escale.
 */
function idDeOtroCliente(v: ValoresFinales, e: EntradaClasificacion, co: Coincidencia): ResultadoClasificacion {
  const motivo = `el id ${co.fila.id_contrato} ya pertenece a ${co.fila.cliente} (NIT ${co.fila.nit_cliente}) y el documento es de NIT ${v.nit_cliente}: `
    + "no se puede sobrescribir ni confirmando; corrige id_contrato si es otro contrato o escálalo. Queda pendiente en el buzón";
  return { ...rechazo(motivo, e.extraccion.advertencias), id_contrato_existente: co.fila.id_contrato, pendiente: true };
}

/** RN1 o RN2 frente a una fila existente; un otrosí o acta sin cambios es un duplicado (reaplicarlo no escribe). */
function frenteAExistente(v: ValoresFinales, e: EntradaClasificacion, co: Coincidencia, revision: string[]): ResultadoClasificacion {
  const choques = conflictos(v, co);
  if (choques.includes("conflicto: nit_cliente")) return idDeOtroCliente(v, e, co);
  const diferencias = calcularDiferencias(co.fila, v, camposTraidos(e.extraccion, e.corregido));
  const mismasFechasYValor = (["valor", "fecha_inicio", "fecha_fin"] as const).every((k) => v[k] === co.fila[k]);
  const sinCambios = Object.keys(diferencias).length === 0;
  const rn1 = esModificacion(e.extraccion.tipo_documento) ? sinCambios : mismasFechasYValor || sinCambios;
  const base = { id_contrato_existente: co.fila.id_contrato, advertencias: [...e.extraccion.advertencias] };
  if (co.por === "nit_objeto") {
    base.advertencias.push(`Coincide por NIT y objeto (similitud ${co.similitud?.toFixed(2)}) con ${co.fila.id_contrato}.`);
  }
  // RN1: en un duplicado no se escribe nada, así que no hay nada que confirmar.
  if (rn1 && choques.length === 0) return { ...base, clasificacion: "duplicado", requiere_revision: [], propuesta: co.fila };
  const propuesta = { ...co.fila, ...Object.fromEntries(Object.entries(diferencias).map(([k, d]) => [k, d.despues])) };
  verificarFechas(propuesta);
  return { ...base, clasificacion: "actualizacion", requiere_revision: [...revision, ...choques], diferencias, propuesta };
}

/** Un otrosí o un acta sin contrato base no se registra ni se marca procesado: queda en el buzón para escalarlo. */
function modificacionSinBase(v: ValoresFinales, e: EntradaClasificacion): ResultadoClasificacion {
  const documento = e.extraccion.tipo_documento === "acta" ? "el acta de terminación" : "el otrosí";
  const motivo = `${documento} modifica el contrato ${v.id_contrato || "sin número"}, que no está en el maestro: `
    + "no se registra ni se marca procesado; queda pendiente en el buzón para escalarlo o esperar el contrato base";
  return { ...rechazo(motivo, e.extraccion.advertencias), pendiente: true };
}

/**
 * S2: mismo NIT y objeto similar pero otro número de contrato explícito es otro contrato (una renovación), no una
 * actualización del existente: se clasifica como nuevo y se advierte, para no pisar la fila vigente.
 */
function esRenovacion(v: ValoresFinales, co: Coincidencia): boolean {
  return co.por === "nit_objeto" && Boolean(v.id_contrato) && v.id_contrato !== co.fila.id_contrato;
}

/** RN3: fila nueva con sus campos en revisión y las advertencias de la extracción. */
function clasificarNuevo(v: ValoresFinales, e: EntradaClasificacion, revision: string[], advertencias: string[]): ResultadoClasificacion {
  const propuesta = filaNueva(v, e);
  verificarFechas(propuesta);
  return { clasificacion: "nuevo", requiere_revision: revision, advertencias, propuesta };
}

/**
 * Campos en revisión más «firma» cuando el documento parece no firmado (regla de gobierno): un borrador o una
 * propuesta no se registra sin que la analista confirme que es la versión firmada.
 */
function revisionDe(e: EntradaClasificacion): string[] {
  const campos: string[] = camposEnRevision(e.extraccion, e.corregido);
  return e.extraccion.sin_firma ? [...campos, "firma"] : campos;
}

/**
 * Clasifica un documento contractual contra el maestro en el orden RN4 → RN1 → RN2 → RN3 (HU-3)
 * y arma la fila que se escribiría.
 * @throws Error legible si una corrección es inválida o las fechas no cuadran (HU-6).
 */
export function clasificar(e: EntradaClasificacion): ResultadoClasificacion {
  validarCorregido(e.corregido);
  const tipo = e.extraccion.tipo_documento;
  const v = valoresFinales(e.extraccion, e.corregido);
  const motivo = motivoRN4(v);
  if (motivo) return rechazo(motivo, e.extraccion.advertencias);
  const revision = revisionDe(e);
  const co = buscarCoincidencia(v, tipo, e.maestro);
  if (co && esRenovacion(v, co)) {
    const aviso = `Posible renovación de ${co.fila.id_contrato}: mismo NIT y objeto similar (${co.similitud?.toFixed(2)}) con otro número; se registra como contrato nuevo.`;
    return clasificarNuevo(v, e, revision, [...e.extraccion.advertencias, aviso]);
  }
  if (co) return frenteAExistente(v, e, co, revision);
  if (esModificacion(tipo)) return modificacionSinBase(v, e);
  return clasificarNuevo(v, e, revision, e.extraccion.advertencias);
}
