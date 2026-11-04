import path from "node:path";
import { z } from "zod";
import { fallo, ok, seguro, type Contexto, type Herramienta } from "./nucleo.ts";
import {
  anotarHistorial, archivar, escribirMaestro, leerCorreo, leerMaestro, leerProcesados, listarMensajes, marcarProcesado, rutaAdjunto,
} from "./almacen.ts";
import { CAMPOS_CON_CONFIANZA, COLUMNAS_MAESTRO, REGLAS, type FilaMaestro } from "./reglas.ts";
import { slugCliente } from "./extraccion.ts";
import { adjuntoContractual, errorLegible, extraccionDeMensaje, motivoSinContrato, type ExtraccionMensaje } from "./mensajes.ts";
import type { Correo } from "./almacen.ts";
import { argsAlertas, generarAlertas } from "./alertas.ts";
import {
  clasificar, confirmadosDe, correccionesFueraDeRevision, esquemaContratoCorregido, rechazo, validarCorregido,
  type ContratoCorregido, type Diferencias, type ResultadoClasificacion,
} from "./clasificacion.ts";

/**
 * Herramientas del agente de registro de contratos (PRD §6.2).
 * Cada export se expone al modelo como `contratos_<export>` y es la única fuente de valores que el agente puede afirmar.
 */

const mensajeId = z.string().regex(/^[\w-]+$/).describe("Id del mensaje del buzón, tal como lo devuelve contratos_leer_buzon");

/**
 * `seguro` con dos garantías más (PRD §6.2 «nunca lanza», §8): los argumentos se leen DENTRO del try, así que
 * `args` undefined o null da `{ ok: false }` y no una excepción; y el error sale sin rutas absolutas del servidor.
 */
function protegido(args: unknown, ctx: unknown, logica: () => string): Promise<string> {
  return seguro(() => {
    if (typeof args !== "object" || args === null) throw new Error("argumentos inválidos: se esperaba un objeto");
    if (typeof ctx !== "object" || ctx === null || typeof (ctx as Partial<Contexto>).directory !== "string") throw new Error("contexto inválido: falta directory");
    try {
      return logica();
    } catch (e) {
      throw new Error(errorLegible(e));
    }
  });
}


/** HU-2: datos estructurados del contrato adjunto, con confianza por campo. */
export const extraer: Herramienta<{ mensaje_id: typeof mensajeId }> = {
  description: "Extrae del contrato adjunto a un mensaje los datos del maestro con una confianza entre 0 y 1 por campo; un campo ausente viene en null, nunca inventado.",
  args: { mensaje_id: mensajeId },
  execute: (args, ctx) =>
    protegido(args, ctx, () => {
      const { mensaje_id } = args;
      const e = extraccionDeMensaje(ctx, mensaje_id);
      const bajos = CAMPOS_CON_CONFIANZA.filter((k) => e.contrato[k].valor !== null && e.contrato[k].confianza < REGLAS.umbralConfianza);
      return ok({ ...e, resumen: `${e.contrato.id_contrato.valor ?? "sin id"} (${e.tipo_documento}); confianza baja en: ${bajos.join(", ") || "ninguno"}` });
    }),
};

/** Un mensaje del buzón tal como lo lista `leer_buzon` (HU-1). */
interface MensajeBuzon {
  id: string;
  de: string;
  asunto: string;
  fecha: string;
  adjuntos: string[];
  tiene_contrato: boolean;
  clasificacion?: "rechazado";
  motivo?: string;
}

/** Resumen de un correo legible: sin adjunto contractual queda rechazado con motivo (RN4). */
function resumirCorreo(ctx: Contexto, correo: Correo): MensajeBuzon {
  const tiene_contrato = adjuntoContractual(ctx, correo) !== null;
  const base = { id: correo.id, de: correo.de, asunto: correo.asunto, fecha: correo.fecha, adjuntos: correo.adjuntos, tiene_contrato };
  return tiene_contrato ? base : { ...base, clasificacion: "rechazado", motivo: motivoSinContrato(ctx, correo) };
}

