import { MONEDAS, REGLAS, type Moneda, type Pais } from "./reglas.ts";

/**
 * Extracción determinista sobre el texto de un contrato u otrosí (PRD §5 HU-2, P0).
 * Solo reglas genéricas sobre patrones del texto: ninguna regla depende de un mensaje concreto.
 */

/** Un dato extraído con su confianza en [0, 1] y la frase de donde salió. Ausente = `null` con confianza 0. */
export interface Campo<T> {
  valor: T | null;
  confianza: number;
  evidencia?: string;
}

const ausente = <T>(): Campo<T> => ({ valor: null, confianza: 0 });
const campo = <T>(valor: T, confianza: number, evidencia?: string): Campo<T> => ({
  valor,
  confianza,
  ...(evidencia ? { evidencia: recortar(evidencia, 140) } : {}),
});

/** Minúsculas y sin tildes, para comparar textos. */
export const normalizar = (s: string): string =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

const recortar = (s: string, max: number): string => {
  const limpio = s.replace(/\s+/g, " ").trim();
  if (limpio.length <= max) return limpio;
  const corte = limpio.slice(0, max + 1).replace(/\s+\S*$/, "");
  return corte.replace(/[,;:\s]+$/, "");
};

// ── Tipo de documento ──

/** Clase de documento contractual que reconoce el extractor (HU-1). Un acta de terminación modifica un contrato existente. */
export type TipoDocumento = "contrato" | "otrosi" | "acta";

/** Otrosí y acta modifican un contrato que ya existe: solo cuentan los campos que traen y nunca crean una fila (RN2). */
export const esModificacion = (tipo: TipoDocumento): boolean => tipo !== "contrato";

/** Cuántas líneas no vacías se revisan buscando el título: un membrete puede ir antes. */
const LINEAS_ENCABEZADO = 5;

interface Encabezado {
  tipo: TipoDocumento;
  /** Texto desde la línea del título en adelante (sin el membrete). */
  desdeTitulo: string;
}

/** Tipo según la línea del título. `\b` de JavaScript solo conoce letras ASCII: tras la «Í» de «OTROSÍ» nunca hay límite, por eso \p{L} con la bandera u. */
function tipoDeTitulo(linea: string): TipoDocumento | null {
  if (/^\s*OTROS[IÍ](?!\p{L})/iu.test(linea)) return "otrosi";
  if (/^\s*ACTA\s+DE\s+TERMINACI[OÓ]N(?!\p{L})/iu.test(linea)) return "acta";
  return /^\s*CONTRATO(?!\p{L})/iu.test(linea) ? "contrato" : null;
}

/** Título CONTRATO, OTROSÍ o ACTA DE TERMINACIÓN dentro de las primeras líneas no vacías del texto. */
function encabezado(texto: string): Encabezado | null {
  const lineas = texto.split("\n");
  let revisadas = 0;
  for (let i = 0; i < lineas.length && revisadas < LINEAS_ENCABEZADO; i++) {
    if (!lineas[i].trim()) continue;
    revisadas++;
    const tipo = tipoDeTitulo(lineas[i]);
    if (tipo) return { tipo, desdeTitulo: lineas.slice(i).join("\n") };
  }
  return null;
}

/**
 * Un adjunto es contractual si en sus primeras líneas se titula CONTRATO, OTROSÍ o ACTA DE TERMINACIÓN y nombra
 * a las partes: «Entre…», «entre las partes» o «Los suscritos…» (HU-1).
 */
export function tipoDocumento(texto: string): TipoDocumento | null {
  if (!/(?<!\p{L})(?:Entre|Los\s+suscritos)(?!\p{L})/iu.test(texto)) return null;
  return encabezado(texto)?.tipo ?? null;
}

// ── Firma ──

/** Marcas de un documento sin firmar en el membrete o el título: «BORRADOR», «PROPUESTA», «SIN FIRMA», «NO FIRMADA». */
const MARCA_ENCABEZADO = /(?<!\p{L})(?:borrador|propuesta|sin\s+firmas?|no\s+firmad[oa]|pendiente\s+de\s+firma)(?!\p{L})/iu;
/** Las mismas marcas en el cuerpo: solo en mayúsculas o inequívocas, porque «según la propuesta» es redacción normal. */
const MARCA_CUERPO = /(?<!\p{L})(?:BORRADOR|NO\s+FIRMAD[OA]|SIN\s+FIRMAS?|[Pp]endiente\s+de\s+firma|PENDIENTE\s+DE\s+FIRMA|[Ss]in\s+firmas)(?!\p{L})/u;
/** Cláusula de firma con espacios en blanco por llenar: «a los ____ días del mes de ______». */
const FIRMA_EN_BLANCO = /se\s+firma.{0,160}?_{3,}/i;

/**
 * Señal de que el documento no está firmado (regla de gobierno: solo se registra lo firmado), o `null`.
 * Un documento no firmado no se rechaza, porque es el contrato que viene; pero no se registra sin que la analista lo confirme.
 */
function senalSinFirma(texto: string): string | null {
  const desdeTitulo = encabezado(texto)?.desdeTitulo ?? texto;
  const membrete = texto.slice(0, texto.length - desdeTitulo.length) + (desdeTitulo.split("\n")[0] ?? "");
  const marca = membrete.match(MARCA_ENCABEZADO) ?? desdeTitulo.match(MARCA_CUERPO);
  if (marca) return `marca «${marca[0]}»`;
  return FIRMA_EN_BLANCO.test(texto.replace(/\s+/g, " ")) ? "la cláusula de firma tiene espacios en blanco (____)" : null;
}

