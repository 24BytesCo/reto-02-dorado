import fs from "node:fs";
import path from "node:path";
import { leerComerciales, leerCorreo, leerMaestro, rutaAdjunto, type Correo } from "./almacen.ts";
import { describirNoContractual, extraerContrato, tipoDocumento, type Campo, type Extraccion } from "./extraccion.ts";
import type { Contexto } from "./nucleo.ts";

/**
 * Lectura de un mensaje del buzón y su extracción completa. Vive aparte de contratos.ts para que
 * ese archivo exporte solo herramientas (PRD §6.2: cada export es contratos_<export>).
 */

/** Texto de un adjunto, o `null` si no existe o no se puede leer (nombre inválido, carpeta, permisos): un adjunto malo no tumba el lote (HU-6). */
function leerAdjunto(ctx: Contexto, correo: Correo, nombre: string): { ruta: string; texto: string } | null {
  try {
    const ruta = rutaAdjunto(ctx, correo.id, nombre);
    return { ruta, texto: fs.readFileSync(ruta, "utf8") };
  } catch {
    return null;
  }
}

/** Texto del primer adjunto contractual del correo, o `null` si no trae ninguno legible. */
export function adjuntoContractual(ctx: Contexto, correo: Correo): { nombre: string; ruta: string; texto: string } | null {
  for (const nombre of correo.adjuntos) {
    const leido = leerAdjunto(ctx, correo, nombre);
    if (leido && tipoDocumento(leido.texto)) return { nombre, ...leido };
  }
  return null;
}

/** Motivo de rechazo de un correo sin documento contractual (RN4). */
export function motivoSinContrato(ctx: Contexto, correo: Correo): string {
  if (correo.adjuntos.length === 0) return "el correo no trae adjuntos";
  const leido = leerAdjunto(ctx, correo, correo.adjuntos[0]);
  return leido ? describirNoContractual(leido.texto) : `no se encontró o no se pudo leer el adjunto ${correo.adjuntos[0]}`;
}

/**
 * Mensaje de error sin rutas absolutas del servidor (seguridad, PRD §8): cada ruta se reduce a su último segmento.
 * Una ruta relativa como `Contratos/2026/…` no se toca porque no empieza por `/` tras un espacio o una comilla.
 */
export function errorLegible(e: unknown): string {
  const crudo = e instanceof Error ? e.message : String(e);
  if (typeof e === "object" && e !== null && "code" in e && e.code === "ENOENT") return `falta el archivo ${path.basename(String("path" in e ? e.path : ""))}`;
  return crudo.replace(/(?<![\w.])(?:[A-Za-z]:)?[\\/](?:[^\s'"\\/]+[\\/])+([^\s'"\\/]*)/g, "$1");
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