/** HU-6: un correo.json roto, incompleto o ausente no tumba el lote; ese mensaje sale rechazado con motivo legible. */
function mensajeDelBuzon(ctx: Contexto, id: string): MensajeBuzon {
  try {
    return { ...resumirCorreo(ctx, leerCorreo(ctx, id)), id };
  } catch (e) {
    return { id, de: "", asunto: "", fecha: "", adjuntos: [], tiene_contrato: false, clasificacion: "rechazado", motivo: `correo ilegible: ${errorLegible(e)}` };
  }
}

/** HU-1: lista los mensajes pendientes del buzón y marca como rechazados los que no traen contrato. */
export const leer_buzon: Herramienta<{}> = {
  description: "Lista los mensajes del buzón que aún no se han procesado, con remitente, asunto, fecha, adjuntos y si traen contrato.",
  args: {},
  execute: (args, ctx) =>
    protegido(args ?? {}, ctx, () => {
      const procesados = leerProcesados(ctx);
      const mensajes = listarMensajes(ctx).filter((id) => !(id in procesados)).map((id) => mensajeDelBuzon(ctx, id));
      return ok({ mensajes, resumen: `${mensajes.length} mensajes pendientes` });
    }),
};


// ── HU-3 validar y HU-4 registrar ──

const contrato = esquemaContratoCorregido
  .optional()
  .describe("Valores corregidos por la analista, planos y opcionales; lo omitido toma lo extraído por contratos_extraer");

/** Clasificación de un mensaje más lo que `registrar` necesita para escribir. */
interface Evaluacion {
  resultado: ResultadoClasificacion;
  extraccion: ExtraccionMensaje | null;
}

/**
 * Revalida un mensaje desde el buzón: RN4 si no trae documento contractual; si lo trae, extrae y clasifica
 * contra la copia del maestro (RN1-RN5). `validar` y `registrar` la comparten: ninguna confía en el modelo.
 */
function evaluar(ctx: Contexto, mensaje_id: string, corregido: ContratoCorregido): Evaluacion {
  validarCorregido(corregido);
  const correo = leerCorreo(ctx, mensaje_id);
  if (!adjuntoContractual(ctx, correo)) return { resultado: rechazo(motivoSinContrato(ctx, correo)), extraccion: null };
  const extraccion = extraccionDeMensaje(ctx, mensaje_id);
  const resultado = clasificar({
    extraccion,
    corregido,
    comercial: extraccion.contrato.comercial.valor ?? "",
    fecha_registro: extraccion.contrato.fecha_registro.valor ?? correo.fecha.slice(0, 10),
    maestro: leerMaestro(ctx),
  });
  return { resultado, extraccion };
}

/** Id del contrato al que se refiere el resultado: el existente, el propuesto o ninguno. */
const idDe = (r: ResultadoClasificacion): string | null => r.id_contrato_existente ?? (r.propuesta?.id_contrato || null);

/** HU-3: clasifica un mensaje en nuevo, actualización, duplicado o rechazado y lista lo que requiere revisión. */
export const validar: Herramienta<{ mensaje_id: typeof mensajeId; contrato: typeof contrato }> = {
  description: "Clasifica el contrato de un mensaje como nuevo, actualizacion, duplicado o rechazado frente al maestro, con los campos que requieren revisión humana y la fila que se escribiría; no escribe nada.",
  args: { mensaje_id: mensajeId, contrato },
  execute: (args, ctx) =>
    protegido(args, ctx, () => {
      const { mensaje_id, contrato: corregido } = args;
      const { resultado: r } = evaluar(ctx, mensaje_id, corregido ?? {});
      const sobre = r.id_contrato_existente ? ` sobre ${r.id_contrato_existente}` : "";
      const resumen = `${mensaje_id}: ${r.clasificacion}${sobre}; revisión: ${r.requiere_revision.join(", ") || "ninguna"}`;
      return ok({ mensaje_id, ...r, resumen });
    }),
};

