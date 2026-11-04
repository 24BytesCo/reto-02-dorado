import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { dirSalida, type Contexto } from "./nucleo.ts";
import { COLUMNAS_MAESTRO, type Columna, type FilaMaestro } from "./reglas.ts";

/** Rutas de entrada (solo lectura) y de salida, resueltas desde `ctx.directory`. */
export function rutas(ctx: Contexto) {
  const fixtures = path.resolve(ctx.directory, "fixtures/reto-02");
  const out = dirSalida(ctx);
  const sharepoint = path.join(out, "sharepoint");
  return {
    buzon: path.resolve(ctx.directory, process.env.BUZON_DIR || "fixtures/reto-02/buzon"),
    maestroOriginal: path.join(fixtures, "maestro-contratos.csv"),
    comerciales: path.join(fixtures, "comerciales.json"),
    out,
    sharepoint,
    maestro: path.join(sharepoint, "maestro-contratos.csv"),
    historial: path.join(sharepoint, "historial.jsonl"),
    procesados: path.join(out, "procesados.json"),
    alertas: path.join(out, "alertas.md"),
  };
}

// ── CSV (RFC 4180): todo se lee como texto para no perder ceros a la izquierda ──

/** Parsea un CSV con comillas, comas y saltos de línea dentro de los campos. */
export function parsearCsv(texto: string): string[][] {
  const registros: string[][] = [];
  let campo = "";
  let fila: string[] = [];
  let entreComillas = false;
  for (let i = 0; i < texto.length; i++) {
    const c = texto[i];
    if (entreComillas) {
      if (c === '"' && texto[i + 1] === '"') { campo += '"'; i++; }
      else if (c === '"') entreComillas = false;
      else campo += c;
    } else if (c === '"') entreComillas = true;
    else if (c === ",") { fila.push(campo); campo = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && texto[i + 1] === "\n") i++;
      fila.push(campo); campo = "";
      registros.push(fila); fila = [];
    } else campo += c;
  }
  if (campo !== "" || fila.length > 0) { fila.push(campo); registros.push(fila); }
  return registros;
}

/** Serializa con comillas solo donde hacen falta, LF y salto final. */
export function serializarCsv(registros: string[][]): string {
  const celda = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return registros.map((r) => r.map(celda).join(",")).join("\n") + "\n";
}

// ── Maestro: el fixture es de solo lectura; se trabaja sobre la copia en out/ (RN6) ──

/** Lee la copia del maestro en `out/sharepoint/`, creándola desde el fixture la primera vez (RN6). */
export function leerMaestro(ctx: Contexto): FilaMaestro[] {
  const r = rutas(ctx);
  if (!fs.existsSync(r.maestro)) {
    fs.mkdirSync(r.sharepoint, { recursive: true });
    fs.copyFileSync(r.maestroOriginal, r.maestro);
  }
  const [cabecera, ...filas] = parsearCsv(fs.readFileSync(r.maestro, "utf8"));
  if (cabecera.join(",") !== COLUMNAS_MAESTRO.join(",")) throw new Error("el maestro no tiene las columnas esperadas (PRD §7.2)");
  return filas.map((f) => Object.fromEntries(COLUMNAS_MAESTRO.map((c, i) => [c, f[i] ?? ""])) as FilaMaestro);
}

const COLUMNAS_TEXTO_LIBRE: readonly Columna[] = ["cliente", "objeto", "tipo_poliza", "comercial"];

/** Antepone un apóstrofo al texto que Excel interpretaría como fórmula (= + - @ tabulador o retorno). */
function neutralizarFormula(valor: string): string {
  return /^[=+\-@\t\r]/.test(valor) ? `'${valor}` : valor;
}

/** Valor de una celda del maestro: las columnas de texto libre vienen del correo y se neutralizan. */
function celdaMaestro(fila: FilaMaestro, columna: Columna): string {
  return COLUMNAS_TEXTO_LIBRE.includes(columna) ? neutralizarFormula(fila[columna]) : fila[columna];
}

