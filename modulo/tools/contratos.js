// GENERADO por `npm run modulo` (scripts/generar-modulo.ts). No editar a mano.
// Fuente: src/tools/contratos.ts y las piezas de src/tools/ que importa, empaquetadas con esbuild.
// Autónomo: la única dependencia externa es zod.
// src/tools/contratos.ts
import path5 from "node:path";
import { z as z5 } from "zod";

// src/tools/nucleo.ts
import path from "node:path";
import { z } from "zod";
var ok = (data) => JSON.stringify({ ok: true, data });
var fallo = (error) => JSON.stringify({ ok: false, error });
async function seguro(logica) {
  try {
    return await logica();
  } catch (e) {
    return fallo(e instanceof Error ? e.message : String(e));
  }
}
function dirSalida(ctx) {
  return path.resolve(ctx.directory, process.env.OUT_DIR ?? "out");
}

// src/tools/almacen.ts
import fs from "node:fs";
import path2 from "node:path";
import { z as z2 } from "zod";

// src/tools/reglas.ts
var REGLAS = {
  /** RN5: un campo con confianza menor a este umbral exige revisión humana. */
  umbralConfianza: 0.8,
  /** RN2: similitud mínima de objeto para tratar dos contratos del mismo NIT como el mismo. */
  similitudObjeto: 0.9,
  /** HU-5: ventana de alerta de vencimiento, en días. */
  diasAlertaVencimiento: 60,
  /** HU-5: fecha de corte del maestro congelado. */
  fechaCorte: "2026-05-30",
  /** NIT de Periferia: aparece en todos los contratos como contratista y nunca es el cliente. */
  nitPropio: "900123456"
};
var COLUMNAS_MAESTRO = [
  "id_contrato",
  "cliente",
  "nit_cliente",
  "pais",
  "objeto",
  "valor",
  "moneda",
  "fecha_inicio",
  "fecha_fin",
  "requiere_poliza",
  "tipo_poliza",
  "estado_poliza",
  "comercial",
  "ruta_sharepoint",
  "fecha_registro",
  "fuente"
];
var PAISES = ["CO", "EC", "PE", "PA", "HN"];
var MONEDAS = ["COP", "USD", "PEN", "PAB", "HNL"];
var CAMPOS_CON_CONFIANZA = [
  "id_contrato",
  "cliente",
  "nit_cliente",
  "pais",
  "objeto",
  "valor",
  "moneda",
  "fecha_inicio",
  "fecha_fin",
  "requiere_poliza",
  "tipo_poliza"
];

// src/tools/almacen.ts
function rutas(ctx) {
  const fixtures = path2.resolve(ctx.directory, "fixtures/reto-02");
  const out = dirSalida(ctx);
  const sharepoint = path2.join(out, "sharepoint");
  return {
    buzon: path2.resolve(ctx.directory, process.env.BUZON_DIR ?? "fixtures/reto-02/buzon"),
    maestroOriginal: path2.join(fixtures, "maestro-contratos.csv"),
    comerciales: path2.join(fixtures, "comerciales.json"),
    out,
    sharepoint,
    maestro: path2.join(sharepoint, "maestro-contratos.csv"),
    historial: path2.join(sharepoint, "historial.jsonl"),
    procesados: path2.join(out, "procesados.json"),
    alertas: path2.join(out, "alertas.md")
  };
}
function parsearCsv(texto) {
  const registros = [];
  let campo2 = "";
  let fila = [];
  let entreComillas = false;
  for (let i = 0; i < texto.length; i++) {
    const c = texto[i];
    if (entreComillas) {
      if (c === '"' && texto[i + 1] === '"') {
        campo2 += '"';
        i++;
      } else if (c === '"') entreComillas = false;
      else campo2 += c;
    } else if (c === '"') entreComillas = true;
    else if (c === ",") {
      fila.push(campo2);
      campo2 = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && texto[i + 1] === "\n") i++;
      fila.push(campo2);
      campo2 = "";
      registros.push(fila);
      fila = [];
    } else campo2 += c;
  }
  if (campo2 !== "" || fila.length > 0) {
    fila.push(campo2);
    registros.push(fila);
  }
  return registros;
}
function serializarCsv(registros) {
  const celda = (v) => /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  return registros.map((r) => r.map(celda).join(",")).join("\n") + "\n";
}
function leerMaestro(ctx) {
  const r = rutas(ctx);
  if (!fs.existsSync(r.maestro)) {
    fs.mkdirSync(r.sharepoint, { recursive: true });
    fs.copyFileSync(r.maestroOriginal, r.maestro);
  }
  const [cabecera, ...filas] = parsearCsv(fs.readFileSync(r.maestro, "utf8"));
  if (cabecera.join(",") !== COLUMNAS_MAESTRO.join(",")) throw new Error("el maestro no tiene las columnas esperadas (PRD \xA77.2)");
  return filas.map((f) => Object.fromEntries(COLUMNAS_MAESTRO.map((c, i) => [c, f[i] ?? ""])));
}
var COLUMNAS_TEXTO_LIBRE = ["cliente", "objeto", "tipo_poliza", "comercial"];
function neutralizarFormula(valor) {
  return /^[=+\-@\t\r]/.test(valor) ? `'${valor}` : valor;
}
function celdaMaestro(fila, columna) {
  return COLUMNAS_TEXTO_LIBRE.includes(columna) ? neutralizarFormula(fila[columna]) : fila[columna];
}
function escribirMaestro(ctx, filas) {
  const registros = [[...COLUMNAS_MAESTRO], ...filas.map((f) => COLUMNAS_MAESTRO.map((c) => celdaMaestro(f, c)))];
  fs.writeFileSync(rutas(ctx).maestro, serializarCsv(registros));
}
function leerProcesados(ctx) {
  const p = rutas(ctx).procesados;
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : {};
}
function marcarProcesado(ctx, mensajeId2, accion, idContrato) {
  const todos = leerProcesados(ctx);
  todos[mensajeId2] = { accion, id_contrato: idContrato, ts: (/* @__PURE__ */ new Date()).toISOString() };
  fs.mkdirSync(rutas(ctx).out, { recursive: true });
  fs.writeFileSync(rutas(ctx).procesados, JSON.stringify(todos, null, 2) + "\n");
}
function anotarHistorial(ctx, entrada) {
  fs.mkdirSync(rutas(ctx).sharepoint, { recursive: true });
  const linea = { ts: (/* @__PURE__ */ new Date()).toISOString(), ...entrada };
  fs.appendFileSync(rutas(ctx).historial, JSON.stringify(linea) + "\n");
}
function archivar(ctx, origen, relativa) {
  const destino = path2.join(rutas(ctx).sharepoint, relativa);
  fs.mkdirSync(path2.dirname(destino), { recursive: true });
  fs.copyFileSync(origen, destino);
  return relativa;
}
var Correo = z2.object({
  id: z2.string(),
  de: z2.string(),
  para: z2.string().optional(),
  asunto: z2.string(),
  fecha: z2.string(),
  cuerpo: z2.string().optional(),
  adjuntos: z2.array(z2.string())
});
var Comerciales = z2.array(z2.object({ email: z2.string(), nombre: z2.string(), region: z2.string() }));
function listarMensajes(ctx) {
  const dir = rutas(ctx).buzon;
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
}
function carpetaMensaje(ctx, mensajeId2) {
  if (!/^[\w-]+$/.test(mensajeId2) || !listarMensajes(ctx).includes(mensajeId2)) {
    throw new Error(`el mensaje ${mensajeId2} no existe en el buz\xF3n`);
  }
  return path2.join(rutas(ctx).buzon, mensajeId2);
}
function leerCorreo(ctx, mensajeId2) {
  const crudo = JSON.parse(fs.readFileSync(path2.join(carpetaMensaje(ctx, mensajeId2), "correo.json"), "utf8"));
  const r = Correo.safeParse(crudo);
  if (!r.success) throw new Error(`el correo ${mensajeId2} no tiene el formato esperado: ${z2.prettifyError(r.error)}`);
  return r.data;
}
function rutaAdjunto(ctx, mensajeId2, nombre) {
  if (nombre !== path2.basename(nombre)) throw new Error(`adjunto inv\xE1lido: ${nombre}`);
  return path2.join(carpetaMensaje(ctx, mensajeId2), nombre);
}
function leerComerciales(ctx) {
  return Comerciales.parse(JSON.parse(fs.readFileSync(rutas(ctx).comerciales, "utf8")));
}

