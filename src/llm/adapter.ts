import { AdaptadorAnthropic } from "./anthropic.ts";
import { AdaptadorSimulado } from "./simulado.ts";

/**
 * Interfaz propia del proveedor LLM (PRD §6.1: `enviar(mensajes, herramientas) → respuesta`).
 * El ciclo del agente solo conoce estos tipos; ninguno viene del SDK, así que cambiar de proveedor no toca el ciclo.
 */

/** Llamada a herramienta pedida por el modelo. */
export interface LlamadaHerramienta {
  id: string;
  nombre: string;
  argumentos: unknown;
}

/** Resultado de una herramienta que vuelve al modelo (el string JSON `{ ok, data | error }` del PRD §6.2). */
export interface ResultadoHerramienta {
  id: string;
  contenido: string;
  esError: boolean;
}

/**
 * Mensaje del historial. El del asistente guarda en `crudo` el contenido original del proveedor,
 * opaco para el ciclo, para devolvérselo sin modificar (los bloques de razonamiento deben volver intactos).
 */
export type Mensaje =
  | { rol: "usuario"; texto: string }
  | { rol: "asistente"; texto: string; llamadas: LlamadaHerramienta[]; crudo?: unknown }
  | { rol: "resultados"; resultados: ResultadoHerramienta[] };

/** Herramienta tal como se le describe al modelo: `esquema` es JSON Schema generado desde zod. */
export interface DefinicionHerramienta {
  nombre: string;
  descripcion: string;
  esquema: Record<string, unknown>;
}

/** Tokens consumidos por una llamada al modelo (PRD §8 Costo). */
export interface Uso {
  entrada: number;
  salida: number;
  cacheLeida: number;
}

/** Por qué terminó la respuesta: texto final, pide herramientas, se cortó por longitud o el modelo declinó. */
export type Fin = "fin" | "herramientas" | "corte" | "rechazo";

/** Respuesta normalizada del proveedor. */
export interface Respuesta {
  texto: string;
  llamadas: LlamadaHerramienta[];
  uso: Uso;
  fin: Fin;
  crudo?: unknown;
}

/** Opciones de un envío. `sinHerramientas` fuerza una respuesta solo de texto (cierre por tope, CA1). */
export interface OpcionesEnvio {
  sinHerramientas?: boolean;
}

/** Contrato que cumple cada proveedor. `enviar` lanza `ErrorLlm` con un mensaje claro si el proveedor falla (CA5). */
export interface AdaptadorLlm {
  proveedor: string;
  modelo: string;
  enviar(sistema: string, mensajes: Mensaje[], herramientas: DefinicionHerramienta[], opciones?: OpcionesEnvio): Promise<Respuesta>;
}

/**
 * Elige el adaptador según `LLM_PROVEEDOR` (`anthropic` por defecto, o `simulado` para correr sin clave).
 * @throws Error legible si el proveedor no existe.
 */
export function crearAdaptador(entorno: NodeJS.ProcessEnv = process.env): AdaptadorLlm {
  const proveedor = (entorno.LLM_PROVEEDOR ?? "anthropic").trim().toLowerCase();
  if (proveedor === "anthropic") return new AdaptadorAnthropic(entorno);
  if (proveedor === "simulado") return new AdaptadorSimulado();
  throw new Error(`LLM_PROVEEDOR desconocido: "${proveedor}". Valores admitidos: anthropic, simulado.`);
}