/** Describe un adjunto que no es contrato, para el motivo del rechazo (RN4). */
export function describirNoContractual(texto: string): string {
  const encabezado = (texto.trim().split("\n")[0] ?? "").trim();
  if (/^COTIZACI[OÓ]N/i.test(encabezado)) return `es una cotización (${recortar(encabezado, 60)}), no un contrato firmado`;
  return encabezado ? `el adjunto no es un contrato («${recortar(encabezado, 60)}»)` : "el adjunto está vacío";
}

// ── Párrafos y cláusulas ──

const parrafos = (texto: string): string[] =>
  texto.split(/\n\s*\n/).map((p) => p.replace(/\s+/g, " ").trim()).filter(Boolean);

/**
 * Encabezado de cláusula sobre el texto normalizado: «PRIMERA. OBJETO.», «CLÁUSULA PRIMERA. OBJETO.»,
 * «PRIMERA: OBJETO DEL CONTRATO.», «1. OBJETO -». `nombre` es una expresión en minúsculas y sin tildes.
 */
const patronEncabezado = (nombre: string): RegExp =>
  new RegExp(`^(?:clausula\\s+)?(?:[a-z]+|\\d+)\\s*[.:\\-–]+\\s*(?:${nombre})(?:\\s+(?:del\\s+contrato|de\\s+ejecucion))?\\s*[.:\\-–]+\\s*`);

/** Párrafo de una cláusula («SEGUNDA. VALOR. …») o de su modificación en un otrosí («cláusula SEGUNDA (VALOR)»). */
function clausula(texto: string, nombre: string): string | null {
  const inicio = patronEncabezado(nombre);
  const modificada = new RegExp(`clausula\\s+\\w+\\s+\\((?:${nombre})\\)`);
  return parrafos(texto).find((p) => inicio.test(normalizar(p)) || modificada.test(normalizar(p))) ?? null;
}

/** El párrafo sin su encabezado de cláusula. Normalizar no cambia la longitud de un texto en NFC, así que se corta por posición. */
function sinEncabezado(parrafo: string, nombre: string): string {
  const m = normalizar(parrafo.normalize("NFC")).match(patronEncabezado(nombre));
  return m ? parrafo.normalize("NFC").trim().slice(m[0].length) : parrafo;
}

// ── Fechas ──

const MESES: Record<string, number> = {
  enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7,
  agosto: 8, septiembre: 9, setiembre: 9, octubre: 10, noviembre: 11, diciembre: 12,
};

const dosDigitos = (n: number) => String(n).padStart(2, "0");

/** Fecha ISO válida o error legible: el 31 de febrero no existe (HU-6). */
export function fechaIso(anio: number, mes: number, dia: number): string {
  const f = new Date(Date.UTC(anio, mes - 1, dia));
  if (f.getUTCFullYear() !== anio || f.getUTCMonth() !== mes - 1 || f.getUTCDate() !== dia) {
    throw new Error(`fecha inválida: ${dia}/${mes}/${anio}`);
  }
  return `${anio}-${dosDigitos(mes)}-${dosDigitos(dia)}`;
}

/** Último día de un mes. */
const finDeMes = (anio: number, mes: number): number => new Date(Date.UTC(anio, mes, 0)).getUTCDate();

/** Suma meses a una fecha ISO conservando el día (ajustado al fin de mes si no existe). */
export function sumarMeses(iso: string, meses: number): string {
  const [a, m, d] = iso.split("-").map(Number);
  const total = a * 12 + (m - 1) + meses;
  const anio = Math.floor(total / 12);
  const mes = (total % 12) + 1;
  return fechaIso(anio, mes, Math.min(d, finDeMes(anio, mes)));
}

interface FechaEnTexto {
  iso: string;
  indice: number;
}

/** Fechas escritas en español: «primero (1) de agosto de 2026», «14 de mayo de 2026». */
function fechasEn(texto: string): FechaEnTexto[] {
  const patron = /\(?\b(\d{1,2})\)?\s+de\s+([a-záéíóú]+)\s+del?\s+(\d{4})/gi;
  return [...texto.matchAll(patron)]
    .filter((m) => normalizar(m[2]) in MESES)
    .map((m) => ({ iso: fechaIso(Number(m[3]), MESES[normalizar(m[2])], Number(m[1])), indice: m.index ?? 0 }));
}

/** Fecha de firma: completa («a los treinta (30) días del mes de julio de 2026») o solo mes y año. */
function fechaFirma(texto: string): { iso: string; soloMes: boolean; evidencia: string } | null {
  const plano = texto.replace(/\s+/g, " ");
  const completa = plano.match(/se firma[^.]*?\((\d{1,2})\)\s+d[ií]as\s+del\s+mes\s+de\s+([a-záéíóú]+)\s+de\s+(\d{4})/i);
  if (completa && normalizar(completa[2]) in MESES) {
    return { iso: fechaIso(Number(completa[3]), MESES[normalizar(completa[2])], Number(completa[1])), soloMes: false, evidencia: completa[0] };
  }
  const mes = plano.match(/se firma[^.]*?en\s+el\s+mes\s+de\s+([a-záéíóú]+)\s+de\s+(\d{4})/i);
  if (mes && normalizar(mes[1]) in MESES) {
    const anio = Number(mes[2]);
    const m = MESES[normalizar(mes[1])];
    return { iso: fechaIso(anio, m, finDeMes(anio, m)), soloMes: true, evidencia: mes[0] };
  }
  return null;
}