// src/tools/extraccion.ts
var ausente = () => ({ valor: null, confianza: 0 });
var campo = (valor, confianza, evidencia) => ({
  valor,
  confianza,
  ...evidencia ? { evidencia: recortar(evidencia, 140) } : {}
});
var normalizar = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
var recortar = (s, max) => {
  const limpio = s.replace(/\s+/g, " ").trim();
  if (limpio.length <= max) return limpio;
  const corte = limpio.slice(0, max + 1).replace(/\s+\S*$/, "");
  return corte.replace(/[,;:\s]+$/, "");
};
var LINEAS_ENCABEZADO = 5;
function encabezado(texto) {
  const lineas = texto.split("\n");
  let revisadas = 0;
  for (let i = 0; i < lineas.length && revisadas < LINEAS_ENCABEZADO; i++) {
    if (!lineas[i].trim()) continue;
    revisadas++;
    const tipo = new RegExp("^\\s*OTROS[I\xCD](?!\\p{L})", "iu").test(lineas[i]) ? "otrosi" : new RegExp("^\\s*CONTRATO(?!\\p{L})", "iu").test(lineas[i]) ? "contrato" : null;
    if (tipo) return { tipo, desdeTitulo: lineas.slice(i).join("\n") };
  }
  return null;
}
function tipoDocumento(texto) {
  if (!new RegExp("(?<!\\p{L})Entre(?!\\p{L})", "iu").test(texto)) return null;
  return encabezado(texto)?.tipo ?? null;
}
function describirNoContractual(texto) {
  const encabezado2 = (texto.trim().split("\n")[0] ?? "").trim();
  if (/^COTIZACI[OÓ]N/i.test(encabezado2)) return `es una cotizaci\xF3n (${recortar(encabezado2, 60)}), no un contrato firmado`;
  return encabezado2 ? `el adjunto no es un contrato (\xAB${recortar(encabezado2, 60)}\xBB)` : "el adjunto est\xE1 vac\xEDo";
}
var parrafos = (texto) => texto.split(/\n\s*\n/).map((p) => p.replace(/\s+/g, " ").trim()).filter(Boolean);
var patronEncabezado = (nombre) => new RegExp(`^(?:clausula\\s+)?(?:[a-z]+|\\d+)\\s*[.:\\-\u2013]+\\s*(?:${nombre})(?:\\s+(?:del\\s+contrato|de\\s+ejecucion))?\\s*[.:\\-\u2013]+\\s*`);
function clausula(texto, nombre) {
  const inicio = patronEncabezado(nombre);
  const modificada = new RegExp(`clausula\\s+\\w+\\s+\\((?:${nombre})\\)`);
  return parrafos(texto).find((p) => inicio.test(normalizar(p)) || modificada.test(normalizar(p))) ?? null;
}
function sinEncabezado(parrafo, nombre) {
  const m = normalizar(parrafo.normalize("NFC")).match(patronEncabezado(nombre));
  return m ? parrafo.normalize("NFC").trim().slice(m[0].length) : parrafo;
}
var MESES = {
  enero: 1,
  febrero: 2,
  marzo: 3,
  abril: 4,
  mayo: 5,
  junio: 6,
  julio: 7,
  agosto: 8,
  septiembre: 9,
  setiembre: 9,
  octubre: 10,
  noviembre: 11,
  diciembre: 12
};
var dosDigitos = (n) => String(n).padStart(2, "0");
function fechaIso(anio, mes, dia) {
  const f = new Date(Date.UTC(anio, mes - 1, dia));
  if (f.getUTCFullYear() !== anio || f.getUTCMonth() !== mes - 1 || f.getUTCDate() !== dia) {
    throw new Error(`fecha inv\xE1lida: ${dia}/${mes}/${anio}`);
  }
  return `${anio}-${dosDigitos(mes)}-${dosDigitos(dia)}`;
}
var finDeMes = (anio, mes) => new Date(Date.UTC(anio, mes, 0)).getUTCDate();
function sumarMeses(iso, meses) {
  const [a, m, d] = iso.split("-").map(Number);
  const total = a * 12 + (m - 1) + meses;
  const anio = Math.floor(total / 12);
  const mes = total % 12 + 1;
  return fechaIso(anio, mes, Math.min(d, finDeMes(anio, mes)));
}
function fechasEn(texto) {
  const patron = /\(?\b(\d{1,2})\)?\s+de\s+([a-záéíóú]+)\s+del?\s+(\d{4})/gi;
  return [...texto.matchAll(patron)].filter((m) => normalizar(m[2]) in MESES).map((m) => ({ iso: fechaIso(Number(m[3]), MESES[normalizar(m[2])], Number(m[1])), indice: m.index ?? 0 }));
}
function fechaFirma(texto) {
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
function extraerPlazo(texto, tipo) {
  const parrafo = clausula(texto, "plazo") ?? "";
  const fechas = fechasEn(parrafo);
  const iDesde = parrafo.search(/\bdesde\b|\ba partir del?\s+(?!la fecha)/i);
  const iHasta = parrafo.search(/\bhasta\b/i);
  const inicio = iDesde >= 0 ? fechas.find((f) => f.indice > iDesde && (iHasta < 0 || f.indice < iHasta)) : void 0;
  const fin = iHasta >= 0 ? fechas.find((f) => f.indice > iHasta) : void 0;
  const advertencias = [];
  const fecha_fin = fin ? campo(fin.iso, 0.95, parrafo) : ausente();
  if (tipo === "otrosi") return { fecha_inicio: ausente(), fecha_fin, advertencias };
  let fecha_inicio = inicio ? campo(inicio.iso, 0.95, parrafo) : ausente();
  if (!inicio && /a partir de la fecha de (su )?firma/i.test(parrafo)) {
    const firma = fechaFirma(texto);
    if (firma) {
      fecha_inicio = campo(firma.iso, firma.soloMes ? REGLAS.umbralConfianza : 0.9, firma.evidencia);
      if (firma.soloMes) advertencias.push(`La firma no indica el d\xEDa (\xAB${recortar(firma.evidencia, 60)}\xBB): se toma el \xFAltimo d\xEDa del mes como inicio.`);
    }
  }
  const meses = parrafo.match(/\((\d{1,3})\)\s+meses|\b(\d{1,3})\s+meses/i);
  if (!fin && meses && fecha_inicio.valor) {
    const n = Number(meses[1] ?? meses[2]);
    advertencias.push(`La fecha de fin no est\xE1 escrita: se calcul\xF3 con el plazo de ${n} meses desde ${fecha_inicio.valor}.`);
    return { fecha_inicio, fecha_fin: campo(sumarMeses(fecha_inicio.valor, n), 0.5, parrafo), advertencias };
  }
  return { fecha_inicio, fecha_fin, advertencias };
}
function parsearMonto(crudo) {
  const s = crudo.replace(/\s/g, "");
  const ultimoPunto = s.lastIndexOf(".");
  const ultimaComa = s.lastIndexOf(",");
  let normal;
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
  if (!Number.isFinite(n)) throw new Error(`monto inv\xE1lido: ${crudo}`);
  return n;
}
var PALABRAS_MONEDA = [
  [/\bpesos\b/i, "COP"],
  [/\bd[oó]lares\b/i, "USD"],
  [/\bsoles\b/i, "PEN"],
  [/\bbalboas\b/i, "PAB"],
  [/\blempiras\b/i, "HNL"]
];
var MONEDA_POR_PAIS = { CO: "COP", EC: "USD", PE: "PEN", PA: "PAB", HN: "HNL" };
var esMoneda = (codigo) => MONEDAS.includes(codigo);
var CODIGOS_ISO = [...MONEDAS, "EUR", "GBP", "BRL", "MXN", "CLP", "ARS", "CAD", "CHF", "JPY", "CNY", "UYU", "BOB", "PYG", "CRC", "GTQ", "NIO", "DOP"];
var ISO = CODIGOS_ISO.join("|");
var MONEDA_NO_SOPORTADA = new RegExp("(?<!\\p{L})(euros?|libras(?:\\s+esterlinas)?|reales)(?!\\p{L})|\u20AC|\xA3", "iu");
var errorMoneda = (moneda) => new Error(`moneda desconocida: ${moneda} (se aceptan ${MONEDAS.join(", ")})`);
var indeterminado = (parrafo, texto, pais) => ({ valor: campo(0, 0.5, parrafo), moneda: monedaImplicita(texto, pais), indeterminado: true });
function extraerValor(texto, pais) {
  const parrafo = clausula(texto, "valor") ?? "";
  if (/no tiene (un )?valor determinado|valor indeterminado|por demanda/i.test(parrafo)) return indeterminado(parrafo, texto, pais);
  const conCodigo = parrafo.match(new RegExp(`\\b(${ISO})\\s*\\$?\\s*(\\d[\\d.,]*\\d|\\d)`));
  if (conCodigo) {
    if (!esMoneda(conCodigo[1])) throw errorMoneda(conCodigo[1]);
    return { valor: campo(parsearMonto(conCodigo[2]), 0.95, parrafo), moneda: campo(conCodigo[1], 0.95, parrafo), indeterminado: false };
  }
  const noSoportada = parrafo.match(MONEDA_NO_SOPORTADA);
  if (noSoportada) throw errorMoneda(noSoportada[0]);
  const conSigno = parrafo.match(/\$\s*(\d[\d.,]*\d)/);
  if (conSigno) return { valor: campo(parsearMonto(conSigno[1]), 0.85, parrafo), moneda: monedaImplicita(texto, pais), indeterminado: false };
  if (/seg[uú]n las tarifas/i.test(parrafo)) return indeterminado(parrafo, texto, pais);
  return { valor: ausente(), moneda: monedaImplicita(texto, pais), indeterminado: false };
}
function monedaImplicita(texto, pais) {
  const codigo = texto.match(/\b(COP|USD|PEN|PAB|HNL)\b/);
  if (codigo && esMoneda(codigo[1])) return campo(codigo[1], 0.85, codigo[0]);
  for (const [patron, moneda] of PALABRAS_MONEDA) if (patron.test(texto)) return campo(moneda, 0.85, moneda);
  return pais ? campo(MONEDA_POR_PAIS[pais], 0.6, `moneda del pa\xEDs ${pais}`) : ausente();
}
function normalizarIdentificador(tipo, crudo) {
  const t = tipo.toUpperCase();
  if (t === "RTN") return crudo.replace(/[.\s-]/g, "");
  const sinPuntos = crudo.replace(/[.\s]/g, "");
  return t === "NIT" ? sinPuntos.replace(/-\d$/, "") : sinPuntos;
}
function canonizarRuc(parte, nombrePorId) {
  if (parte.tipoId !== "RUC" || !parte.id.includes("-")) return parte;
  const primero = parte.id.split("-")[0];
  return nombrePorId(primero) ? { ...parte, id: primero } : parte;
}
function contraparte(texto) {
  const plano = texto.replace(/\s+/g, " ");
  const patron = /(?:Entre|,?\s+y)\s+(?:los\s+suscritos,\s*)?([A-ZÁÉÍÓÚÑ][^,]{2,120}?),\s*(?:identificad[ao]\s+con\s+(?:el\s+)?|con\s+(?:el\s+)?)?(NIT|RUC|RTN)\s*(?:No\.?\s*)?(\d[\d.\-]*\d)/g;
  for (const m of plano.matchAll(patron)) {
    const id = normalizarIdentificador(m[2], m[3]);
    if (id !== REGLAS.nitPropio) return { nombre: m[1].trim(), tipoId: m[2].toUpperCase(), id, evidencia: m[0] };
  }
  return null;
}
function paisPorIdentificador(tipo, id) {
  if (tipo === "NIT") return "CO";
  if (tipo === "RTN" || /^\d{14}$/.test(id)) return "HN";
  if (/^\d{13}$/.test(id) && id.endsWith("001")) return "EC";
  if (/^\d{11}$/.test(id)) return "PE";
  if (tipo === "RUC") return "PA";
  return null;
}
var PAIS_POR_LUGAR = [
  [/colombia|bogota|medellin|barranquilla|cali\b|cartagena|bucaramanga/, "CO"],
  [/ecuador|quito|guayaquil|cuenca/, "EC"],
  [/peru|lima\b|arequipa/, "PE"],
  [/panama/, "PA"],
  [/honduras|tegucigalpa|san pedro sula/, "HN"]
];
function paisPorDomicilio(texto, nombre) {
  const plano = normalizar(texto.replace(/\s+/g, " "));
  const desde = plano.indexOf(normalizar(nombre));
  const tramo = desde >= 0 ? plano.slice(desde, desde + 260) : "";
  const domicilio = tramo.match(/domicilio en ([^,]+(?:, [a-z ]+)?)/);
  if (!domicilio) return null;
  for (const [patron, pais] of PAIS_POR_LUGAR) if (patron.test(domicilio[1])) return pais;
  return null;
}
function extraerPais(texto, parte) {
  const porId = paisPorIdentificador(parte.tipoId, parte.id);
  const porDomicilio = paisPorDomicilio(texto, parte.nombre);
  if (porId && porDomicilio) return porId === porDomicilio ? campo(porId, 0.95, parte.evidencia) : campo(porId, 0.5, parte.evidencia);
  if (porId) return campo(porId, 0.9, parte.evidencia);
  if (porDomicilio) return campo(porDomicilio, REGLAS.umbralConfianza, parte.evidencia);
  return ausente();
}
var SUFIJOS = /\s*(s\.?\s*a\.?\s*s\.?|s\.?\s*a\.?\s*c\.?|s\.?\s*de\s*r\.?\s*l\.?|s\.?\s*r\.?\s*l\.?|s\.?\s*a\.?|ltda\.?|e\.?\s*s\.?\s*p\.?)\s*$/i;
function nombreCliente(texto, parte, nombrePorId) {
  const delMaestro = nombrePorId(parte.id);
  if (delMaestro) return campo(delMaestro, 0.95, parte.evidencia);
  const buscado = normalizar(parte.nombre);
  for (const linea of texto.split("\n")) {
    const segmento = linea.split(/\s{2,}/).map((s) => s.trim()).find((s) => normalizar(s) === buscado);
    if (segmento) return campo(segmento, 0.95, segmento);
  }
  const sufijo = parte.nombre.match(SUFIJOS)?.[0]?.trim() ?? "";
  const base = parte.nombre.replace(SUFIJOS, "").toLowerCase().replace(new RegExp("(^|\\s)\\p{L}", "gu"), (l) => l.toUpperCase());
  return campo(`${base}${sufijo ? " " + sufijo.toUpperCase() : ""}`, 0.85, parte.evidencia);
}
function slugCliente(cliente) {
  return normalizar(cliente.replace(SUFIJOS, "")).replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}
function extraerObjeto(texto) {
  const parrafo = clausula(texto, "objeto");
  if (!parrafo) return ausente();
  const cuerpo = sinEncabezado(parrafo, "objeto").replace(/^EL CONTRATISTA\s+se\s+obliga\s+a\s+(ejecutar\s+)?/i, "").replace(/^EL CONTRATISTA\s+prestar[aá]\s+(el\s+servicio\s+de\s+|los\s+servicios\s+de\s+|servicios\s+de\s+)?/i, "").replace(/^(la|el|los|las)\s+/i, "").replace(/\.$/, "");
  const objeto = recortar(cuerpo.charAt(0).toUpperCase() + cuerpo.slice(1), 200);
  return objeto ? campo(objeto, 0.9, parrafo) : ausente();
}
var slugPoliza = (s) => normalizar(s).replace(/\s+y\s+/g, "_").replace(/\s+sociales$/, "").replace(/\s+/g, "_");
var CLAUSULA_POLIZA = "garantia\\w*(?:\\s+y\\s+seguros)?|poliza\\w*|seguros";
var MENCION_POLIZA = /p[oó]liza|garant[ií]a\s+(?:[uú]nica|de\s+cumplimiento)/i;
function tiposPoliza(texto) {
  const tipos = [...texto.matchAll(/(?:p[oó]lizas?|garant[ií]a\s+[uú]nica)\s+de\s+(cumplimiento|calidad|responsabilidad\s+civil|salarios\s+y\s+prestaciones(?:\s+sociales)?|estabilidad)/gi)].map((m) => slugPoliza(m[1]));
  return [...new Set(tipos)].join(";");
}
function polizaSinClausula(texto) {
  const mencion = texto.match(MENCION_POLIZA);
  if (!mencion) return { requiere_poliza: campo(false, 0.9, "el texto no menciona p\xF3lizas ni garant\xEDas"), tipo_poliza: campo("", 0.9), advertencias: [] };
  return {
    requiere_poliza: campo(true, 0.6, mencion[0]),
    tipo_poliza: campo(tiposPoliza(texto), 0.6, mencion[0]),
    advertencias: [`El texto menciona \xAB${mencion[0]}\xBB fuera de una cl\xE1usula de garant\xEDas: se propone que requiere p\xF3liza y se pide revisi\xF3n.`]
  };
}
function extraerPoliza(texto, tipo) {
  if (tipo === "otrosi") return { requiere_poliza: ausente(), tipo_poliza: ausente(), advertencias: [] };
  const parrafo = clausula(texto, CLAUSULA_POLIZA);
  if (!parrafo || !MENCION_POLIZA.test(parrafo)) return polizaSinClausula(texto);
  const lista = tiposPoliza(parrafo);
  if (/para cada orden|cuyo valor supere|en caso de que|cuando el valor/i.test(parrafo)) {
    return {
      requiere_poliza: campo(false, REGLAS.umbralConfianza, parrafo),
      tipo_poliza: campo("", REGLAS.umbralConfianza),
      advertencias: [`P\xF3liza condicional: se exige ${lista || "p\xF3liza"} solo en ciertas \xF3rdenes de servicio (\xAB${recortar(parrafo, 120)}\xBB).`]
    };
  }
  return { requiere_poliza: campo(true, 0.95, parrafo), tipo_poliza: campo(lista, lista ? 0.9 : 0.5, parrafo), advertencias: [] };
}
var PATRON_ID = /([A-Z]{2,4}-\d{4}-\d{1,4})/;
var NUMERO = "N(?:o|\xB0|\xBA)\\.?";
function extraerId(texto, tipo) {
  const plano = (encabezado(texto)?.desdeTitulo ?? texto).replace(/\s+/g, " ");
  const patron = tipo === "otrosi" ? new RegExp(`AL\\s+CONTRATO[^.]*?${NUMERO}\\s*${PATRON_ID.source}`, "i") : new RegExp(`^\\s*CONTRATO[^.]*?${NUMERO}\\s*${PATRON_ID.source}`, "i");
  const m = plano.match(patron);
  return m ? campo(m[1], 0.95, m[0]) : ausente();
}
function extraerContrato(texto, nombrePorId) {
  if (!texto.trim()) throw new Error("el adjunto est\xE1 vac\xEDo");
  const tipo = tipoDocumento(texto);
  if (!tipo) throw new Error(describirNoContractual(texto));
  const encontrada = contraparte(texto);
  const parte = encontrada ? canonizarRuc(encontrada, nombrePorId) : null;
  const pais = parte ? extraerPais(texto, parte) : ausente();
  const plazo = extraerPlazo(texto, tipo);
  const valor = extraerValor(texto, pais.valor);
  const poliza = extraerPoliza(texto, tipo);
  const numero = texto.match(new RegExp(`OTROS[I\xCD]\\s+${NUMERO}\\s*(\\d+)`, "i"));
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
      tipo_poliza: poliza.tipo_poliza
    },
    valor_indeterminado: valor.indeterminado,
    advertencias: [...plazo.advertencias, ...poliza.advertencias]
  };
}