/**
 * Escribe un archivo de forma atómica (PRD §8 confiabilidad, O2): primero a un temporal en la misma carpeta y luego
 * `renameSync`, que en el mismo sistema de archivos reemplaza el destino de una vez. Si el proceso muere a mitad,
 * queda el archivo anterior entero y un `.tmp` huérfano, nunca un maestro o un `procesados.json` a medias.
 */
export function escribirAtomico(ruta: string, contenido: string): void {
  fs.mkdirSync(path.dirname(ruta), { recursive: true });
  const temporal = `${ruta}.${process.pid}.tmp`;
  fs.writeFileSync(temporal, contenido);
  fs.renameSync(temporal, ruta);
}

/**
 * Reescribe la copia del maestro conservando encabezado y orden de columnas, de forma atómica (O2).
 * Neutraliza la inyección de fórmulas en las columnas de texto libre (seguridad, PRD §8).
 */
export function escribirMaestro(ctx: Contexto, filas: FilaMaestro[]): void {
  const registros = [[...COLUMNAS_MAESTRO], ...filas.map((f) => COLUMNAS_MAESTRO.map((c) => celdaMaestro(f, c)))];
  escribirAtomico(rutas(ctx).maestro, serializarCsv(registros));
}

/**
 * Vacía `out/` (demo y reinicio). Borra el contenido y no la carpeta: en producción `out/` es un
 * volumen de Docker y borrar el punto de montaje falla con EBUSY. Se niega a operar fuera del proyecto.
 */
export function limpiarSalida(ctx: Contexto): void {
  const out = rutas(ctx).out;
  if (!out.startsWith(path.resolve(ctx.directory) + path.sep)) throw new Error("OUT_DIR debe estar dentro del proyecto");
  if (!fs.existsSync(out)) return;
  for (const nombre of fs.readdirSync(out)) fs.rmSync(path.join(out, nombre), { recursive: true, force: true });
}

// ── Procesados, historial y archivo ──

/**
 * Entrada de `out/procesados.json`: cómo terminó un mensaje del buzón (HU-1, HU-4). `accion`, `id_contrato` y `ts`
 * son los del primer procesamiento y no se reescriben; `ultima_accion` e `intentos` cuentan los reintentos.
 */
export interface Procesado {
  accion: string;
  id_contrato: string | null;
  ts: string;
  ultima_accion?: string;
  intentos?: number;
}

/** Mensajes ya procesados (HU-1): `{ [mensaje_id]: { accion, id_contrato, ts, ultima_accion, intentos } }`. */
export function leerProcesados(ctx: Contexto): Record<string, Procesado> {
  const p = rutas(ctx).procesados;
  if (!fs.existsSync(p)) return {};
  try {
    return JSON.parse(fs.readFileSync(p, "utf8")) as Record<string, Procesado>;
  } catch {
    throw new Error("out/procesados.json está dañado (JSON incompleto): no se escribe nada hasta revisarlo o restaurarlo");
  }
}

/**
 * Marca un mensaje como procesado para que no vuelva a aparecer en el buzón (HU-4), con escritura atómica (O2).
 * Un reintento conserva la primera acción (lo que de verdad pasó con el correo) y solo actualiza `ultima_accion`
 * e `intentos`: re-registrar msg-001 no lo convierte de `nuevo` en `duplicado`.
 */
export function marcarProcesado(ctx: Contexto, mensajeId: string, accion: string, idContrato: string | null): void {
  const todos = leerProcesados(ctx);
  const previo = Object.hasOwn(todos, mensajeId) ? todos[mensajeId] : undefined;
  todos[mensajeId] = previo
    ? { ...previo, ultima_accion: accion, intentos: (previo.intentos ?? 1) + 1 }
    : { accion, id_contrato: idContrato, ts: new Date().toISOString(), ultima_accion: accion, intentos: 1 };
  escribirAtomico(rutas(ctx).procesados, JSON.stringify(todos, null, 2) + "\n");
}

