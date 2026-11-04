import Anthropic from "@anthropic-ai/sdk";
import type { AdaptadorLlm, DefinicionHerramienta, Fin, Mensaje, OpcionesEnvio, Respuesta } from "./adapter.ts";
import { ErrorLlm } from "./errores.ts";

/**
 * Implementación de Anthropic del adaptador (PRD §6.1). Es el único archivo que importa el SDK:
 * el ciclo del agente nunca ve `tool_use`, `tool_result` ni ningún tipo del proveedor.
 */

type Parametros = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;
type MensajeSdk = Anthropic.Beta.Messages.BetaMessageParam;
type BloqueSdk = Anthropic.Beta.Messages.BetaContentBlockParam;
type RespuestaSdk = Anthropic.Beta.Messages.BetaMessage;
type Esfuerzo = "low" | "medium" | "high" | "xhigh" | "max";

const ESFUERZOS: readonly Esfuerzo[] = ["low", "medium", "high", "xhigh", "max"];
const BETAS = ["server-side-fallback-2026-07-01"];
const PAUSAS_MAX = 3;
const FINES: Partial<Record<string, Fin>> = {
  end_turn: "fin",
  stop_sequence: "fin",
  tool_use: "herramientas",
  max_tokens: "corte",
  model_context_window_exceeded: "corte",
  refusal: "rechazo",
};

/** CA5: qué falta y cómo seguir, sin llamar al proveedor. */
export const SIN_CLAVE = "Falta ANTHROPIC_API_KEY en el backend; configúrala o usa LLM_PROVEEDOR=simulado.";

const leerEsfuerzo = (valor: string | undefined): Esfuerzo => ESFUERZOS.find((e) => e === valor) ?? "low";
const leerNumero = (valor: string | undefined, porDefecto: number): number => (Number(valor) > 0 ? Number(valor) : porDefecto);

/** Adaptador de Anthropic: Messages API (beta) con razonamiento adaptativo, caché automática y respaldo del servidor ante rechazos. */
export class AdaptadorAnthropic implements AdaptadorLlm {
  readonly proveedor = "anthropic";
  readonly modelo: string;
  private readonly esfuerzo: Esfuerzo;
  // Campo privado real (#): no es una propiedad, así que ni JSON.stringify ni un log del adaptador pueden sacar el cliente o su clave.
  readonly #cliente: Anthropic;
  // Si la cuenta no admite el respaldo del servidor, se recuerda para no pagar un 400 en cada llamada.
  private conRespaldo = true;
  // Sin clave el SDK lanza un Error plano que acabaría como «Error inesperado»; se avisa antes de llamar (CA5).
  private readonly sinClave: boolean;

  /** Lee `LLM_MODELO`, `LLM_ESFUERZO`, `LLM_TIMEOUT_MS` y la clave del entorno del backend (PRD §8); nunca abre `.env`. */
  constructor(entorno: NodeJS.ProcessEnv = process.env) {
    this.modelo = entorno.LLM_MODELO || "claude-opus-5-5";
    this.esfuerzo = leerEsfuerzo(entorno.LLM_ESFUERZO);
    this.sinClave = !entorno.ANTHROPIC_API_KEY?.trim();
    this.#cliente = new Anthropic({ apiKey: entorno.ANTHROPIC_API_KEY, timeout: leerNumero(entorno.LLM_TIMEOUT_MS, 90_000), maxRetries: 1 });
  }

  /** Envía la conversación; reenvía si el proveedor pausa el turno y traduce todo error a `ErrorLlm` (CA5). */
  async enviar(sistema: string, mensajes: Mensaje[], herramientas: DefinicionHerramienta[], opciones: OpcionesEnvio = {}): Promise<Respuesta> {
    if (this.sinClave) throw new ErrorLlm(SIN_CLAVE);
    const base = this.parametros(sistema, mensajes, herramientas, opciones);
    let historial = base.messages;
    let acumulada: Respuesta | null = null;
    for (let pausa = 0; pausa <= PAUSAS_MAX; pausa++) {
      const respuesta = await this.crear({ ...base, messages: historial });
      acumulada = unir(acumulada, normalizar(respuesta));
      if (respuesta.stop_reason !== "pause_turn") return acumulada;
      // pause_turn: el turno sigue abierto; se devuelve tal cual para que el modelo continúe donde iba.
      historial = [...historial, { role: "assistant", content: respuesta.content as BloqueSdk[] }];
    }
    return { ...(acumulada as Respuesta), fin: "corte" };
  }

  private parametros(sistema: string, mensajes: Mensaje[], herramientas: DefinicionHerramienta[], opciones: OpcionesEnvio): Parametros {
    return {
      model: this.modelo,
      max_tokens: 16_000,
      ...(sistema ? { system: sistema } : {}),
      tools: herramientas.map((h) => ({ name: h.nombre, description: h.descripcion, input_schema: { type: "object" as const, ...h.esquema } })),
      // CA1: el cierre por tope usa "none"; "any" y "tool" dan 400 en este modelo.
      ...(opciones.sinHerramientas ? { tool_choice: { type: "none" as const } } : {}),
      messages: mensajes.map(aMensajeSdk),
      thinking: { type: "adaptive" },
      output_config: { effort: this.esfuerzo },
      cache_control: { type: "ephemeral" },
    };
  }