// src/tools/mensajes.ts
import fs2 from "node:fs";
import path3 from "node:path";
function leerAdjunto(ctx, correo, nombre) {
  try {
    const ruta = rutaAdjunto(ctx, correo.id, nombre);
    return { ruta, texto: fs2.readFileSync(ruta, "utf8") };
  } catch {
    return null;
  }
}
function adjuntoContractual(ctx, correo) {
  for (const nombre of correo.adjuntos) {
    const leido = leerAdjunto(ctx, correo, nombre);
    if (leido && tipoDocumento(leido.texto)) return { nombre, ...leido };
  }
  return null;
}
function motivoSinContrato(ctx, correo) {
  if (correo.adjuntos.length === 0) return "el correo no trae adjuntos";
  const leido = leerAdjunto(ctx, correo, correo.adjuntos[0]);
  return leido ? describirNoContractual(leido.texto) : `no se encontr\xF3 o no se pudo leer el adjunto ${correo.adjuntos[0]}`;
}
function errorLegible(e) {
  const crudo = e instanceof Error ? e.message : String(e);
  if (typeof e === "object" && e !== null && "code" in e && e.code === "ENOENT") return `falta el archivo ${path3.basename(String("path" in e ? e.path : ""))}`;
  return crudo.replace(/(?<![\w.])(?:[A-Za-z]:)?[\\/](?:[^\s'"\\/]+[\\/])+([^\s'"\\/]*)/g, "$1");
}
function nombrePorIdentificador(ctx) {
  const filas = leerMaestro(ctx);
  return (id) => filas.find((f) => f.nit_cliente === id)?.cliente ?? null;
}
function resolverComercial(ctx, remitente) {
  const encontrado = leerComerciales(ctx).find((c) => c.email.toLowerCase() === remitente.toLowerCase());
  if (encontrado) return { comercial: { valor: encontrado.nombre, confianza: 1, evidencia: remitente }, advertencia: null };
  return {
    comercial: { valor: null, confianza: 0, evidencia: remitente },
    advertencia: `El remitente ${remitente} no est\xE1 en el cat\xE1logo de comerciales: se reporta y el registro sigue; el campo comercial queda vac\xEDo.`
  };
}
function extraccionDeMensaje(ctx, mensaje_id) {
  const correo = leerCorreo(ctx, mensaje_id);
  const adjunto = adjuntoContractual(ctx, correo);
  if (!adjunto) throw new Error(`${mensaje_id} no trae contrato: ${motivoSinContrato(ctx, correo)}`);
  const ext = extraerContrato(adjunto.texto, nombrePorIdentificador(ctx));
  const { comercial, advertencia } = resolverComercial(ctx, correo.de);
  const requiere = ext.contrato.requiere_poliza;
  const estado = requiere.valor === null ? null : requiere.valor ? "pendiente" : "no_aplica";
  return {
    ...ext,
    mensaje_id,
    adjunto: adjunto.nombre,
    contrato: {
      ...ext.contrato,
      estado_poliza: { valor: estado, confianza: requiere.confianza },
      comercial,
      fecha_registro: { valor: correo.fecha.slice(0, 10), confianza: 1, evidencia: `fecha del correo ${correo.fecha}` },
      fuente: { valor: "buzon", confianza: 1 }
    },
    advertencias: advertencia ? [...ext.advertencias, advertencia] : ext.advertencias
  };
}

// src/tools/alertas.ts
import fs3 from "node:fs";
import path4 from "node:path";
import { z as z3 } from "zod";
var argsAlertas = {
  hoy: z3.string().regex(/^\d{4}-\d{2}-\d{2}$/, "formato esperado AAAA-MM-DD").describe("Fecha de referencia del reporte en formato AAAA-MM-DD, p. ej. 2026-09-03; se pasa como argumento para que el resultado sea determinista")
};
var MS_DIA = 864e5;
function validarHoy(hoy) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(hoy)) throw new Error(`la fecha de referencia \xAB${hoy}\xBB no tiene el formato AAAA-MM-DD`);
  const [a, m, d] = hoy.split("-").map(Number);
  try {
    fechaIso(a, m, d);
  } catch {
    throw new Error(`la fecha de referencia \xAB${hoy}\xBB no existe en el calendario`);
  }
}
var aMs = (iso) => {
  const [a, m, d] = iso.split("-").map(Number);
  return Date.UTC(a, m - 1, d);
};
function diasEntre(desde, fin) {
  return Math.round((aMs(fin) - aMs(desde)) / MS_DIA);
}
function calcularVencen(filas, hoy) {
  return filas.filter((f) => f.fecha_fin !== "").map((f) => ({ id_contrato: f.id_contrato, cliente: f.cliente, fecha_fin: f.fecha_fin, dias_restantes: diasEntre(hoy, f.fecha_fin), comercial: f.comercial })).filter((c) => c.dias_restantes >= 0 && c.dias_restantes <= REGLAS.diasAlertaVencimiento).sort((a, b) => a.dias_restantes - b.dias_restantes || a.id_contrato.localeCompare(b.id_contrato));
}
function calcularVencidos(filas, hoy) {
  return filas.filter((f) => f.fecha_fin !== "").map((f) => ({ id_contrato: f.id_contrato, cliente: f.cliente, fecha_fin: f.fecha_fin, dias_restantes: diasEntre(hoy, f.fecha_fin) })).filter((c) => c.dias_restantes < 0).sort((a, b) => b.dias_restantes - a.dias_restantes || a.id_contrato.localeCompare(b.id_contrato));
}
function calcularPolizasPendientes(filas) {
  return filas.filter((f) => f.requiere_poliza === "true" && f.estado_poliza !== "vigente").map((f) => ({ id_contrato: f.id_contrato, cliente: f.cliente, tipo_poliza: f.tipo_poliza, estado_poliza: f.estado_poliza, comercial: f.comercial }));
}
function calcularRegistrados(filas) {
  return filas.filter((f) => f.fecha_registro >= REGLAS.fechaCorte).map((f) => ({ id_contrato: f.id_contrato, cliente: f.cliente, fecha_registro: f.fecha_registro, fuente: f.fuente })).sort((a, b) => a.fecha_registro.localeCompare(b.fecha_registro) || a.id_contrato.localeCompare(b.id_contrato));
}
function tabla(cabeceras, filas, vacio) {
  if (filas.length === 0) return `_${vacio}_`;
  const celda = (v) => v.replace(/\|/g, "\\|") || "\u2014";
  const linea = (c) => `| ${c.map(celda).join(" | ")} |`;
  return [linea(cabeceras), linea(cabeceras.map(() => "---")), ...filas.map(linea)].join("\n");
}
function renderizar(hoy, r) {
  const ventana = REGLAS.diasAlertaVencimiento;
  return [
    "# Alertas de contratos",
    "",
    `Fecha de referencia: **${hoy}**.`,
    "",
    `## Vencen en \u2264 ${ventana} d\xEDas`,
    "",
    tabla(
      ["Contrato", "Cliente", "Fecha fin", "D\xEDas restantes", "Comercial"],
      r.vencen.map((c) => [c.id_contrato, c.cliente, c.fecha_fin, String(c.dias_restantes), c.comercial]),
      `Ning\xFAn contrato vence en los pr\xF3ximos ${ventana} d\xEDas.`
    ),
    "",
    "### Vencidos sin renovaci\xF3n registrada",
    "",
    tabla(
      ["Contrato", "Cliente", "Fecha fin", "D\xEDas restantes"],
      r.vencidos.map((c) => [c.id_contrato, c.cliente, c.fecha_fin, String(c.dias_restantes)]),
      "Ning\xFAn contrato vencido."
    ),
    "",
    "## P\xF3lizas pendientes (requiere_poliza = true y estado_poliza != vigente)",
    "",
    tabla(
      ["Contrato", "Cliente", "Tipo de p\xF3liza", "Estado", "Comercial"],
      r.polizas_pendientes.map((c) => [c.id_contrato, c.cliente, c.tipo_poliza, c.estado_poliza, c.comercial]),
      "Ninguna p\xF3liza pendiente."
    ),
    "",
    `## Registrados desde el ${REGLAS.fechaCorte} (gap cubierto)`,
    "",
    tabla(
      ["Contrato", "Cliente", "Fecha de registro", "Fuente"],
      r.registrados_desde_corte.map((c) => [c.id_contrato, c.cliente, c.fecha_registro, c.fuente]),
      "Ning\xFAn contrato registrado desde el corte."
    ),
    ""
  ].join("\n");
}
function generarAlertas(ctx, hoy) {
  validarHoy(hoy);
  const filas = leerMaestro(ctx);
  const partes = {
    vencen: calcularVencen(filas, hoy),
    polizas_pendientes: calcularPolizasPendientes(filas),
    registrados_desde_corte: calcularRegistrados(filas),
    vencidos: calcularVencidos(filas, hoy)
  };
  const destino = rutas(ctx).alertas;
  fs3.mkdirSync(path4.dirname(destino), { recursive: true });
  fs3.writeFileSync(destino, renderizar(hoy, partes));
  const resumen = `${partes.vencen.length} vencen en \u2264 ${REGLAS.diasAlertaVencimiento} d\xEDas, ${partes.vencidos.length} vencidos, ${partes.polizas_pendientes.length} p\xF3lizas pendientes, ${partes.registrados_desde_corte.length} registrados desde el corte (referencia ${hoy})`;
  return { ruta: path4.relative(path4.resolve(ctx.directory), destino).split(path4.sep).join("/"), ...partes, resumen };
}

// src/tools/clasificacion.ts
import { z as z4 } from "zod";
var esquemaContratoCorregido = z4.object({
  id_contrato: z4.string().optional().describe("N\xFAmero del contrato tal como aparece en el documento (letras, n\xFAmeros y guiones)"),
  cliente: z4.string().optional().describe("Raz\xF3n social de la contraparte"),
  nit_cliente: z4.string().optional().describe("Identificador tributario sin d\xEDgito de verificaci\xF3n ni puntos"),
  pais: z4.string().optional().describe(`Pa\xEDs de la contraparte: ${PAISES.join(", ")}`),
  objeto: z4.string().optional().describe("Objeto del contrato, m\xE1ximo 200 caracteres"),
  valor: z4.number().optional().describe("Valor total sin separadores; 0 si el contrato es por demanda"),
  moneda: z4.string().optional().describe(`Moneda del valor: ${MONEDAS.join(", ")}`),
  fecha_inicio: z4.string().optional().describe("Fecha de inicio en formato YYYY-MM-DD"),
  fecha_fin: z4.string().optional().describe("Fecha de fin en formato YYYY-MM-DD"),
  requiere_poliza: z4.boolean().optional().describe("true si el contrato exige p\xF3liza"),
  tipo_poliza: z4.string().optional().describe("Tipos de p\xF3liza separados por ';'; vac\xEDo si no requiere")
});
function aTexto(v) {
  if (v === null || v === void 0) return "";
  return String(v);
}
function validarFecha(campo2, valor) {
  const m = valor.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) throw new Error(`${campo2} inv\xE1lida: \xAB${valor}\xBB (se espera YYYY-MM-DD)`);
  fechaIso(Number(m[1]), Number(m[2]), Number(m[3]));
}
function validarCorregido(c) {
  if (c.id_contrato !== void 0 && !/^[A-Za-z0-9][\w-]*$/.test(c.id_contrato)) {
    throw new Error(`id_contrato inv\xE1lido: \xAB${c.id_contrato}\xBB (solo letras, n\xFAmeros y guiones)`);
  }
  if (c.moneda !== void 0 && !MONEDAS.includes(c.moneda)) {
    throw new Error(`moneda desconocida: ${c.moneda} (se aceptan ${MONEDAS.join(", ")})`);
  }
  if (c.pais !== void 0 && !PAISES.includes(c.pais)) {
    throw new Error(`pa\xEDs desconocido: ${c.pais} (se aceptan ${PAISES.join(", ")})`);
  }
  if (c.valor !== void 0 && !(Number.isFinite(c.valor) && c.valor >= 0)) throw new Error(`valor inv\xE1lido: ${c.valor} (n\xFAmero mayor o igual a 0)`);
  if (c.objeto !== void 0 && c.objeto.length > 200) throw new Error("objeto inv\xE1lido: supera los 200 caracteres");
  if (c.fecha_inicio !== void 0) validarFecha("fecha_inicio", c.fecha_inicio);
  if (c.fecha_fin !== void 0) validarFecha("fecha_fin", c.fecha_fin);
}
var PALABRAS_VACIAS = /* @__PURE__ */ new Set([
  "a",
  "al",
  "con",
  "de",
  "del",
  "e",
  "el",
  "en",
  "la",
  "las",
  "lo",
  "los",
  "o",
  "para",
  "por",
  "se",
  "su",
  "sus",
  "u",
  "un",
  "una",
  "y",
  "contratante",
  "contratista",
  "servicio",
  "parte",
  "presente",
  "contrato",
  "prestacion"
]);
function singular(t) {
  if (t.length <= 3) return t;
  if (/[lnrdzj]es$/.test(t)) return t.slice(0, -2);
  return t.endsWith("s") ? t.slice(0, -1) : t;
}
function tokensObjeto(texto) {
  return new Set(normalizar(texto).split(/[^a-z0-9]+/).filter(Boolean).map(singular).filter((t) => !PALABRAS_VACIAS.has(t)));
}
function similitudObjeto(a, b) {
  const ta = tokensObjeto(a);
  const tb = tokensObjeto(b);
  const comunes = [...ta].filter((t) => tb.has(t)).length;
  const union = ta.size + tb.size - comunes;
  return union === 0 ? 0 : comunes / union;
}
function camposTraidos(ext, c) {
  return CAMPOS_CON_CONFIANZA.filter((k) => ext.contrato[k].valor !== null || c[k] !== void 0);
}
function valoresFinales(ext, c) {
  const pares = CAMPOS_CON_CONFIANZA.map((k) => [k, aTexto(c[k] !== void 0 ? c[k] : ext.contrato[k].valor)]);
  return Object.fromEntries(pares);
}
function camposEnRevision(ext, c) {
  const evaluables = ext.tipo_documento === "otrosi" ? camposTraidos(ext, c) : CAMPOS_CON_CONFIANZA;
  return CAMPOS_CON_CONFIANZA.filter((k) => {
    const dudoso = evaluables.includes(k) && ext.contrato[k].confianza < REGLAS.umbralConfianza;
    const corregido = c[k] !== void 0 && aTexto(c[k]) !== aTexto(ext.contrato[k].valor);
    return dudoso || corregido;
  });
}
function correccionesFueraDeRevision(ext, c) {
  const enRevision = camposEnRevision(ext, {});
  return CAMPOS_CON_CONFIANZA.filter((k) => c[k] !== void 0 && aTexto(c[k]) !== aTexto(ext.contrato[k].valor) && !enRevision.includes(k));
}
function confirmadosDe(ext, revision, fila) {
  const campos = CAMPOS_CON_CONFIANZA.filter((k) => revision.includes(k));
  return Object.fromEntries(campos.map((k) => {
    const extraido = ext.contrato[k].valor;
    return [k, { propuesto: extraido === null ? null : aTexto(extraido), confirmado: fila[k] }];
  }));
}
function buscarCoincidencia(v, tipo, maestro) {
  const porId = v.id_contrato ? maestro.find((f) => f.id_contrato === v.id_contrato) : void 0;
  if (porId) return { fila: porId, por: "id" };
  if (tipo === "otrosi" || !v.nit_cliente || !v.objeto) return null;
  for (const fila of maestro.filter((f) => f.nit_cliente === v.nit_cliente)) {
    const similitud = similitudObjeto(fila.objeto, v.objeto);
    if (similitud >= REGLAS.similitudObjeto) return { fila, por: "nit_objeto", similitud };
  }
  return null;
}
function conflictos(v, co) {
  const lista = [];
  if (co.por === "nit_objeto" && v.id_contrato && v.id_contrato !== co.fila.id_contrato) lista.push("conflicto: id_contrato");
  for (const k of ["nit_cliente", "moneda"]) {
    if (v[k] && co.fila[k] && v[k] !== co.fila[k]) lista.push(`conflicto: ${k}`);
  }
  return lista;
}
function calcularDiferencias(fila, v, traidos) {
  const d = {};
  for (const k of traidos) if (k !== "id_contrato" && v[k] !== fila[k]) d[k] = { antes: fila[k], despues: v[k] };
  const conPoliza = (d.requiere_poliza?.despues ?? fila.requiere_poliza) === "true";
  const extiende = d.fecha_fin !== void 0 && d.fecha_fin.despues > d.fecha_fin.antes;
  const sube = d.valor !== void 0 && Number(d.valor.despues) > Number(d.valor.antes);
  if (conPoliza && (extiende || sube) && fila.estado_poliza !== "pendiente") {
    d.estado_poliza = { antes: fila.estado_poliza, despues: "pendiente" };
  }
  return d;
}
function rechazo(motivo, advertencias = []) {
  return { clasificacion: "rechazado", requiere_revision: [], motivo, advertencias, propuesta: null };
}
function motivoRN4(v) {
  if (!v.cliente && !v.nit_cliente && !v.objeto) return "el documento no identifica a las partes ni el objeto del contrato";
  return null;
}
function idAutomatico(anio, maestro) {
  const prefijo = `AUTO-${anio}-`;
  const usados = maestro.filter((f) => f.id_contrato.startsWith(prefijo)).map((f) => Number(f.id_contrato.slice(prefijo.length)) || 0);
  return `${prefijo}${String(Math.max(0, ...usados) + 1).padStart(3, "0")}`;
}
function filaNueva(v, e) {
  const anio = (v.fecha_inicio || e.fecha_registro).slice(0, 4);
  return {
    ...v,
    id_contrato: v.id_contrato || idAutomatico(anio, e.maestro),
    estado_poliza: v.requiere_poliza === "true" ? "pendiente" : "no_aplica",
    comercial: e.comercial,
    ruta_sharepoint: "",
    fecha_registro: e.fecha_registro,
    fuente: "buzon"
  };
}
function verificarFechas(fila) {
  if (fila.fecha_inicio && fila.fecha_fin && fila.fecha_fin < fila.fecha_inicio) {
    throw new Error(`fecha_fin ${fila.fecha_fin} es anterior a fecha_inicio ${fila.fecha_inicio}`);
  }
}
function frenteAExistente(v, e, co, revision) {
  const choques = conflictos(v, co);
  const diferencias = calcularDiferencias(co.fila, v, camposTraidos(e.extraccion, e.corregido));
  const mismasFechasYValor = ["valor", "fecha_inicio", "fecha_fin"].every((k) => v[k] === co.fila[k]);
  const sinCambios = Object.keys(diferencias).length === 0;
  const rn1 = e.extraccion.tipo_documento === "otrosi" ? sinCambios : mismasFechasYValor || sinCambios;
  const base = { id_contrato_existente: co.fila.id_contrato, advertencias: [...e.extraccion.advertencias] };
  if (co.por === "nit_objeto") {
    base.advertencias.push(`Coincide por NIT y objeto (similitud ${co.similitud?.toFixed(2)}) con ${co.fila.id_contrato}.`);
  }
  if (rn1 && choques.length === 0) return { ...base, clasificacion: "duplicado", requiere_revision: [], propuesta: co.fila };
  const propuesta = { ...co.fila, ...Object.fromEntries(Object.entries(diferencias).map(([k, d]) => [k, d.despues])) };
  verificarFechas(propuesta);
  return { ...base, clasificacion: "actualizacion", requiere_revision: [...revision, ...choques], diferencias, propuesta };
}
function clasificar(e) {
  validarCorregido(e.corregido);
  const tipo = e.extraccion.tipo_documento;
  const v = valoresFinales(e.extraccion, e.corregido);
  const motivo = motivoRN4(v);
  if (motivo) return rechazo(motivo, e.extraccion.advertencias);
  const revision = camposEnRevision(e.extraccion, e.corregido);
  const co = buscarCoincidencia(v, tipo, e.maestro);
  if (co) return frenteAExistente(v, e, co, revision);
  if (tipo === "otrosi") {
    const motivoOtrosi = `el otros\xED modifica el contrato ${v.id_contrato || "sin n\xFAmero"}, que no est\xE1 en el maestro: no se registra ni se marca procesado; queda pendiente en el buz\xF3n para escalarlo o esperar el contrato base`;
    return { ...rechazo(motivoOtrosi, e.extraccion.advertencias), pendiente: true };
  }
  const propuesta = filaNueva(v, e);
  verificarFechas(propuesta);
  return { clasificacion: "nuevo", requiere_revision: revision, advertencias: e.extraccion.advertencias, propuesta };
}