/** Agrega `{ ts, id_contrato, accion, cambios, mensaje_id }` a `historial.jsonl` (HU-4, O2). */
export function anotarHistorial(ctx: Contexto, entrada: { id_contrato: string; accion: string; cambios: unknown; mensaje_id: string }): void {
  fs.mkdirSync(rutas(ctx).sharepoint, { recursive: true });
  const linea = { ts: new Date().toISOString(), ...entrada };
  fs.appendFileSync(rutas(ctx).historial, JSON.stringify(linea) + "\n");
}

/** Copia un adjunto a `out/sharepoint/<relativa>` y devuelve la ruta relativa que se guarda en el maestro. */
export function archivar(ctx: Contexto, origen: string, relativa: string): string {
  const destino = path.join(rutas(ctx).sharepoint, relativa);
  fs.mkdirSync(path.dirname(destino), { recursive: true });
  fs.copyFileSync(origen, destino);
  return relativa;
}

// ── Buzón y catálogo de comerciales (todo JSON externo pasa por zod) ──

const Correo = z.object({
  id: z.string(),
  de: z.string(),
  para: z.string().optional(),
  asunto: z.string(),
  fecha: z.string(),
  cuerpo: z.string().optional(),
  adjuntos: z.array(z.string()),
});
/** Un `correo.json` del buzón ya validado (PRD §7.1). */
export type Correo = z.infer<typeof Correo>;

const Comerciales = z.array(z.object({ email: z.string(), nombre: z.string(), region: z.string() }));
/** Una entrada de `comerciales.json` (PRD §7.1). */
export type Comercial = z.infer<typeof Comerciales>[number];

/** Ids de los mensajes del buzón, en orden. */
export function listarMensajes(ctx: Contexto): string[] {
  const dir = rutas(ctx).buzon;
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
}

/** Valida que el id exista en el buzón; impide rutas como `../../.env`. */
export function carpetaMensaje(ctx: Contexto, mensajeId: string): string {
  if (!/^[\w-]+$/.test(mensajeId) || !listarMensajes(ctx).includes(mensajeId)) {
    throw new Error(`el mensaje ${mensajeId} no existe en el buzón`);
  }
  return path.join(rutas(ctx).buzon, mensajeId);
}

/** Lee y valida `correo.json` de un mensaje; si no cumple, lanza un error legible sin rutas absolutas. */
export function leerCorreo(ctx: Contexto, mensajeId: string): Correo {
  const crudo: unknown = JSON.parse(fs.readFileSync(path.join(carpetaMensaje(ctx, mensajeId), "correo.json"), "utf8"));
  const r = Correo.safeParse(crudo);
  if (!r.success) throw new Error(`el correo ${mensajeId} no tiene el formato esperado: ${z.prettifyError(r.error)}`);
  return r.data;
}

/** Ruta de un adjunto declarado en el correo (solo nombres simples, sin subcarpetas). */
export function rutaAdjunto(ctx: Contexto, mensajeId: string, nombre: string): string {
  if (nombre !== path.basename(nombre)) throw new Error(`adjunto inválido: ${nombre}`);
  return path.join(carpetaMensaje(ctx, mensajeId), nombre);
}

/** Motivo de un adjunto que no es texto plano (PDF, Word, imagen): no se lee y queda para revisión manual (HU-6). */
export const MOTIVO_BINARIO = "formato no soportado: revisión manual";

/**
 * `true` si el adjunto no es texto plano: empieza por `%PDF` o trae bytes de control (NUL y similares; tabulador,
 * saltos de línea y avance de página no cuentan). Un archivo ilegible no es binario: de eso se ocupa quien lo lee.
 */
export function esBinario(ruta: string): boolean {
  try {
    const bytes = fs.readFileSync(ruta);
    if (bytes.subarray(0, 4).toString("latin1") === "%PDF") return true;
    return bytes.some((b) => b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0c && b !== 0x0d);
  } catch {
    return false;
  }
}

/** Catálogo de comerciales validado. */
export function leerComerciales(ctx: Contexto): Comercial[] {
  return Comerciales.parse(JSON.parse(fs.readFileSync(rutas(ctx).comerciales, "utf8")));
}
