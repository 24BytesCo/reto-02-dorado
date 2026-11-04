import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

/** Contexto que el backend o la demo entregan a cada herramienta (PRD §6.2). */
export interface Contexto {
  /** Raíz del proyecto: toda ruta se resuelve desde aquí, nunca absoluta. */
  directory: string;
  sessionId: string;
}

/**
 * Forma obligatoria de una herramienta (PRD §6.2): una descripción de una frase,
 * argumentos como objeto de esquemas zod y un `execute` que devuelve un string JSON
 * `{ ok: true, data }` o `{ ok: false, error }` y nunca lanza.
 */
export interface Herramienta<A extends z.ZodRawShape = z.ZodRawShape> {
  description: string;
  args: A;
  execute(args: z.infer<z.ZodObject<A>>, ctx: Contexto): Promise<string>;
}

/** Respuesta exitosa serializada. */
export const ok = (data: unknown): string => JSON.stringify({ ok: true, data });

/** Respuesta de error serializada, con un mensaje legible para el modelo y para la analista. */
export const fallo = (error: string): string => JSON.stringify({ ok: false, error });

/** Ejecuta la lógica de una herramienta y convierte cualquier excepción en `{ ok: false }` (PRD §6.2: nunca lanza). */
export async function seguro(logica: () => Promise<string> | string): Promise<string> {
  try {
    return await logica();
  } catch (e) {
    return fallo(e instanceof Error ? e.message : String(e));
  }
}

/** Herramienta con el nombre que ve el modelo (`<archivo>_<export>`) y su esquema completo. */
export interface HerramientaRegistrada {
  nombre: string;
  herramienta: Herramienta;
  esquema: z.ZodObject<z.ZodRawShape>;
}

function esHerramienta(x: unknown): x is Herramienta {
  if (typeof x !== "object" || x === null) return false;
  const h = x as Partial<Herramienta>;
  return typeof h.description === "string" && typeof h.args === "object" && typeof h.execute === "function";
}

/**
 * Construye el catálogo de herramientas a partir de los exports de un módulo.
 * El nombre visible es `<archivo>_<export>` (PRD §6.2), generado en código y no escrito a mano.
 * @param archivo nombre del archivo sin extensión, p. ej. `contratos`.
 * @param modulo el módulo importado con `import * as`.
 */
export function catalogo(archivo: string, modulo: Record<string, unknown>): HerramientaRegistrada[] {
  return Object.entries(modulo)
    .filter((par): par is [string, Herramienta] => esHerramienta(par[1]))
    .map(([exportado, herramienta]) => ({
      nombre: `${archivo}_${exportado}`,
      herramienta,
      esquema: z.object(herramienta.args),
    }));
}

/** Directorio de salida (`out/`), configurable con `OUT_DIR`. */
export function dirSalida(ctx: Contexto): string {
  return path.resolve(ctx.directory, process.env.OUT_DIR || "out");
}

/** `ok` y un resumen corto de un resultado de herramienta: el `resumen` que traiga o el inicio del JSON (log y chat). */
export function resumir(resultado: string): { ok: boolean; resumen: string } {
  try {
    const r = JSON.parse(resultado) as { ok?: unknown; data?: { resumen?: unknown }; error?: unknown };
    if (r.ok !== true) return { ok: false, resumen: String(r.error).slice(0, 200) };
    const propio = r.data?.resumen;
    return { ok: true, resumen: typeof propio === "string" ? propio : JSON.stringify(r.data ?? null).slice(0, 200) };
  } catch {
    return { ok: false, resumen: resultado.slice(0, 200) };
  }
}

type IssueZod = z.ZodError["issues"][number];

const TIPOS: Record<string, string> = {
  string: "texto", number: "número", boolean: "booleano (true o false)", object: "objeto", array: "lista", null: "null", bigint: "número",
};
const tipoEs = (t: unknown): string => TIPOS[String(t)] ?? String(t);
const unidad = (origen: unknown): string => (origen === "string" ? " caracteres" : origen === "array" ? " elementos" : "");

/** Un límite de zod en español: «mínimo 3 caracteres», «mayor que 0». */
function limite(palabra: "mínimo" | "máximo", valor: unknown, inclusivo: boolean | undefined, origen: unknown): string {
  const estricto = palabra === "mínimo" ? "mayor que" : "menor que";
  return `${inclusivo === false ? estricto : palabra} ${String(valor)}${unidad(origen)}`;
}

/** Traduce un problema de validación de zod; los mensajes propios (`custom`) ya vienen en español. */
function problemaEnEspanol(i: IssueZod): string {
  switch (i.code) {
    case "invalid_type": {
      const recibido = /received (\w+)/.exec(i.message)?.[1];
      return recibido === "undefined" ? "es obligatorio" : `se esperaba ${tipoEs(i.expected)} y llegó ${tipoEs(recibido)}`;
    }
    case "too_small": return `demasiado pequeño: ${limite("mínimo", i.minimum, i.inclusive, i.origin)}`;
    case "too_big": return `demasiado grande: ${limite("máximo", i.maximum, i.inclusive, i.origin)}`;
    case "invalid_format": return `no tiene el formato esperado${"pattern" in i && i.pattern ? ` (${String(i.pattern)})` : ""}`;
    case "invalid_value": return `valor no admitido; se esperaba uno de: ${i.values.map((v) => JSON.stringify(v)).join(", ")}`;
    case "unrecognized_keys": return `claves no admitidas: ${i.keys.join(", ")}`;
    default: return i.message;
  }
}

/** Errores de validación de los argumentos en español, uno por campo: «mensaje_id: se esperaba texto y llegó número». */
export function erroresEnEspanol(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.length > 0 ? i.path.join(".") : "argumentos"}: ${problemaEnEspanol(i)}`).join("; ");
}

/**
 * Único punto de ejecución de herramientas, usado por el agente y por la demo:
 * valida los argumentos con zod antes de ejecutar, nunca lanza y deja una línea en
 * `out/log.jsonl` con `{ ts, herramienta, mensaje_id, ok, resumen }` en todos los casos (RN7, CA4).
 * @returns el string JSON que se le entrega al modelo.
 */
export async function ejecutarHerramienta(reg: HerramientaRegistrada, entrada: unknown, ctx: Contexto): Promise<string> {
  const validacion = reg.esquema.safeParse(entrada);
  const resultado = validacion.success
    ? await seguro(() => reg.herramienta.execute(validacion.data, ctx))
    : fallo(`argumentos inválidos para ${reg.nombre}: ${erroresEnEspanol(validacion.error)}`);
  const mensajeId =
    typeof entrada === "object" && entrada !== null && "mensaje_id" in entrada ? String(entrada.mensaje_id) : null;
  const linea = { ts: new Date().toISOString(), herramienta: reg.nombre, mensaje_id: mensajeId, ...resumir(resultado) };
  anotarLog(linea, ctx);
  return resultado;
}

/** Agrega una línea a `out/log.jsonl` (RN7); si no se puede escribir avisa por stderr y no tumba la herramienta. */
export function anotarLog(linea: unknown, ctx: Contexto): void {
  try {
    fs.mkdirSync(dirSalida(ctx), { recursive: true });
    fs.appendFileSync(path.join(dirSalida(ctx), "log.jsonl"), JSON.stringify(linea) + "\n");
  } catch (e) {
    console.error(`aviso: no se pudo escribir out/log.jsonl: ${e instanceof Error ? e.message : String(e)}`);
  }
}
