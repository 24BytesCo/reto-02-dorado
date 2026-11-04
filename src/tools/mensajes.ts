import fs from "node:fs";
import { leerComerciales, leerCorreo, leerMaestro, rutaAdjunto, type Correo } from "./almacen.ts";
import { describirNoContractual, extraerContrato, tipoDocumento, type Campo, type Extraccion } from "./extraccion.ts";
import type { Contexto } from "./nucleo.ts";

/**
 * Lectura de un mensaje del buzón y su extracción completa. Vive aparte de contratos.ts para que
 * ese archivo exporte solo herramientas (PRD §6.2: cada export es contratos_<export>).
 */

/** Texto del primer adjunto contractual del correo, o `null` si no trae ninguno. */
export function adjuntoContractual(ctx: Contexto, correo: Correo): { nombre: string; ruta: string; texto: string } | null {
  for (const nombre of correo.adjuntos) {
    const ruta = rutaAdjunto(ctx, correo.id, nombre);
    if (!fs.existsSync(ruta)) continue;
    const texto = fs.readFileSync(ruta, "utf8");
    if (tipoDocumento(texto)) return { nombre, ruta, texto };
  }
  return null;
}

/** Motivo de rechazo de un correo sin documento contractual (RN4). */
export function motivoSinContrato(ctx: Contexto, correo: Correo): string {
  if (correo.adjuntos.length === 0) return "el correo no trae adjuntos";
  const ruta = rutaAdjunto(ctx, correo.id, correo.adjuntos[0]);
  return fs.existsSync(ruta) ? describirNoContractual(fs.readFileSync(ruta, "utf8")) : `no se encontró el adjunto ${correo.adjuntos[0]}`;
}

/** Nombre del cliente en el maestro para un identificador tributario, si ya existe. */
export function nombrePorIdentificador(ctx: Contexto): (id: string) => string | null {
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