/** Ruta relativa en SharePoint: `Contratos/<año_inicio>/<cliente-slug>/<nombre>.<ext>` (HU-4). */
function rutaContrato(fila: FilaMaestro, nombre: string, adjunto: string): string {
  const anio = (fila.fecha_inicio || fila.fecha_registro).slice(0, 4);
  return path.posix.join("Contratos", anio, slugCliente(fila.cliente) || "sin-cliente", `${nombre}${path.extname(adjunto)}`);
}

/**
 * Línea de `historial.jsonl` (HU-4, O2): `cambios` siempre con la forma `{ campo: { antes, despues } }`
 * (en un nuevo, `antes: null`); el archivo y lo confirmado por la analista van como claves hermanas.
 */
interface LineaHistorial {
  id_contrato: string;
  accion: "nuevo" | "actualizacion";
  cambios: Record<string, { antes: string | null; despues: string }>;
  mensaje_id: string;
  archivo: string;
  confirmados?: ReturnType<typeof confirmadosDe>;
}

/** Línea del historial con lo propuesto y lo que quedó en cada campo en revisión, si los hubo (CA2). */
function lineaHistorial(base: Omit<LineaHistorial, "confirmados">, ext: ExtraccionMensaje, r: ResultadoClasificacion, fila: FilaMaestro): LineaHistorial {
  const confirmados = confirmadosDe(ext, r.requiere_revision, fila);
  return Object.keys(confirmados).length > 0 ? { ...base, confirmados } : base;
}

/** Cambios de una fila nueva: cada columna con `antes: null`. */
const cambiosNuevo = (fila: FilaMaestro): LineaHistorial["cambios"] =>
  Object.fromEntries(COLUMNAS_MAESTRO.map((c) => [c, { antes: null, despues: fila[c] }]));

/** RN3: inserta la fila, archiva el contrato, guarda la ruta y anota el historial con la fila completa. */
function registrarNuevo(ctx: Contexto, mensaje_id: string, ext: ExtraccionMensaje, r: ResultadoClasificacion, propuesta: FilaMaestro) {
  const ruta = rutaContrato(propuesta, propuesta.id_contrato, ext.adjunto);
  const fila = { ...propuesta, ruta_sharepoint: ruta };
  archivar(ctx, rutaAdjunto(ctx, mensaje_id, ext.adjunto), ruta);
  escribirMaestro(ctx, [...leerMaestro(ctx), fila]);
  const base = { id_contrato: fila.id_contrato, accion: "nuevo" as const, cambios: cambiosNuevo(fila), mensaje_id, archivo: ruta };
  anotarHistorial(ctx, lineaHistorial(base, ext, r, fila));
  return { id_contrato: fila.id_contrato, accion: "nuevo" as const, ruta_archivo: ruta };
}

/**
 * RN2: modifica la fila existente (nunca agrega otra) y archiva el documento sin pisar el original:
 * un otrosí como `<id>-otrosi-<n>` (supuesto S11); la fila conserva su ruta.
 */
function registrarActualizacion(ctx: Contexto, mensaje_id: string, ext: ExtraccionMensaje, r: ResultadoClasificacion, propuesta: FilaMaestro) {
  const id = propuesta.id_contrato;
  const nombre = ext.tipo_documento === "otrosi" ? `${id}-otrosi-${ext.numero_otrosi ?? 1}` : `${id}-${mensaje_id}`;
  const ruta = archivar(ctx, rutaAdjunto(ctx, mensaje_id, ext.adjunto), rutaContrato(propuesta, nombre, ext.adjunto));
  escribirMaestro(ctx, leerMaestro(ctx).map((f) => (f.id_contrato === r.id_contrato_existente ? propuesta : f)));
  const cambios: Diferencias = r.diferencias ?? {};
  anotarHistorial(ctx, lineaHistorial({ id_contrato: id, accion: "actualizacion", cambios, mensaje_id, archivo: ruta }, ext, r, propuesta));
  return { id_contrato: id, accion: "actualizacion" as const, ruta_archivo: ruta };
}