  private async crear(parametros: Parametros): Promise<RespuestaSdk> {
    try {
      return await this.#cliente.beta.messages.create(this.conRespaldo ? { ...parametros, betas: BETAS, fallbacks: "default" } : parametros);
    } catch (error) {
      if (!(this.conRespaldo && error instanceof Anthropic.BadRequestError)) throw traducir(error);
      return this.crearSinRespaldo(parametros);
    }
  }

  /** Un 400 puede deberse al respaldo del servidor: se reintenta una vez sin él y, si funciona, se recuerda. */
  private async crearSinRespaldo(parametros: Parametros): Promise<RespuestaSdk> {
    try {
      const respuesta = await this.#cliente.beta.messages.create(parametros);
      this.conRespaldo = false;
      return respuesta;
    } catch (error) {
      throw traducir(error);
    }
  }
}

/** Convierte un mensaje propio al formato del SDK; el del asistente vuelve con su contenido original sin tocar. */
function aMensajeSdk(m: Mensaje): MensajeSdk {
  if (m.rol === "usuario") return { role: "user", content: m.texto };
  if (m.rol === "resultados") {
    return {
      role: "user",
      content: m.resultados.map((r) => ({ type: "tool_result" as const, tool_use_id: r.id, content: r.contenido, is_error: r.esError })),
    };
  }
  // Un crudo vacío no se reenvía: la API rechaza con 400 un mensaje del asistente sin contenido (CA5).
  if (Array.isArray(m.crudo) && m.crudo.length > 0) return { role: "assistant", content: m.crudo as BloqueSdk[] };
  // Sin crudo (historial de otro proveedor o respuesta vacía): se reconstruye con texto y llamadas.
  const bloques: BloqueSdk[] = m.texto ? [{ type: "text", text: m.texto }] : [];
  for (const l of m.llamadas) bloques.push({ type: "tool_use", id: l.id, name: l.nombre, input: l.argumentos });
  return { role: "assistant", content: bloques.length ? bloques : [{ type: "text", text: "(sin texto)" }] };
}

/** Normaliza la respuesta del SDK a la del adaptador; `crudo` guarda el contenido tal cual, razonamiento incluido. */
function normalizar(r: RespuestaSdk): Respuesta {
  const texto = r.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
  const llamadas = r.content.flatMap((b) => (b.type === "tool_use" ? [{ id: b.id, nombre: b.name, argumentos: b.input }] : []));
  const uso = {
    entrada: r.usage.input_tokens + (r.usage.cache_creation_input_tokens ?? 0),
    salida: r.usage.output_tokens,
    cacheLeida: r.usage.cache_read_input_tokens ?? 0,
  };
  return { texto, llamadas, uso, fin: FINES[r.stop_reason ?? ""] ?? "fin", crudo: r.content };
}

/** Une una respuesta pausada con su continuación (el API trata dos mensajes seguidos del asistente como uno solo). */
function unir(previa: Respuesta | null, nueva: Respuesta): Respuesta {
  if (!previa) return nueva;
  return {
    texto: previa.texto + nueva.texto,
    llamadas: [...previa.llamadas, ...nueva.llamadas],
    uso: {
      entrada: previa.uso.entrada + nueva.uso.entrada,
      salida: previa.uso.salida + nueva.uso.salida,
      cacheLeida: previa.uso.cacheLeida + nueva.uso.cacheLeida,
    },
    fin: nueva.fin,
    crudo: [...(previa.crudo as BloqueSdk[]), ...(nueva.crudo as BloqueSdk[])],
  };
}

const recorte = (texto: string): string => texto.slice(0, 300);

/**
 * Traduce un error del SDK a un mensaje claro en español (CA5, PRD §8 Robustez).
 * Nunca serializa el objeto de error: solo toma su clase y, en un 400, el mensaje recortado y redactado.
 */
export function traducir(error: unknown): ErrorLlm {
  if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) {
    return new ErrorLlm("El proveedor del modelo rechazó la credencial (clave inválida o sin permiso). Hay que revisar ANTHROPIC_API_KEY en el backend.");
  }
  if (error instanceof Anthropic.RateLimitError) return new ErrorLlm("Se alcanzó el límite de uso del proveedor del modelo. Espera un momento y vuelve a intentarlo.");
  if (error instanceof Anthropic.APIConnectionTimeoutError) return new ErrorLlm("El proveedor del modelo no respondió a tiempo (tiempo de espera agotado). Vuelve a intentarlo.");
  if (error instanceof Anthropic.APIConnectionError) return new ErrorLlm("El proveedor del modelo no está disponible: no se pudo conectar. Vuelve a intentarlo.");
  if (error instanceof Anthropic.InternalServerError) return new ErrorLlm("El proveedor del modelo no está disponible en este momento (sobrecarga o error interno). Vuelve a intentarlo en unos segundos.");
  if (error instanceof Anthropic.BadRequestError) return new ErrorLlm(`El proveedor del modelo rechazó la solicitud: ${recorte(error.message)}`);
  if (error instanceof Anthropic.APIError) return new ErrorLlm(`El proveedor del modelo respondió con un error${error.status ? ` (${error.status})` : ""}.`);
  if (error instanceof Anthropic.AnthropicError) return new ErrorLlm(`No se pudo llamar al proveedor del modelo: ${recorte(error.message)}`);
  return new ErrorLlm("Error inesperado al llamar al proveedor del modelo.");
}
