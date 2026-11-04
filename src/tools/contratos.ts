import fs from "node:fs";
import { z } from "zod";
import { ok, seguro, type Contexto, type Herramienta } from "./nucleo.ts";
import { leerCorreo, leerMaestro, leerProcesados, listarMensajes, rutaAdjunto, type Correo } from "./almacen.ts";
import { describirNoContractual, tipoDocumento } from "./extraccion.ts";

/**
 * Herramientas del agente de registro de contratos (PRD §6.2).
 * Cada export se expone al modelo como `contratos_<export>` y es la única fuente de valores que el agente puede afirmar.
 */

const mensajeId = z.string().regex(/^[\w-]+$/).describe("Id del mensaje del buzón, p. ej. msg-001");

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