/** Escribe según la clasificación; duplicados y rechazados no tocan maestro, historial ni archivo (RN1, RN4). */
function escribir(ctx: Contexto, mensaje_id: string, ev: Evaluacion) {
  const r = ev.resultado;
  if (ev.extraccion && r.propuesta && r.clasificacion === "nuevo") return registrarNuevo(ctx, mensaje_id, ev.extraccion, r, r.propuesta);
  if (ev.extraccion && r.propuesta && r.clasificacion === "actualizacion") {
    return registrarActualizacion(ctx, mensaje_id, ev.extraccion, r, r.propuesta);
  }
  return { id_contrato: idDe(r), accion: r.clasificacion, ruta_archivo: null, ...(r.motivo ? { motivo: r.motivo } : {}) };
}

/** CA2: la confirmación no cubre campos que no se le preguntaron a la analista. */
function mensajeColados(campos: string[]): string {
  return campos.length === 1
    ? `el campo ${campos[0]} no estaba en revisión: no se puede cambiar al confirmar; valida de nuevo y pide confirmación`
    : `los campos ${campos.join(", ")} no estaban en revisión: no se pueden cambiar al confirmar; valida de nuevo y pide confirmación`;
}

/**
 * HU-4: revalida el mensaje y, si no hay campos en revisión o viene `confirmado: true` (RN5), escribe el maestro,
 * archiva el documento, anota el historial y marca el mensaje como procesado. Es idempotente: repetirlo da duplicado.
 */
export const registrar: Herramienta<{ mensaje_id: typeof mensajeId; contrato: typeof contrato; confirmado: z.ZodOptional<z.ZodBoolean> }> = {
  description: "Registra el contrato de un mensaje en el maestro y lo archiva tras revalidarlo; si hay campos en revisión exige confirmado: true, y los duplicados y rechazados solo quedan marcados como procesados.",
  args: {
    mensaje_id: mensajeId,
    contrato,
    confirmado: z.boolean().optional().describe("true solo si la analista confirmó en un mensaje propio los campos en revisión"),
  },
  execute: (args, ctx) =>
    protegido(args, ctx, () => {
      const { mensaje_id, contrato: corregido, confirmado } = args;
      const ev = evaluar(ctx, mensaje_id, corregido ?? {});
      const revision = ev.resultado.requiere_revision;
      if (revision.length > 0 && confirmado !== true) return fallo(`requiere revisión: ${revision.join(", ")}`);
      const colados = confirmado === true && ev.extraccion ? correccionesFueraDeRevision(ev.extraccion, corregido ?? {}) : [];
      if (colados.length > 0) return fallo(mensajeColados(colados));
      const hecho = escribir(ctx, mensaje_id, ev);
      if (!ev.resultado.pendiente) marcarProcesado(ctx, mensaje_id, hecho.accion, hecho.id_contrato);
      const resumen = `${mensaje_id}: ${hecho.accion} ${hecho.id_contrato ?? "sin id"}; ${hecho.ruta_archivo ?? "sin escritura"}`;
      return ok({ ...hecho, ...(ev.resultado.pendiente ? { procesado: false } : {}), resumen });
    }),
};

/** HU-5: reporte de riesgos en `out/alertas.md`, con la fecha de referencia como argumento para que sea determinista. */
export const alertas: Herramienta<typeof argsAlertas> = {
  description: "Genera out/alertas.md con los contratos que vencen en 60 días o menos desde «hoy», las pólizas exigidas que no están vigentes y los contratos registrados desde el corte del 2026-05-30.",
  args: argsAlertas,
  execute: (args, ctx) => protegido(args, ctx, () => ok(generarAlertas(ctx, args.hoy))),
};