interface Plazo {
  fecha_inicio: Campo<string>;
  fecha_fin: Campo<string>;
  advertencias: string[];
}

/**
 * Acta de terminación: la fecha desde la que termina el contrato es su nueva fecha de fin. Una terminación
 * anticipada cambia las alertas (HU-5), así que se propone con 0,7 y siempre pasa por la analista (RN5).
 */
function plazoDeActa(texto: string): Plazo {
  const parrafo = parrafos(texto).find((p) => /terminad|terminaci/i.test(p) && !/se firma/i.test(p) && fechasEn(p).length > 0);
  if (!parrafo) return { fecha_inicio: ausente(), fecha_fin: ausente(), advertencias: ["Acta de terminación sin fecha de terminación legible: la analista debe indicar la nueva fecha de fin."] };
  const fin = fechasEn(parrafo)[0].iso;
  return {
    fecha_inicio: ausente(),
    fecha_fin: campo(fin, 0.7, parrafo),
    advertencias: [`Acta de terminación: propone adelantar fecha_fin a ${fin}; se confirma con la analista antes de escribir.`],
  };
}

/**
 * Fechas del contrato a partir de la cláusula de PLAZO.
 * Explícitas («desde … hasta …») → confianza alta. Con plazo en meses y sin fecha de fin, la fecha de
 * fin se deriva (aniversario del inicio) y queda en revisión: se propone, no se afirma.
 */
function extraerPlazo(texto: string, tipo: TipoDocumento): Plazo {
  if (tipo === "acta") return plazoDeActa(texto);
  const parrafo = clausula(texto, "plazo") ?? "";
  const fechas = fechasEn(parrafo);
  // «a partir del 1 de septiembre» es un inicio explícito; «a partir de la fecha de su firma» se resuelve abajo.
  const iDesde = parrafo.search(/\bdesde\b|\ba partir del?\s+(?!la fecha)/i);
  const iHasta = parrafo.search(/\bhasta\b/i);
  const inicio = iDesde >= 0 ? fechas.find((f) => f.indice > iDesde && (iHasta < 0 || f.indice < iHasta)) : undefined;
  const fin = iHasta >= 0 ? fechas.find((f) => f.indice > iHasta) : undefined;
  const advertencias: string[] = [];
  const fecha_fin = fin ? campo(fin.iso, 0.95, parrafo) : ausente<string>();
  if (tipo === "otrosi") return { fecha_inicio: ausente(), fecha_fin, advertencias };

  let fecha_inicio = inicio ? campo(inicio.iso, 0.95, parrafo) : ausente<string>();
  if (!inicio && /a partir de la fecha de (su )?firma/i.test(parrafo)) {
    const firma = fechaFirma(texto);
    if (firma) {
      // 0,8 fijo y no el umbral: el día se deduce (fin de mes), pero el mes y el año están escritos. Si el umbral sube, este campo pasa a revisión.
      fecha_inicio = campo(firma.iso, firma.soloMes ? 0.8 : 0.9, firma.evidencia);
      if (firma.soloMes) advertencias.push(`La firma no indica el día («${recortar(firma.evidencia, 60)}»): se toma el último día del mes como inicio.`);
    }
  }
  const meses = parrafo.match(/\((\d{1,3})\)\s+meses|\b(\d{1,3})\s+meses/i);
  if (!fin && meses && fecha_inicio.valor) {
    const n = Number(meses[1] ?? meses[2]);
    advertencias.push(`La fecha de fin no está escrita: se calculó con el plazo de ${n} meses desde ${fecha_inicio.valor}.`);
    return { fecha_inicio, fecha_fin: campo(sumarMeses(fecha_inicio.valor, n), 0.5, parrafo), advertencias };
  }
  return { fecha_inicio, fecha_fin, advertencias };
}

// ── Valor y moneda ──

/**
 * El apóstrofo de millones («265'000.000», «1'200,000.00») equivale al separador de miles que le sigue;
 * sin otro separador después, es un punto.
 */
