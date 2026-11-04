import type { AdaptadorLlm, DefinicionHerramienta, LlamadaHerramienta, Mensaje, OpcionesEnvio, Respuesta } from "./adapter.ts";

/**
 * Adaptador sin modelo (PRD §6.1): reproduce un guion para probar el ciclo sin clave y para mostrar
 * que cambiar de proveedor (`LLM_PROVEEDOR=simulado`) no toca el ciclo del agente.
 */

/** Un paso del guion: una respuesta, o un `Error` que simula la caída del proveedor (CA5). */
export type PasoGuion = Respuesta | Error;

/** Guion fijo (respuestas en orden) o una función que decide la respuesta según lo recibido. */
export type Guion = PasoGuion[] | ((mensajes: Mensaje[], opciones: OpcionesEnvio) => PasoGuion);

/** Lo que recibió el adaptador en cada envío, para que las pruebas lo inspeccionen. */
export interface EnvioRegistrado {
  sistema: string;
  mensajes: Mensaje[];
  herramientas: DefinicionHerramienta[];
  opciones: OpcionesEnvio;
}

const SIN_USO = { entrada: 0, salida: 0, cacheLeida: 0 };

/** Respuesta final de solo texto. */
export const respuestaTexto = (texto: string, uso = SIN_USO): Respuesta => ({ texto, llamadas: [], uso, fin: "fin" });

/** Respuesta que pide una o varias herramientas en el mismo mensaje. */
export const respuestaHerramientas = (llamadas: LlamadaHerramienta[], uso = SIN_USO, texto = ""): Respuesta => ({
  texto,
  llamadas,
  uso,
  fin: "herramientas",
});

const SIN_MODELO =
  "No hay un modelo de lenguaje configurado (LLM_PROVEEDOR=simulado). Las herramientas funcionan igual: prueba `npm run demo`.";

/** Adaptador guionizado; sin guion responde un texto fijo que explica que no hay modelo. */
export class AdaptadorSimulado implements AdaptadorLlm {
  readonly proveedor = "simulado";
  readonly modelo = "simulado";
  readonly envios: EnvioRegistrado[] = [];
  private paso = 0;

  constructor(private readonly guion?: Guion) {}

  async enviar(sistema: string, mensajes: Mensaje[], herramientas: DefinicionHerramienta[], opciones: OpcionesEnvio = {}): Promise<Respuesta> {
    // Copia profunda: el ciclo sigue modificando su historial y la prueba necesita ver lo que había en este envío.
    this.envios.push(structuredClone({ sistema, mensajes, herramientas, opciones }));
    const paso = this.siguiente(mensajes, opciones);
    if (paso instanceof Error) throw paso;
    return paso;
  }

  private siguiente(mensajes: Mensaje[], opciones: OpcionesEnvio): PasoGuion {
    if (!this.guion) return respuestaTexto(SIN_MODELO);
    if (typeof this.guion === "function") return this.guion(mensajes, opciones);
    return this.guion[this.paso++] ?? respuestaTexto("(guion agotado)");
  }
}