// src/tools/contratos.ts
var mensajeId = z5.string().regex(/^[\w-]+$/).describe("Id del mensaje del buz\xF3n, tal como lo devuelve contratos_leer_buzon");
function protegido(logica) {
  return seguro(() => {
    try {
      return logica();
    } catch (e) {
      throw new Error(errorLegible(e));
    }
  });
}
var extraer = {
  description: "Extrae del contrato adjunto a un mensaje los datos del maestro con una confianza entre 0 y 1 por campo; un campo ausente viene en null, nunca inventado.",
  args: { mensaje_id: mensajeId },
  execute: (args, ctx) => protegido(() => {
    const { mensaje_id } = args;
    const e = extraccionDeMensaje(ctx, mensaje_id);
    const bajos = CAMPOS_CON_CONFIANZA.filter((k) => e.contrato[k].valor !== null && e.contrato[k].confianza < REGLAS.umbralConfianza);
    return ok({ ...e, resumen: `${e.contrato.id_contrato.valor ?? "sin id"} (${e.tipo_documento}); confianza baja en: ${bajos.join(", ") || "ninguno"}` });
  })
};
function resumirCorreo(ctx, correo) {
  const tiene_contrato = adjuntoContractual(ctx, correo) !== null;
  const base = { id: correo.id, de: correo.de, asunto: correo.asunto, fecha: correo.fecha, adjuntos: correo.adjuntos, tiene_contrato };
  return tiene_contrato ? base : { ...base, clasificacion: "rechazado", motivo: motivoSinContrato(ctx, correo) };
}
function mensajeDelBuzon(ctx, id) {
  try {
    return { ...resumirCorreo(ctx, leerCorreo(ctx, id)), id };
  } catch (e) {
    return { id, de: "", asunto: "", fecha: "", adjuntos: [], tiene_contrato: false, clasificacion: "rechazado", motivo: `correo ilegible: ${errorLegible(e)}` };
  }
}
var leer_buzon = {
  description: "Lista los mensajes del buz\xF3n que a\xFAn no se han procesado, con remitente, asunto, fecha, adjuntos y si traen contrato.",
  args: {},
  execute: (_args, ctx) => protegido(() => {
    const procesados = leerProcesados(ctx);
    const mensajes = listarMensajes(ctx).filter((id) => !(id in procesados)).map((id) => mensajeDelBuzon(ctx, id));
    return ok({ mensajes, resumen: `${mensajes.length} mensajes pendientes` });
  })
};
var contrato = esquemaContratoCorregido.optional().describe("Valores corregidos por la analista, planos y opcionales; lo omitido toma lo extra\xEDdo por contratos_extraer");
function evaluar(ctx, mensaje_id, corregido) {
  validarCorregido(corregido);
  const correo = leerCorreo(ctx, mensaje_id);
  if (!adjuntoContractual(ctx, correo)) return { resultado: rechazo(motivoSinContrato(ctx, correo)), extraccion: null };
  const extraccion = extraccionDeMensaje(ctx, mensaje_id);
  const resultado = clasificar({
    extraccion,
    corregido,
    comercial: extraccion.contrato.comercial.valor ?? "",
    fecha_registro: extraccion.contrato.fecha_registro.valor ?? correo.fecha.slice(0, 10),
    maestro: leerMaestro(ctx)
  });
  return { resultado, extraccion };
}
var idDe = (r) => r.id_contrato_existente ?? (r.propuesta?.id_contrato || null);
var validar = {
  description: "Clasifica el contrato de un mensaje como nuevo, actualizacion, duplicado o rechazado frente al maestro, con los campos que requieren revisi\xF3n humana y la fila que se escribir\xEDa; no escribe nada.",
  args: { mensaje_id: mensajeId, contrato },
  execute: (args, ctx) => protegido(() => {
    const { mensaje_id, contrato: corregido } = args;
    const { resultado: r } = evaluar(ctx, mensaje_id, corregido ?? {});
    const sobre = r.id_contrato_existente ? ` sobre ${r.id_contrato_existente}` : "";
    const resumen = `${mensaje_id}: ${r.clasificacion}${sobre}; revisi\xF3n: ${r.requiere_revision.join(", ") || "ninguna"}`;
    return ok({ mensaje_id, ...r, resumen });
  })
};
function rutaContrato(fila, nombre, adjunto) {
  const anio = (fila.fecha_inicio || fila.fecha_registro).slice(0, 4);
  return path5.posix.join("Contratos", anio, slugCliente(fila.cliente) || "sin-cliente", `${nombre}${path5.extname(adjunto)}`);
}
function lineaHistorial(base, ext, r, fila) {
  const confirmados = confirmadosDe(ext, r.requiere_revision, fila);
  return Object.keys(confirmados).length > 0 ? { ...base, confirmados } : base;
}
var cambiosNuevo = (fila) => Object.fromEntries(COLUMNAS_MAESTRO.map((c) => [c, { antes: null, despues: fila[c] }]));
function registrarNuevo(ctx, mensaje_id, ext, r, propuesta) {
  const ruta = rutaContrato(propuesta, propuesta.id_contrato, ext.adjunto);
  const fila = { ...propuesta, ruta_sharepoint: ruta };
  archivar(ctx, rutaAdjunto(ctx, mensaje_id, ext.adjunto), ruta);
  escribirMaestro(ctx, [...leerMaestro(ctx), fila]);
  const base = { id_contrato: fila.id_contrato, accion: "nuevo", cambios: cambiosNuevo(fila), mensaje_id, archivo: ruta };
  anotarHistorial(ctx, lineaHistorial(base, ext, r, fila));
  return { id_contrato: fila.id_contrato, accion: "nuevo", ruta_archivo: ruta };
}
function registrarActualizacion(ctx, mensaje_id, ext, r, propuesta) {
  const id = propuesta.id_contrato;
  const nombre = ext.tipo_documento === "otrosi" ? `${id}-otrosi-${ext.numero_otrosi ?? 1}` : `${id}-${mensaje_id}`;
  const ruta = archivar(ctx, rutaAdjunto(ctx, mensaje_id, ext.adjunto), rutaContrato(propuesta, nombre, ext.adjunto));
  escribirMaestro(ctx, leerMaestro(ctx).map((f) => f.id_contrato === r.id_contrato_existente ? propuesta : f));
  const cambios = r.diferencias ?? {};
  anotarHistorial(ctx, lineaHistorial({ id_contrato: id, accion: "actualizacion", cambios, mensaje_id, archivo: ruta }, ext, r, propuesta));
  return { id_contrato: id, accion: "actualizacion", ruta_archivo: ruta };
}
function escribir(ctx, mensaje_id, ev) {
  const r = ev.resultado;
  if (ev.extraccion && r.propuesta && r.clasificacion === "nuevo") return registrarNuevo(ctx, mensaje_id, ev.extraccion, r, r.propuesta);
  if (ev.extraccion && r.propuesta && r.clasificacion === "actualizacion") {
    return registrarActualizacion(ctx, mensaje_id, ev.extraccion, r, r.propuesta);
  }
  return { id_contrato: idDe(r), accion: r.clasificacion, ruta_archivo: null, ...r.motivo ? { motivo: r.motivo } : {} };
}
function mensajeColados(campos) {
  return campos.length === 1 ? `el campo ${campos[0]} no estaba en revisi\xF3n: no se puede cambiar al confirmar; valida de nuevo y pide confirmaci\xF3n` : `los campos ${campos.join(", ")} no estaban en revisi\xF3n: no se pueden cambiar al confirmar; valida de nuevo y pide confirmaci\xF3n`;
}
var registrar = {
  description: "Registra el contrato de un mensaje en el maestro y lo archiva tras revalidarlo; si hay campos en revisi\xF3n exige confirmado: true, y los duplicados y rechazados solo quedan marcados como procesados.",
  args: {
    mensaje_id: mensajeId,
    contrato,
    confirmado: z5.boolean().optional().describe("true solo si la analista confirm\xF3 en un mensaje propio los campos en revisi\xF3n")
  },
  execute: (args, ctx) => protegido(() => {
    const { mensaje_id, contrato: corregido, confirmado } = args;
    const ev = evaluar(ctx, mensaje_id, corregido ?? {});
    const revision = ev.resultado.requiere_revision;
    if (revision.length > 0 && confirmado !== true) return fallo(`requiere revisi\xF3n: ${revision.join(", ")}`);
    const colados = confirmado === true && ev.extraccion ? correccionesFueraDeRevision(ev.extraccion, corregido ?? {}) : [];
    if (colados.length > 0) return fallo(mensajeColados(colados));
    const hecho = escribir(ctx, mensaje_id, ev);
    if (!ev.resultado.pendiente) marcarProcesado(ctx, mensaje_id, hecho.accion, hecho.id_contrato);
    const resumen = `${mensaje_id}: ${hecho.accion} ${hecho.id_contrato ?? "sin id"}; ${hecho.ruta_archivo ?? "sin escritura"}`;
    return ok({ ...hecho, ...ev.resultado.pendiente ? { procesado: false } : {}, resumen });
  })
};
var alertas = {
  description: "Genera out/alertas.md con los contratos que vencen en 60 d\xEDas o menos desde \xABhoy\xBB, las p\xF3lizas exigidas que no est\xE1n vigentes y los contratos registrados desde el corte del 2026-05-30.",
  args: argsAlertas,
  execute: (args, ctx) => protegido(() => ok(generarAlertas(ctx, args.hoy)))
};
export {
  alertas,
  extraer,
  leer_buzon,
  registrar,
  validar
};