function sinApostrofo(s: string): string {
  const i = s.indexOf("'");
  if (i < 0) return s;
  const siguiente = s.slice(i + 1).match(/[.,]/)?.[0] ?? ".";
  return s.replace(/'/g, siguiente);
}

/** Convierte un monto con separadores colombianos («265.000.000», «265'000.000») o estadounidenses («120,000.00»). */
export function parsearMonto(crudo: string): number {
  const s = sinApostrofo(crudo.replace(/\s/g, ""));
  const ultimoPunto = s.lastIndexOf(".");
  const ultimaComa = s.lastIndexOf(",");
  let normal: string;
  if (ultimoPunto >= 0 && ultimaComa >= 0) {
    const decimal = ultimoPunto > ultimaComa ? "." : ",";
    const miles = decimal === "." ? "," : ".";
    normal = s.split(miles).join("").replace(decimal, ".");
  } else if (ultimoPunto >= 0) {
    normal = /^\d{1,3}(\.\d{3})+$/.test(s) ? s.replace(/\./g, "") : s;
  } else if (ultimaComa >= 0) {
    normal = /^\d{1,3}(,\d{3})+$/.test(s) ? s.replace(/,/g, "") : s.replace(",", ".");
  } else normal = s;
  const n = Number(normal);
  if (!Number.isFinite(n)) throw new Error(`monto inválido: ${crudo}`);
  return n;
}

const PALABRAS_MONEDA: Array<[RegExp, Moneda]> = [
  [/\bpesos\b/i, "COP"], [/\bd[oó]lares\b/i, "USD"], [/\bsoles\b/i, "PEN"], [/\bbalboas\b/i, "PAB"], [/\blempiras\b/i, "HNL"],
];
const MONEDA_POR_PAIS: Record<Pais, Moneda> = { CO: "COP", EC: "USD", PE: "PEN", PA: "PAB", HN: "HNL" };

const esMoneda = (codigo: string): codigo is Moneda => (MONEDAS as readonly string[]).includes(codigo);

interface ValorExtraido {
  valor: Campo<number>;
  moneda: Campo<Moneda>;
  indeterminado: boolean;
  advertencias: string[];
}

/**
 * Códigos ISO 4217 que se reconocen como moneda delante de un monto. Los del PRD se aceptan; los demás dan
 * «moneda desconocida». Cualquier otra sigla de tres letras («IVA») no es una moneda y se ignora.
 */
const CODIGOS_ISO = [...MONEDAS, "EUR", "GBP", "BRL", "MXN", "CLP", "ARS", "CAD", "CHF", "JPY", "CNY", "UYU", "BOB", "PYG", "CRC", "GTQ", "NIO", "DOP"];
const ISO = CODIGOS_ISO.join("|");

/** Monto con código ISO («COP $1.200», «USD 1,5») o con signo («$265'000.000»), seguido o no de un multiplicador en palabras. */
const PATRON_MONTO = new RegExp(`(?:\\b(${ISO})\\s*\\$?|\\$)\\s*(\\d[\\d.,']*\\d|\\d)(?:\\s+(mil\\s+millones|millones|mill[oó]n|mil)(?!\\p{L}))?`, "giu");

/** «COP 1.200 millones» = 1.200 × 10⁶; el orden importa: «mil millones» antes que «mil». */
const MULTIPLICADORES: Array<[RegExp, number]> = [[/^mil\s+millones$/i, 1e9], [/^mill(?:ones|[oó]n)$/i, 1e6], [/^mil$/i, 1e3]];

/** Monedas fuera del PRD escritas en palabras o con símbolo. */
const MONEDA_NO_SOPORTADA = /(?<!\p{L})(euros?|libras(?:\s+esterlinas)?|reales)(?!\p{L})|€|£/iu;

/** Un pago periódico en la cláusula de valor: el monto puede ser la cuota y no el total. */
const PERIODICO = /mensual|por\s+mes|anual|por\s+a[nñ]o/i;

interface Monto {
  valor: number;
  codigo: string | null;
  indice: number;
}

const errorMoneda = (moneda: string) => new Error(`moneda desconocida: ${moneda} (se aceptan ${MONEDAS.join(", ")})`);

/** Todos los montos de la cláusula, con su código ISO si lo trae y el multiplicador ya aplicado. */
function montosEn(parrafo: string): Monto[] {
  return [...parrafo.matchAll(PATRON_MONTO)].map((m) => {
    const factor = m[3] ? MULTIPLICADORES.find(([p]) => p.test(m[3].replace(/\s+/g, " ")))?.[1] ?? 1 : 1;
    // Redondeo a centavos: 1,5 × 10⁶ en coma flotante puede dar 1499999,9999.
    return { valor: Math.round(parsearMonto(m[2]) * factor * 100) / 100, codigo: m[1] ?? null, indice: m.index ?? 0 };
  });
}

/** El monto precedido de «total» sin otro monto en medio, a menos de 120 caracteres: «valor total de COP 120.000.000». */
function montoTotal(parrafo: string, montos: Monto[]): Monto | null {
  return montos.find((m, i) => {
    const desde = i > 0 ? montos[i - 1].indice : 0;
    const tramo = parrafo.slice(Math.max(desde, m.indice - 120), m.indice);
    return /(?<!\p{L})total(?!\p{L})/iu.test(tramo);
  }) ?? null;
}

const indeterminado = (parrafo: string, texto: string, pais: Pais | null): ValorExtraido =>
  ({ valor: campo(0, 0.5, parrafo), moneda: monedaImplicita(texto, pais), indeterminado: true, advertencias: [] });

/** Valor y moneda de un monto elegido: con código, la moneda es la del código (0,95); sin código, la implícita. */
function desdeMonto(m: Monto, confianza: number, parrafo: string, texto: string, pais: Pais | null, advertencias: string[] = []): ValorExtraido {
  const moneda = m.codigo && esMoneda(m.codigo) ? campo(m.codigo, 0.95, parrafo) : monedaImplicita(texto, pais);
  return { valor: campo(m.valor, confianza, parrafo), moneda, indeterminado: false, advertencias };
}

/**
 * Con varios montos distintos o un pago periódico, el valor del contrato es el que la cláusula llama «total» (0,85).
 * Sin «total» no hay cómo saber cuál es: se propone el primero con 0,5 y va a revisión (O3).
 */
function elegirMonto(montos: Monto[], parrafo: string, texto: string, pais: Pais | null): ValorExtraido {
  const distintos = new Set(montos.map((m) => m.valor)).size;
  if (distintos === 1 && !PERIODICO.test(parrafo)) return desdeMonto(montos[0], montos[0].codigo ? 0.95 : 0.85, parrafo, texto, pais);
  const total = montoTotal(parrafo, montos);
  if (total) return desdeMonto(total, 0.85, parrafo, texto, pais);
  const lista = montos.map((m) => m.valor).join(", ");
  const aviso = `La cláusula de valor trae ${montos.length > 1 ? `varios montos (${lista})` : "un pago periódico"} y no dice cuál es el total: se propone ${montos[0].valor} y se pide revisión.`;
  return desdeMonto(montos[0], 0.5, parrafo, texto, pais, [aviso]);
}

/**
 * Valor y moneda desde la cláusula VALOR, en este orden: contrato por demanda, montos con código ISO o «$»
 * (con multiplicador en palabras), moneda no soportada, «según las tarifas» sin monto. Moneda fuera del PRD → error (HU-6).
 */
function extraerValor(texto: string, pais: Pais | null): ValorExtraido {
  const parrafo = clausula(texto, "valor") ?? "";
  if (/no tiene (un )?valor determinado|valor indeterminado|por demanda/i.test(parrafo)) return indeterminado(parrafo, texto, pais);
  const montos = montosEn(parrafo);
  const ajeno = montos.find((m) => m.codigo && !esMoneda(m.codigo));
  if (ajeno?.codigo) throw errorMoneda(ajeno.codigo);
  const noSoportada = montos.some((m) => m.codigo) ? null : parrafo.match(MONEDA_NO_SOPORTADA);
  if (noSoportada) throw errorMoneda(noSoportada[0]);
  if (montos.length > 0) return elegirMonto(montos, parrafo, texto, pais);
  if (/seg[uú]n las tarifas/i.test(parrafo)) return indeterminado(parrafo, texto, pais);
  return { valor: ausente(), moneda: monedaImplicita(texto, pais), indeterminado: false, advertencias: [] };
}

/**
 * Moneda cuando la cláusula de valor no la dice: código o palabra en otra parte del texto (0,85), o la del país
 * con 0,6, por debajo del umbral: deducirla solo del país es una suposición y va a revisión (O3).
 */
function monedaImplicita(texto: string, pais: Pais | null): Campo<Moneda> {
  const codigo = texto.match(/\b(COP|USD|PEN|PAB|HNL)\b/);
  if (codigo && esMoneda(codigo[1])) return campo(codigo[1], 0.85, codigo[0]);
  for (const [patron, moneda] of PALABRAS_MONEDA) if (patron.test(texto)) return campo(moneda, 0.85, moneda);
  return pais ? campo(MONEDA_POR_PAIS[pais], 0.6, `moneda del país ${pais}`) : ausente();
}

// ── Partes, identificador y país ──

interface Parte {
  nombre: string;
  tipoId: string;
  id: string;
  evidencia: string;
}

/** Normaliza el identificador: NIT sin puntos ni dígito de verificación; RTN sin puntos, espacios ni guiones; RUC sin puntos ni espacios. */
export function normalizarIdentificador(tipo: string, crudo: string): string {
  const t = tipo.toUpperCase();
  if (t === "RTN") return crudo.replace(/[.\s-]/g, "");
  const sinPuntos = crudo.replace(/[.\s]/g, "");
  return t === "NIT" ? sinPuntos.replace(/-\d$/, "") : sinPuntos;
}

/**
 * Supuesto: un RUC con guiones (formato de Panamá, «155612345-2-2017») se compara con el maestro por su primer
 * segmento, que es como el maestro guarda esos RUC. Si el primer segmento ya está en el maestro se usa ese;
 * si no, se conserva el RUC completo para no fusionar contribuyentes distintos.
 */
function canonizarRuc(parte: Parte, nombrePorId: (id: string) => string | null): Parte {
  if (parte.tipoId !== "RUC" || !parte.id.includes("-")) return parte;
  const primero = parte.id.split("-")[0];
  return nombrePorId(primero) ? { ...parte, id: primero } : parte;
}

/**
 * Partes nombradas distintas de Periferia, en orden y sin repetir identificador. Arrancan con «Entre…»,
 * «Los suscritos…», «entre las partes…» o «, y …»: la contraparte puede ir después de Periferia.
 */
function contrapartes(texto: string): Parte[] {
  const plano = texto.replace(/\s+/g, " ");
  const patron = /(?:(?:[Ee]ntre\s+)?(?:[Ll]os\s+suscritos|[Ll]as\s+partes)\s*[,:]?\s*|[Ee]ntre\s+|,?\s+y\s+)([A-ZÁÉÍÓÚÑ][^,]{2,120}?),\s*(?:identificad[ao]\s+con\s+(?:el\s+)?|con\s+(?:el\s+)?)?(NIT|RUC|RTN)\s*(?:No\.?\s*)?(\d[\d.\-]*\d)/g;
  const partes: Parte[] = [];
  for (const m of plano.matchAll(patron)) {
    const id = normalizarIdentificador(m[2], m[3]);
    if (id === REGLAS.nitPropio || partes.some((p) => p.id === id)) continue;
    partes.push({ nombre: m[1].trim(), tipoId: m[2].toUpperCase(), id, evidencia: m[0] });
  }
  return partes;
}

/** País por formato del identificador. */
function paisPorIdentificador(tipo: string, id: string): Pais | null {
  if (tipo === "NIT") return "CO";
  if (tipo === "RTN" || /^\d{14}$/.test(id)) return "HN";
  if (/^\d{13}$/.test(id) && id.endsWith("001")) return "EC";
  if (/^\d{11}$/.test(id)) return "PE";
  if (tipo === "RUC") return "PA";
  return null;
}

const PAIS_POR_LUGAR: Array<[RegExp, Pais]> = [
  [/colombia|bogota|medellin|barranquilla|cali\b|cartagena|bucaramanga/, "CO"],
  [/ecuador|quito|guayaquil|cuenca/, "EC"],
  [/peru|lima\b|arequipa/, "PE"],
  [/panama/, "PA"],
  [/honduras|tegucigalpa|san pedro sula/, "HN"],
];

/** País por el domicilio declarado de la contraparte («con domicilio en Quito, Ecuador»). */
function paisPorDomicilio(texto: string, nombre: string): Pais | null {
  const plano = normalizar(texto.replace(/\s+/g, " "));
  const desde = plano.indexOf(normalizar(nombre));
  const tramo = desde >= 0 ? plano.slice(desde, desde + 260) : "";
  const domicilio = tramo.match(/domicilio en ([^,]+(?:, [a-z ]+)?)/);
  if (!domicilio) return null;
  for (const [patron, pais] of PAIS_POR_LUGAR) if (patron.test(domicilio[1])) return pais;
  return null;
}

/** País con confianza según cuántas señales coinciden (identificador y domicilio). */
function extraerPais(texto: string, parte: Parte): Campo<Pais> {
  const porId = paisPorIdentificador(parte.tipoId, parte.id);
  const porDomicilio = paisPorDomicilio(texto, parte.nombre);
  if (porId && porDomicilio) return porId === porDomicilio ? campo(porId, 0.95, parte.evidencia) : campo(porId, 0.5, parte.evidencia);
  if (porId) return campo(porId, 0.9, parte.evidencia);
  // 0,8 fijo y no el umbral: una sola señal (el domicilio) es una deducción razonable, no una afirmación del texto.
  if (porDomicilio) return campo(porDomicilio, 0.8, parte.evidencia);
  return ausente();
}

const SUFIJOS = /\s*(s\.?\s*a\.?\s*s\.?|s\.?\s*a\.?\s*c\.?|s\.?\s*de\s*r\.?\s*l\.?|s\.?\s*r\.?\s*l\.?|s\.?\s*a\.?|ltda\.?|e\.?\s*s\.?\s*p\.?)\s*$/i;

/** Nombre canónico: el del maestro si el NIT ya existe; si no, el del bloque de firmas; si no, en formato título. */
function nombreCliente(texto: string, parte: Parte, nombrePorId: (id: string) => string | null): Campo<string> {
  const delMaestro = nombrePorId(parte.id);
  if (delMaestro) return campo(delMaestro, 0.95, parte.evidencia);
  const buscado = normalizar(parte.nombre);
  for (const linea of texto.split("\n")) {
    const segmento = linea.split(/\s{2,}/).map((s) => s.trim()).find((s) => normalizar(s) === buscado);
    if (segmento) return campo(segmento, 0.95, segmento);
  }
  const sufijo = parte.nombre.match(SUFIJOS)?.[0]?.trim() ?? "";
  const base = parte.nombre.replace(SUFIJOS, "").toLowerCase().replace(/(^|\s)\p{L}/gu, (l) => l.toUpperCase());
  return campo(`${base}${sufijo ? " " + sufijo.toUpperCase() : ""}`, 0.85, parte.evidencia);
}

/** Identificador para la ruta de SharePoint: «Industrias Delta S.A.S.» → «industrias-delta». */
export function slugCliente(cliente: string): string {
  return normalizar(cliente.replace(SUFIJOS, "")).replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

// ── Objeto y póliza ──

/** Objeto sin la fórmula inicial («EL CONTRATISTA prestará servicios de…»), en máximo 200 caracteres (§7.2). */
function extraerObjeto(texto: string): Campo<string> {
  const parrafo = clausula(texto, "objeto");
  if (!parrafo) return ausente();
  const cuerpo = sinEncabezado(parrafo, "objeto")
    .replace(/^EL CONTRATISTA\s+se\s+obliga\s+a\s+(ejecutar\s+)?/i, "")
    .replace(/^EL CONTRATISTA\s+prestar[aá]\s+(el\s+servicio\s+de\s+|los\s+servicios\s+de\s+|servicios\s+de\s+)?/i, "")
    .replace(/^(la|el|los|las)\s+/i, "")
    .replace(/\.$/, "");
  const objeto = recortar(cuerpo.charAt(0).toUpperCase() + cuerpo.slice(1), 200);
  return objeto ? campo(objeto, 0.9, parrafo) : ausente();
}

interface Poliza {
  requiere_poliza: Campo<boolean>;
  tipo_poliza: Campo<string>;
  advertencias: string[];
}

/** Tipos de póliza del maestro (§7.2) y cómo se reconocen al inicio de un amparo nombrado. */
const TIPOS_POLIZA: Array<[RegExp, string]> = [
  [/^cumplimiento/, "cumplimiento"], [/^calidad/, "calidad"], [/^responsabilidad civil/, "responsabilidad_civil"],
  [/^salarios y prestaciones/, "salarios_prestaciones"], [/^estabilidad/, "estabilidad"],
];

/** Un amparo: «cumplimiento», «calidad del servicio», «salarios y prestaciones sociales»… */
const AMPARO = "(?:cumplimiento|calidad(?:\\s+del\\s+servicio)?|responsabilidad\\s+civil(?:\\s+extracontractual)?|salarios\\s+y\\s+prestaciones(?:\\s+sociales)?|estabilidad(?:\\s+de\\s+la\\s+obra)?)";
/** Póliza seguida de uno o varios amparos: «pólizas de estabilidad y de calidad», «póliza de cumplimiento, de calidad y de salarios…». */
const LISTA_POLIZAS = new RegExp(
  `(?:p[oó]lizas?|garant[ií]as?(?:\\s+[uú]nicas?)?)\\s+de\\s+${AMPARO}(?:\\s*(?:,|\\s+y|\\s+e)\\s+(?:de\\s+(?:la\\s+)?)?${AMPARO})*`,
  "gi",
);

/** Nombres de la cláusula de garantías: GARANTÍA(S), PÓLIZA(S), SEGUROS, «GARANTÍAS Y SEGUROS». */
const CLAUSULA_POLIZA = "garantia\\w*(?:\\s+y\\s+seguros)?|poliza\\w*|seguros";
/** Palabras que indican una póliza exigida en cualquier parte del texto. */
const MENCION_POLIZA = /p[oó]liza|garant[ií]a\s+(?:[uú]nica|de\s+cumplimiento)/i;
/** Póliza exigida solo a algunas órdenes de un contrato marco. «En caso de que se prorrogue…» no la vuelve condicional. */
const POLIZA_CONDICIONAL = /para cada orden|cuyo valor (?:supere|exceda)/i;

/** Tipos de póliza nombrados en un texto, como lista separada por «;» en el orden en que aparecen (§7.2). */
function tiposPoliza(texto: string): string {
  const tipos: string[] = [];
  for (const lista of normalizar(texto).matchAll(LISTA_POLIZAS)) {
    for (const amparo of lista[0].matchAll(new RegExp(AMPARO, "gi"))) {
      const tipo = TIPOS_POLIZA.find(([p]) => p.test(amparo[0].replace(/\s+/g, " ")))?.[1];
      if (tipo && !tipos.includes(tipo)) tipos.push(tipo);
    }
  }
  return tipos.join(";");
}

/** Sin cláusula de garantías: si el texto nombra una póliza va a revisión (0,6); si no la nombra en ningún lugar, no aplica (0,9). */
function polizaSinClausula(texto: string): Poliza {
  const mencion = texto.match(MENCION_POLIZA);
  if (!mencion) return { requiere_poliza: campo(false, 0.9, "el texto no menciona pólizas ni garantías"), tipo_poliza: campo("", 0.9), advertencias: [] };
  return {
    requiere_poliza: campo(true, 0.6, mencion[0]),
    tipo_poliza: campo(tiposPoliza(texto), 0.6, mencion[0]),
    advertencias: [`El texto menciona «${mencion[0]}» fuera de una cláusula de garantías: se propone que requiere póliza y se pide revisión.`],
  };
}

/** Póliza desde la cláusula de garantías (O4, HU-5). Una póliza exigida solo para algunas órdenes no aplica al contrato marco. */
function extraerPoliza(texto: string, tipo: TipoDocumento): Poliza {
  if (esModificacion(tipo)) return { requiere_poliza: ausente(), tipo_poliza: ausente(), advertencias: [] };
  const parrafo = clausula(texto, CLAUSULA_POLIZA);
  if (!parrafo || !MENCION_POLIZA.test(parrafo)) return polizaSinClausula(texto);
  const lista = tiposPoliza(parrafo);
  if (POLIZA_CONDICIONAL.test(parrafo)) {
    // 0,8 fijo y no el umbral: la cláusula sí está escrita; solo se interpreta que no aplica al contrato marco.
    return {
      requiere_poliza: campo(false, 0.8, parrafo),
      tipo_poliza: campo("", 0.8),
      advertencias: [`Póliza condicional: se exige ${lista || "póliza"} solo en ciertas órdenes de servicio («${recortar(parrafo, 120)}»).`],
    };
  }
  return { requiere_poliza: campo(true, 0.95, parrafo), tipo_poliza: campo(lista, lista ? 0.9 : 0.5, parrafo), advertencias: [] };
}

// ── Identificador del contrato ──

const PATRON_ID = /([A-Z]{2,4}-\d{4}-\d{1,4})/;
/** «No.», «No», «N°», «Nº». */
const NUMERO = "N(?:o|°|º)\\.?";

/** Número del contrato desde su título (después de un posible membrete); en un otrosí, el del contrato que modifica. */
function extraerId(texto: string, tipo: TipoDocumento): Campo<string> {
  const plano = (encabezado(texto)?.desdeTitulo ?? texto).replace(/\s+/g, " ");
  // Otrosí y acta citan el contrato que modifican: «OTROSÍ No. 1 AL CONTRATO No. …», «ACTA DE TERMINACIÓN DEL CONTRATO No. …».
  const patron = esModificacion(tipo)
    ? new RegExp(`(?:AL|DEL)\\s+CONTRATO[^.]*?${NUMERO}\\s*${PATRON_ID.source}`, "i")
    : new RegExp(`^\\s*CONTRATO[^.]*?${NUMERO}\\s*${PATRON_ID.source}`, "i");
  const m = plano.match(patron);
  return m ? campo(m[1], 0.95, m[0]) : ausente();
}

// ── Extracción completa ──

/** Campos del contrato tal como salen del texto, cada uno con su confianza (HU-2). */
export interface ContratoExtraido {
  id_contrato: Campo<string>;
  cliente: Campo<string>;
  nit_cliente: Campo<string>;
  pais: Campo<Pais>;
  objeto: Campo<string>;
  valor: Campo<number>;
  moneda: Campo<Moneda>;
  fecha_inicio: Campo<string>;
  fecha_fin: Campo<string>;
  requiere_poliza: Campo<boolean>;
  tipo_poliza: Campo<string>;
}

/** Resultado de `extraerContrato`: tipo de documento, campos con confianza y advertencias (HU-2). */
export interface Extraccion {
  tipo_documento: TipoDocumento;
  numero_otrosi: number | null;
  contrato: ContratoExtraido;
  valor_indeterminado: boolean;
  /** Por qué el documento parece no firmado (borrador, propuesta, firma en blanco), o `null`: no se registra sin confirmación. */
  sin_firma: string | null;
  advertencias: string[];
}

interface PartesExtraidas {
  parte: Parte | null;
  cliente: Campo<string>;
  advertencias: string[];
}

/** Contraparte y nombre del cliente. Con más de una contraparte (consorcio) no se elige: el cliente va a revisión (0,5). */
function extraerPartes(texto: string, nombrePorId: (id: string) => string | null): PartesExtraidas {
  const todas = contrapartes(texto);
  const parte = todas[0] ? canonizarRuc(todas[0], nombrePorId) : null;
  if (!parte) return { parte, cliente: ausente(), advertencias: [] };
  const cliente = nombreCliente(texto, parte, nombrePorId);
  if (todas.length === 1) return { parte, cliente, advertencias: [] };
  const nombres = todas.map((p) => `${p.nombre} (${p.tipoId} ${p.id})`).join(", ");
  return {
    parte,
    cliente: { ...cliente, confianza: 0.5 },
    advertencias: [`El documento nombra más de una contraparte (${nombres}): se propone la primera y la analista decide cuál es el cliente.`],
  };
}

/** Un acta de terminación no trae valor ni moneda: solo cambia la fecha de fin. */
const sinValor = (): ValorExtraido => ({ valor: ausente(), moneda: ausente(), indeterminado: false, advertencias: [] });

/** Advertencia de documento sin firmar (regla de gobierno): se registra solo si la analista lo confirma. */
const avisoSinFirma = (senal: string): string =>
  `El documento parece no firmado (${senal}): no se registra sin que la analista confirme que es la versión firmada.`;

/**
 * Extrae los datos de un contrato, otrosí o acta de terminación (HU-2).
 * @param texto texto del adjunto.
 * @param nombrePorId busca en el maestro el nombre de un cliente por su identificador.
 * @throws Error legible si el texto está vacío, no es contractual o trae una fecha o moneda inválida (HU-6).
 */
export function extraerContrato(texto: string, nombrePorId: (id: string) => string | null): Extraccion {
  if (!texto.trim()) throw new Error("el adjunto está vacío");
  const tipo = tipoDocumento(texto);
  if (!tipo) throw new Error(describirNoContractual(texto));
  const partes = extraerPartes(texto, nombrePorId);
  const parte = partes.parte;
  const pais = parte ? extraerPais(texto, parte) : ausente<Pais>();
  const plazo = extraerPlazo(texto, tipo);
  const valor = tipo === "acta" ? sinValor() : extraerValor(texto, pais.valor);
  const poliza = extraerPoliza(texto, tipo);
  const sin_firma = senalSinFirma(texto);
  const numero = texto.match(new RegExp(`OTROS[IÍ]\\s+${NUMERO}\\s*(\\d+)`, "i"));
  return {
    tipo_documento: tipo,
    numero_otrosi: tipo === "otrosi" && numero ? Number(numero[1]) : null,
    contrato: {
      id_contrato: extraerId(texto, tipo),
      cliente: partes.cliente,
      nit_cliente: parte ? campo(parte.id, 0.95, parte.evidencia) : ausente(),
      pais,
      objeto: esModificacion(tipo) ? ausente() : extraerObjeto(texto),
      valor: valor.valor,
      moneda: valor.moneda,
      fecha_inicio: plazo.fecha_inicio,
      fecha_fin: plazo.fecha_fin,
      requiere_poliza: poliza.requiere_poliza,
      tipo_poliza: poliza.tipo_poliza,
    },
    valor_indeterminado: valor.indeterminado,
    sin_firma,
    advertencias: [...partes.advertencias, ...plazo.advertencias, ...valor.advertencias, ...poliza.advertencias, ...(sin_firma ? [avisoSinFirma(sin_firma)] : [])],
  };
}
