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

export type TipoDocumento = "contrato" | "otrosi";

/** Un adjunto es contractual si su encabezado es CONTRATO u OTROSÍ y nombra a las partes («Entre…»). */
export function tipoDocumento(texto: string): TipoDocumento | null {
  const encabezado = texto.trim().split("\n")[0] ?? "";
  // `\b` de JavaScript solo conoce letras ASCII: tras la «Í» de «OTROSÍ» nunca hay límite. Se usa \p{L} con la bandera u.
  if (!/(?<!\p{L})Entre(?!\p{L})/iu.test(texto)) return null;
  if (/^\s*OTROS[IÍ](?!\p{L})/iu.test(encabezado)) return "otrosi";
  if (/^\s*CONTRATO(?!\p{L})/iu.test(encabezado)) return "contrato";
  return null;
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

/** Párrafo de una cláusula («SEGUNDA. VALOR. …») o de su modificación en un otrosí («cláusula SEGUNDA (VALOR)»). */
function clausula(texto: string, nombre: string): string | null {
  const n = normalizar(nombre);
  return (
    parrafos(texto).find((p) => {
      const q = normalizar(p);
      return new RegExp(`^[a-z]+\\.\\s+${n}\\.`).test(q) || new RegExp(`clausula\\s+\\w+\\s+\\(${n}\\)`).test(q);
    }) ?? null
  );
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
 * Fechas del contrato a partir de la cláusula de PLAZO.
 * Explícitas («desde … hasta …») → confianza alta. Con plazo en meses y sin fecha de fin, la fecha de
 * fin se deriva (aniversario del inicio) y queda en revisión: se propone, no se afirma.
 */
function extraerPlazo(texto: string, tipo: TipoDocumento): Plazo {
  const parrafo = clausula(texto, "PLAZO") ?? "";
  const fechas = fechasEn(parrafo);
  const iDesde = parrafo.search(/\bdesde\b/i);
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
      fecha_inicio = campo(firma.iso, firma.soloMes ? REGLAS.umbralConfianza : 0.9, firma.evidencia);
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

/** Convierte un monto con separadores colombianos («265.000.000») o estadounidenses («120,000.00»). */
export function parsearMonto(crudo: string): number {
  const s = crudo.replace(/\s/g, "");
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
}

/** Valor y moneda desde la cláusula VALOR. Una moneda fuera de la lista del PRD es un error (HU-6). */
function extraerValor(texto: string, pais: Pais | null): ValorExtraido {
  const parrafo = clausula(texto, "VALOR") ?? "";
  if (/no tiene (un )?valor determinado|valor indeterminado|por demanda|seg[uú]n las tarifas/i.test(parrafo)) {
    return { valor: campo(0, 0.5, parrafo), moneda: monedaImplicita(texto, pais), indeterminado: true };
  }
  const conCodigo = parrafo.match(/\(\s*([A-Z]{3})\s*\$?\s*([\d][\d.,]*)\s*\)/) ?? parrafo.match(/\b([A-Z]{3})\s*\$?\s*([\d][\d.,]*\d)/);
  if (conCodigo) {
    if (!esMoneda(conCodigo[1])) throw new Error(`moneda desconocida: ${conCodigo[1]} (se aceptan ${MONEDAS.join(", ")})`);
    return { valor: campo(parsearMonto(conCodigo[2]), 0.95, parrafo), moneda: campo(conCodigo[1], 0.95, parrafo), indeterminado: false };
  }
  return { valor: ausente(), moneda: monedaImplicita(texto, pais), indeterminado: false };
}

/** Moneda cuando la cláusula de valor no la dice: código o palabra en otra parte del texto, o la del país. */
function monedaImplicita(texto: string, pais: Pais | null): Campo<Moneda> {
  const codigo = texto.match(/\b(COP|USD|PEN|PAB|HNL)\b/);
  if (codigo && esMoneda(codigo[1])) return campo(codigo[1], 0.85, codigo[0]);
  for (const [patron, moneda] of PALABRAS_MONEDA) if (patron.test(texto)) return campo(moneda, 0.85, moneda);
  return pais ? campo(MONEDA_POR_PAIS[pais], REGLAS.umbralConfianza, `moneda del país ${pais}`) : ausente();
}

// ── Partes, identificador y país ──

interface Parte {
  nombre: string;
  tipoId: string;
  id: string;
  evidencia: string;
}

/** Normaliza el identificador: NIT sin puntos ni dígito de verificación; RUC y RTN sin puntos ni espacios. */
export function normalizarIdentificador(tipo: string, crudo: string): string {
  const sinPuntos = crudo.replace(/[.\s]/g, "");
  return tipo.toUpperCase() === "NIT" ? sinPuntos.replace(/-\d$/, "") : sinPuntos;
}

/** La contraparte es la primera parte nombrada cuyo identificador no es el de Periferia. */
function contraparte(texto: string): Parte | null {
  const plano = texto.replace(/\s+/g, " ");
  const patron = /(?:Entre|,\s*y)\s+(?:los\s+suscritos,\s*)?([A-ZÁÉÍÓÚÑ][^,]{2,120}?),\s*(?:identificad[ao]\s+con\s+)?(NIT|RUC|RTN)\s*(?:No\.?\s*)?(\d[\d.\-]*\d)/g;
  for (const m of plano.matchAll(patron)) {
    const id = normalizarIdentificador(m[2], m[3]);
    if (id !== REGLAS.nitPropio) return { nombre: m[1].trim(), tipoId: m[2].toUpperCase(), id, evidencia: m[0] };
  }
  return null;
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
  if (porDomicilio) return campo(porDomicilio, REGLAS.umbralConfianza, parte.evidencia);
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
  const parrafo = clausula(texto, "OBJETO");
  if (!parrafo) return ausente();
  const cuerpo = parrafo
    .replace(/^[A-ZÁÉÍÓÚ]+\.\s+OBJETO\.\s*/i, "")
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

const slugPoliza = (s: string): string =>
  normalizar(s).replace(/\s+y\s+/g, "_").replace(/\s+sociales$/, "").replace(/\s+/g, "_");

/** Póliza desde la cláusula de GARANTÍAS. Una póliza exigida solo para algunas órdenes no aplica al contrato marco. */
function extraerPoliza(texto: string, tipo: TipoDocumento): Poliza {
  if (tipo === "otrosi") return { requiere_poliza: ausente(), tipo_poliza: ausente(), advertencias: [] };
  const parrafo = clausula(texto, "GARANTÍAS") ?? clausula(texto, "GARANTÍA");
  if (!parrafo || !/p[oó]liza/i.test(parrafo)) {
    return { requiere_poliza: campo(false, 0.9, "sin cláusula de garantías"), tipo_poliza: campo("", 0.9), advertencias: [] };
  }
  const tipos = [...parrafo.matchAll(/p[oó]lizas?\s+de\s+(cumplimiento|calidad|responsabilidad\s+civil|salarios\s+y\s+prestaciones(?:\s+sociales)?|estabilidad)/gi)]
    .map((m) => slugPoliza(m[1]));
  const lista = [...new Set(tipos)].join(";");
  if (/para cada orden|cuyo valor supere|en caso de que|cuando el valor/i.test(parrafo)) {
    return {
      requiere_poliza: campo(false, REGLAS.umbralConfianza, parrafo),
      tipo_poliza: campo("", REGLAS.umbralConfianza),
      advertencias: [`Póliza condicional: se exige ${lista || "póliza"} solo en ciertas órdenes de servicio («${recortar(parrafo, 120)}»).`],
    };
  }
  return { requiere_poliza: campo(true, 0.95, parrafo), tipo_poliza: campo(lista, lista ? 0.9 : 0.5, parrafo), advertencias: [] };
}

// ── Identificador del contrato ──

const PATRON_ID = /([A-Z]{2,4}-\d{4}-\d{1,4})/;

/** Número del contrato; en un otrosí, el del contrato que modifica («AL CONTRATO … No. XX-AAAA-NNN»). */
function extraerId(texto: string, tipo: TipoDocumento): Campo<string> {
  const plano = texto.replace(/\s+/g, " ");
  const patron = tipo === "otrosi"
    ? new RegExp(`AL\\s+CONTRATO[^.]*?No\\.?\\s*${PATRON_ID.source}`, "i")
    : new RegExp(`^\\s*CONTRATO[^.]*?No\\.?\\s*${PATRON_ID.source}`, "i");
  const m = plano.match(patron);
  return m ? campo(m[1], 0.95, m[0]) : ausente();
}

// ── Extracción completa ──

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

export interface Extraccion {
  tipo_documento: TipoDocumento;
  numero_otrosi: number | null;
  contrato: ContratoExtraido;
  valor_indeterminado: boolean;
  advertencias: string[];
}

/**
 * Extrae los datos de un contrato u otrosí (HU-2).
 * @param texto texto del adjunto.
 * @param nombrePorId busca en el maestro el nombre de un cliente por su identificador.
 * @throws Error legible si el texto está vacío, no es contractual o trae una fecha o moneda inválida (HU-6).
 */
export function extraerContrato(texto: string, nombrePorId: (id: string) => string | null): Extraccion {
  if (!texto.trim()) throw new Error("el adjunto está vacío");
  const tipo = tipoDocumento(texto);
  if (!tipo) throw new Error(describirNoContractual(texto));
  const parte = contraparte(texto);
  const pais = parte ? extraerPais(texto, parte) : ausente<Pais>();
  const plazo = extraerPlazo(texto, tipo);
  const valor = extraerValor(texto, pais.valor);
  const poliza = extraerPoliza(texto, tipo);
  const numero = texto.match(/OTROS[IÍ]\s+No\.?\s*(\d+)/i);
  return {
    tipo_documento: tipo,
    numero_otrosi: tipo === "otrosi" && numero ? Number(numero[1]) : null,
    contrato: {
      id_contrato: extraerId(texto, tipo),
      cliente: parte ? nombreCliente(texto, parte, nombrePorId) : ausente(),
      nit_cliente: parte ? campo(parte.id, 0.95, parte.evidencia) : ausente(),
      pais,
      objeto: tipo === "otrosi" ? ausente() : extraerObjeto(texto),
      valor: valor.valor,
      moneda: valor.moneda,
      fecha_inicio: plazo.fecha_inicio,
      fecha_fin: plazo.fecha_fin,
      requiere_poliza: poliza.requiere_poliza,
      tipo_poliza: poliza.tipo_poliza,
    },
    valor_indeterminado: valor.indeterminado,
    advertencias: [...plazo.advertencias, ...poliza.advertencias],
  };
}
