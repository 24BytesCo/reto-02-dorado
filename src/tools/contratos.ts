import fs from "node:fs";
import { z } from "zod";
import { ok, seguro, type Contexto, type Herramienta } from "./nucleo.ts";
import { leerComerciales, leerCorreo, leerMaestro, leerProcesados, listarMensajes, rutaAdjunto, type Correo } from "./almacen.ts";
import { CAMPOS_CON_CONFIANZA, REGLAS } from "./reglas.ts";
import { describirNoContractual, extraerContrato, tipoDocumento, type Campo, type Extraccion } from "./extraccion.ts";

/**
 * Herramientas del agente de registro de contratos (PRD §6.2).
 * Cada export se expone al modelo como `contratos_<export>` y es la única fuente de valores que el agente puede afirmar.
 */

const mensajeId = z.string().regex(/^[\w-]+$/).describe("Id del mensaje del buzón, tal como lo devuelve contratos_leer_buzon");

/** Texto del primer adjunto contractual del correo, o `null` si no trae ninguno. */
function adjuntoContractual(ctx: Contexto, correo: Correo): { nombre: string; ruta: string; texto: string } | null {
  for (const nombre of correo.adjuntos) {
    const ruta = rutaAdjunto(ctx, correo.id, nombre);
    if (!fs.existsSync(ruta)) continue;
    const texto = fs.readFileSync(ruta, "utf8");
    if (tipoDocumento(texto)) return { nombre, ruta, texto };
  }
  return null;
}

/** Motivo de rechazo de un correo sin documento contractual (RN4). */
function motivoSinContrato(ctx: Contexto, correo: Correo): string {
  if (correo.adjuntos.length === 0) return "el correo no trae adjuntos";
  const ruta = rutaAdjunto(ctx, correo.id, correo.adjuntos[0]);
  return fs.existsSync(ruta) ? describirNoContractual(fs.readFileSync(ruta, "utf8")) : `no se encontró el adjunto ${correo.adjuntos[0]}`;
}

/** Nombre del cliente en el maestro para un identificador tributario, si ya existe. */
function nombrePorIdentificador(ctx: Contexto): (id: string) => string | null {
  const filas = leerMaestro(ctx);
  return (id) => filas.find((f) => f.nit_cliente === id)?.cliente ?? null;
}

/** Resultado completo de extraer un mensaje: datos del texto más los que salen del correo. */
export interface ExtraccionMensaje extends Extraccion {
  mensaje_id: string;
  adjunto: string;
  contrato: Extraccion["contrato"] & {
    estado_poliza: Campo<string>;
    comercial: Campo<string>;
    fecha_registro: Campo<string>;
    fuente: Campo<string>;
  };
}

/** Comercial resuelto contra `comerciales.json`; un remitente desconocido se reporta pero no bloquea (HU-3). */
function resolverComercial(ctx: Contexto, remitente: string): { comercial: Campo<string>; advertencia: string | null } {
  const encontrado = leerComerciales(ctx).find((c) => c.email.toLowerCase() === remitente.toLowerCase());
  if (encontrado) return { comercial: { valor: encontrado.nombre, confianza: 1, evidencia: remitente }, advertencia: null };
  return {
    comercial: { valor: null, confianza: 0, evidencia: remitente },
    advertencia: `El remitente ${remitente} no está en el catálogo de comerciales: se reporta y el registro sigue; el campo comercial queda vacío.`,
  };
}

/**
 * Extrae un mensaje del buzón (HU-2): datos del adjunto con su confianza, más comercial,
 * fecha de recepción como fecha de registro, fuente y el estado de póliza que corresponde a un registro nuevo.
 * @throws Error legible si el mensaje no trae un documento contractual o el texto es inválido (HU-6).
 */
export function extraccionDeMensaje(ctx: Contexto, mensaje_id: string): ExtraccionMensaje {
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
      fuente: { valor: "buzon", confianza: 1 },
    },
    advertencias: advertencia ? [...ext.advertencias, advertencia] : ext.advertencias,
  };
}

/** HU-2: datos estructurados del contrato adjunto, con confianza por campo. */
export const extraer: Herramienta<{ mensaje_id: typeof mensajeId }> = {
  description: "Extrae del contrato adjunto a un mensaje los datos del maestro con una confianza entre 0 y 1 por campo; un campo ausente viene en null, nunca inventado.",
  args: { mensaje_id: mensajeId },
  execute: ({ mensaje_id }, ctx) =>
    seguro(() => {
      const e = extraccionDeMensaje(ctx, mensaje_id);
      const bajos = CAMPOS_CON_CONFIANZA.filter((k) => e.contrato[k].valor !== null && e.contrato[k].confianza < REGLAS.umbralConfianza);
      return ok({ ...e, resumen: `${e.contrato.id_contrato.valor ?? "sin id"} (${e.tipo_documento}); confianza baja en: ${bajos.join(", ") || "ninguno"}` });
    }),
};

/** HU-1: lista los mensajes pendientes del buzón y marca como rechazados los que no traen contrato. */
export const leer_buzon: Herramienta<{}> = {
  description: "Lista los mensajes del buzón que aún no se han procesado, con remitente, asunto, fecha, adjuntos y si traen contrato.",
  args: {},
  execute: (_args, ctx) =>
    seguro(() => {
      const procesados = leerProcesados(ctx);
      const mensajes = listarMensajes(ctx)
        .filter((id) => !(id in procesados))
        .map((id) => {
          const correo = leerCorreo(ctx, id);
          const tiene_contrato = adjuntoContractual(ctx, correo) !== null;
          const base = { id, de: correo.de, asunto: correo.asunto, fecha: correo.fecha, adjuntos: correo.adjuntos, tiene_contrato };
          return tiene_contrato ? base : { ...base, clasificacion: "rechazado" as const, motivo: motivoSinContrato(ctx, correo) };
        });
      return ok({ mensajes, resumen: `${mensajes.length} mensajes pendientes` });
    }),
};

