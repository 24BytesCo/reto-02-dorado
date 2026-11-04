import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import * as contratos from "../tools/contratos.ts";
import { catalogo, dirSalida, ejecutarHerramienta, fallo, type Contexto, type HerramientaRegistrada } from "../tools/nucleo.ts";
import { crearAdaptador, type AdaptadorLlm, type DefinicionHerramienta, type LlamadaHerramienta, type Mensaje, type OpcionesEnvio, type Respuesta, type ResultadoHerramienta, type Uso } from "../llm/adapter.ts";
import { ErrorLlm, redactar } from "../llm/errores.ts";
import { actualizarPendientes, decidirConfirmacion, mensajeIdDe } from "./confirmacion.ts";
import { aPublica, AlmacenSesiones, errorDeId, type Sesion } from "./sesiones.ts";
import type { EventoAgente, LlamadaVisible, MotorAgente, ResultadoTurno } from "./tipos.ts";

/**
 * Ciclo del agente (PRD §6.1, §6.3): prompt → modelo → herramientas → respuesta, con tope de iteraciones (CA1),
 * confirmación humana en código (CA3), registro de cada llamada (CA4) y errores claros sin matar la sesión (CA5).
 * Solo conoce el adaptador propio; nunca un tipo del SDK.
 */

const RAIZ = path.resolve(import.meta.dirname, "../..");

/** Topes de costo (PRD §8), configurables por entorno. */
export interface Topes {
  /** CA1: idas modelo → herramientas por turno (`MAX_ITERACIONES`, 25). */
  iteraciones: number;
  /** Tokens de entrada + salida acumulados por sesión (`MAX_TOKENS_SESION`, 600000). */
  tokensSesion: number;
  /** Tokens acumulados por el motor sumando todas las sesiones (`MAX_TOKENS_GLOBAL`, 3000000), persistidos en out/uso.json. */
  tokensGlobal: number;
}

/** Opciones de `crearMotor`; todas tienen valor por defecto para producción. */
export interface OpcionesMotor {
  adaptador?: AdaptadorLlm;
  /** Raíz del proyecto (fixtures/ y out/). */
  directorio?: string;
  /** System prompt; por defecto agent/prompt.md + src/knowledge/registro-contratos.md. */
  sistema?: string;
  /** Catálogo de herramientas; por defecto las de src/tools/contratos.ts. */
  herramientas?: HerramientaRegistrada[];
  topes?: Partial<Topes>;
}

/** Precio en USD por millón de tokens (entrada, salida, lectura de caché). */
const PRECIOS: Record<string, { entrada: number; salida: number; cache: number }> = {
  "claude-opus-5-5": { entrada: 4, salida: 20, cache: 0.2 },
  "claude-sonnet-5-5": { entrada: 2, salida: 10, cache: 0.2 },
  "claude-haiku-5-5": { entrada: 0.1, salida: 0.5, cache: 0.01 },
};

/** Costo en USD de un uso (PRD §8 Costo, SOLUCION §4); 0 para un modelo sin precio conocido, como el simulado. */
export function costoUsd(modelo: string, uso: Uso): number {
  const p = PRECIOS[modelo];
  if (!p) return 0;
  return (uso.entrada * p.entrada + uso.salida * p.salida + uso.cacheLeida * p.cache) / 1_000_000;
}

const numeroDe = (valor: string | undefined, porDefecto: number): number => (Number(valor) > 0 ? Math.floor(Number(valor)) : porDefecto);

/** Lee un archivo del proyecto; si aún no existe devuelve cadena vacía en vez de fallar. */
function leerOpcional(directorio: string, relativa: string): string {
  try {
    return fs.readFileSync(path.join(directorio, relativa), "utf8");
  } catch {
    return "";
  }
}

/** System prompt (PRD §6.5): comportamiento en agent/prompt.md y conocimiento en src/knowledge/, leídos del disco. */
function sistemaPorDefecto(directorio: string): string {
  return [leerOpcional(directorio, "agent/prompt.md"), leerOpcional(directorio, "src/knowledge/registro-contratos.md")].filter(Boolean).join("\n\n");
}

/** Definición para el modelo: JSON Schema generado desde los mismos esquemas zod que validan (PRD §6.2). */
function aDefinicion(reg: HerramientaRegistrada): DefinicionHerramienta {
  const esquema: Record<string, unknown> = { ...z.toJSONSchema(reg.esquema, { io: "input", unrepresentable: "any" }) };
  delete esquema.$schema;
  return { nombre: reg.nombre, descripcion: reg.herramienta.description, esquema };
}

/** `ok` y un resumen corto de un resultado de herramienta, para el chat y los eventos (PRD §6.1). */
function resumir(contenido: string): { ok: boolean; resumen: string } {
  try {
    const r = JSON.parse(contenido) as { ok?: unknown; data?: { resumen?: unknown }; error?: unknown };
    if (r.ok !== true) return { ok: false, resumen: String(r.error).slice(0, 200) };
    const propio = r.data?.resumen;
    return { ok: true, resumen: typeof propio === "string" ? propio : JSON.stringify(r.data ?? null).slice(0, 200) };
  } catch {
    return { ok: false, resumen: contenido.slice(0, 200) };
  }
}

/** Mensaje claro para la analista ante cualquier fallo del turno (CA5); siempre redactado. */
function mensajeDeError(error: unknown): string {
  const causa = error instanceof ErrorLlm ? error.message : `error interno del agente: ${error instanceof Error ? error.message : String(error)}`;
  return redactar(`No pude completar este paso: ${causa} La sesión sigue activa; puedes volver a intentarlo.`);
}

const SIN_TEXTO = "El modelo no devolvió texto; pídeme que continúe.";

/** Resultado de una llamada que no llegó a ejecutarse (CA5: toda llamada tiene su resultado). */
const interrumpida = (id: string): ResultadoHerramienta => ({ id, contenido: fallo("llamada interrumpida: no se ejecutó"), esError: true });

/**
 * Deja el historial válido tras un fallo a mitad de turno (CA5) sin borrar lo que sí pasó: completa con
 * «interrumpida» las llamadas sin resultado y quita los mensajes de usuario sueltos del final de este turno.
 * @param inicio longitud del historial antes del turno; nunca se toca lo anterior.
 */
function repararHistorial(historial: Mensaje[], inicio: number): void {
  const ultimo = historial.at(-1);
  if (ultimo?.rol === "asistente" && ultimo.llamadas.length > 0) historial.push({ rol: "resultados", resultados: [] });
  const fin = historial.at(-1);
  const asistente = historial.at(-2);
  if (fin?.rol === "resultados" && asistente?.rol === "asistente") {
    const hechos = new Set(fin.resultados.map((r) => r.id));
    for (const l of asistente.llamadas) if (!hechos.has(l.id)) fin.resultados.push(interrumpida(l.id));
  }
  while (historial.length > inicio && historial.at(-1)?.rol === "usuario") historial.pop();
}

/** Tokens globales ya gastados según out/uso.json; 0 si no existe o no se puede leer. */
function leerUsoGlobal(salida: string): number {
  try {
    const uso = JSON.parse(fs.readFileSync(path.join(salida, "uso.json"), "utf8")) as { tokens?: unknown };
    return typeof uso.tokens === "number" && uso.tokens > 0 ? uso.tokens : 0;
  } catch {
    return 0;
  }
}

/** Estado de un turno en curso. */
interface EstadoTurno {
  sesion: Sesion;
  numero: number;
  /** Texto de la analista en este turno: CA3 lo exige para aceptar `confirmado: true`. */
  mensaje: string;
  ctx: Contexto;
  emitir: (evento: EventoAgente) => void;
  visibles: LlamadaVisible[];
  ultimoTexto: string;
}

class Motor implements MotorAgente {
  private readonly almacen: AlmacenSesiones;
  private readonly definiciones: DefinicionHerramienta[];
  // Turnos en curso por sesión: dos mensajes simultáneos se encadenan para no mezclar llamadas y resultados.
  private readonly colas = new Map<string, Promise<unknown>>();
  // PRD §8 Costo: un sessionId nuevo no reinicia el gasto. Vive en memoria (un POST /api/reset no lo borra) y se refleja en out/uso.json.
  private tokensGlobales: number;

  constructor(
    private readonly adaptador: AdaptadorLlm,
    private readonly directorio: string,
    private readonly sistema: string,
    private readonly registros: HerramientaRegistrada[],
    private readonly topes: Topes,
  ) {
    this.definiciones = registros.map(aDefinicion);
    this.almacen = new AlmacenSesiones(path.join(this.salida(), "sesiones"));
    this.tokensGlobales = leerUsoGlobal(this.salida());
  }

  private salida(): string {
    return dirSalida({ directory: this.directorio, sessionId: "" });
  }

  /** Suma el uso de una llamada al contador global y lo persiste (PRD §8 Costo). */
  private sumarUso(uso: Uso): void {
    this.tokensGlobales += uso.entrada + uso.salida;
    fs.mkdirSync(this.salida(), { recursive: true });
    fs.writeFileSync(path.join(this.salida(), "uso.json"), JSON.stringify({ tokens: this.tokensGlobales, actualizado: new Date().toISOString() }));
  }

  /** Aviso de tope de tokens si la sesión o el motor lo alcanzaron; `null` si se puede seguir (PRD §8 Costo). */
  private avisoTope(sesion: Sesion): string | null {
    if (this.tokensGlobales >= this.topes.tokensGlobal) {
      return `El agente alcanzó su tope global de ${this.topes.tokensGlobal} tokens (control de costo). Hay que avisar al administrador; lo ya registrado sigue en out/.`;
    }
    if (sesion.tokens >= this.topes.tokensSesion) {
      return `Esta sesión alcanzó su tope de ${this.topes.tokensSesion} tokens (control de costo). Abre una sesión nueva para continuar; lo ya registrado sigue en out/.`;
    }
    return null;
  }

  turno(sessionId: string, mensaje: string, emitir: (evento: EventoAgente) => void = () => {}): Promise<ResultadoTurno> {
    const previo = this.colas.get(sessionId) ?? Promise.resolve();
    const actual = previo.then(() => this.turnoSeguro(sessionId, mensaje, emitir));
    this.colas.set(sessionId, actual);
    return actual;
  }

  sesion(sessionId: string): ReturnType<MotorAgente["sesion"]> {
    if (errorDeId(sessionId)) return null;
    const s = this.almacen.obtener(sessionId);
    return s ? aPublica(s) : null;
  }

  reiniciar(): void {
    this.almacen.reiniciar();
  }

  /** Nunca lanza (contrato de MotorAgente): cualquier fallo vuelve como `reply`. */
  private async turnoSeguro(sessionId: string, mensaje: string, emitir: (evento: EventoAgente) => void): Promise<ResultadoTurno> {
    const errorId = errorDeId(sessionId);
    if (errorId) return this.soloError(errorId, emitir);
    try {
      const sesion = this.almacen.obtenerOCrear(sessionId);
      const resultado = await this.ejecutarTurno(sesion, mensaje, emitir);
      sesion.turnos.push({ ts: new Date().toISOString(), usuario: mensaje, ...resultado });
      this.almacen.guardar(sesion);
      return resultado;
    } catch (error) {
      return this.soloError(mensajeDeError(error), emitir);
    }
  }

  private soloError(mensaje: string, emitir: (evento: EventoAgente) => void): ResultadoTurno {
    emitir({ tipo: "error", mensaje });
    return { reply: mensaje, toolCalls: [], needsConfirmation: false, pendientes: [] };
  }

  /**
   * Un turno que sobrevive a un fallo a mitad (CA5): lo ya ejecutado no se deshace. El historial conserva las
   * parejas llamada-resultado completas, las llamadas sin resultado lo reciben como «interrumpida» y los
   * pendientes quedan como los dejaron las herramientas, así el modelo y el front ven lo que de verdad pasó.
   */
  private async ejecutarTurno(sesion: Sesion, mensaje: string, emitir: (evento: EventoAgente) => void): Promise<ResultadoTurno> {
    const tope = this.avisoTope(sesion);
    if (tope) return this.resultado(sesion, tope, []);
    sesion.numeroTurno += 1;
    const inicio = sesion.historial.length;
    const ctx: Contexto = { directory: this.directorio, sessionId: sesion.id };
    const t: EstadoTurno = { sesion, numero: sesion.numeroTurno, mensaje, ctx, emitir, visibles: [], ultimoTexto: "" };
    sesion.historial.push({ rol: "usuario", texto: mensaje });
    try {
      return this.resultado(sesion, await this.ciclo(t), t.visibles);
    } catch (error) {
      repararHistorial(sesion.historial, inicio);
      const texto = mensajeDeError(error);
      emitir({ tipo: "error", mensaje: texto });
      return this.resultado(sesion, texto, t.visibles);
    }
  }

  /** CA3: `needsConfirmation` y `pendientes` salen del estado de la sesión, no de lo que diga el modelo. */
  private resultado(sesion: Sesion, reply: string, toolCalls: LlamadaVisible[]): ResultadoTurno {
    const pendientes = Object.keys(sesion.pendientes);
    return { reply: redactar(reply), toolCalls, needsConfirmation: pendientes.length > 0, pendientes };
  }

  /** CA1: hasta `iteraciones` idas al modelo; al llegar al tope, un cierre sin herramientas. */
  private async ciclo(t: EstadoTurno): Promise<string> {
    for (let i = 0; i < this.topes.iteraciones; i++) {
      const r = await this.llamarModelo(t);
      if (r.llamadas.length > 0) await this.atender(t, r);
      if (r.fin !== "herramientas" || r.llamadas.length === 0) return this.textoFinal(t, r);
      const tope = this.avisoTope(t.sesion);
      if (tope) return tope;
    }
    return this.cerrarPorTope(t);
  }

  private async cerrarPorTope(t: EstadoTurno): Promise<string> {
    const aviso = `[Aviso del sistema] Se alcanzó el tope de ${this.topes.iteraciones} iteraciones de este turno. Sin llamar herramientas, resume lo que hiciste y lo que quedó pendiente.`;
    t.sesion.historial.push({ rol: "usuario", texto: aviso });
    const r = await this.llamarModelo(t, { sinHerramientas: true });
    if (r.llamadas.length > 0) await this.atender(t, { ...r, fin: "corte" });
    return this.textoFinal(t, r) || `Llegué al tope de ${this.topes.iteraciones} pasos en este turno. Pídeme que continúe.`;
  }

  private async llamarModelo(t: EstadoTurno, opciones?: OpcionesEnvio): Promise<Respuesta> {
    const r = await this.adaptador.enviar(this.sistema, t.sesion.historial, this.definiciones, opciones);
    t.sesion.tokens += r.uso.entrada + r.uso.salida;
    this.sumarUso(r.uso);
    t.emitir({ tipo: "uso", ...r.uso, costoUsd: costoUsd(this.adaptador.modelo, r.uso) });
    // Un asistente sin texto ni llamadas no se guarda: la API rechaza con 400 un mensaje vacío en el turno siguiente (CA5).
    if (r.texto || r.llamadas.length > 0) t.sesion.historial.push({ rol: "asistente", texto: r.texto, llamadas: r.llamadas, crudo: r.crudo });
    if (r.texto) {
      t.ultimoTexto = r.texto;
      t.emitir({ tipo: "texto", texto: redactar(r.texto) });
    }
    return r;
  }

  private textoFinal(t: EstadoTurno, r: Respuesta): string {
    if (r.fin === "rechazo") return r.texto || "El modelo declinó responder esta solicitud. Reformúlala o continúa con otro mensaje.";
    if (r.fin === "corte") return `${t.ultimoTexto}\n\n(La respuesta se cortó por longitud; pídeme que continúe.)`.trim();
    return r.texto || t.ultimoTexto || SIN_TEXTO;
  }

  /**
   * Todas las llamadas de una respuesta reciben su resultado en UN solo mensaje (pareja llamada-resultado).
   * Se ejecutan en serie porque varias escriben el mismo maestro. Si la respuesta no terminó pidiendo
   * herramientas (se cortó), las llamadas quedan sin ejecutar pero igual con su resultado.
   */
  private async atender(t: EstadoTurno, r: Respuesta): Promise<void> {
    // El mensaje de resultados entra antes de ejecutar y se llena en orden: si algo falla a mitad,
    // repararHistorial conserva lo ya ejecutado y completa solo lo que faltó.
    const resultados: ResultadoHerramienta[] = [];
    t.sesion.historial.push({ rol: "resultados", resultados });
    for (const l of r.llamadas) {
      resultados.push(r.fin === "herramientas" ? await this.ejecutarLlamada(t, l) : interrumpida(l.id));
    }
  }

  private async ejecutarLlamada(t: EstadoTurno, l: LlamadaHerramienta): Promise<ResultadoHerramienta> {
    t.emitir({ tipo: "herramienta", id: l.id, nombre: l.nombre, argumentos: l.argumentos });
    const contenido = await this.contenidoDe(t, l);
    actualizarPendientes(t.sesion.pendientes, t.numero, l.nombre, l.argumentos, contenido);
    const { ok, resumen } = resumir(contenido);
    t.visibles.push({ id: l.id, nombre: l.nombre, argumentos: l.argumentos, ok, resumen });
    t.emitir({ tipo: "resultado", id: l.id, nombre: l.nombre, ok, resumen });
    return { id: l.id, contenido, esError: !ok };
  }

  /**
   * Ejecuta por el único punto de ejecución (`ejecutarHerramienta`), salvo herramienta desconocida o confirmación
   * bloqueada (CA3). Un `confirmado: true` sobre un mensaje sin pendiente se ejecuta sin él: `registrar` decide.
   */
  private async contenidoDe(t: EstadoTurno, l: LlamadaHerramienta): Promise<string> {
    const reg = this.registros.find((r) => r.nombre === l.nombre);
    if (!reg) return this.rechazar(t, l, `herramienta desconocida: ${l.nombre}`);
    const decision = decidirConfirmacion(t.sesion.pendientes, t.numero, t.mensaje, l.nombre, l.argumentos);
    if (decision.tipo === "bloquear") return this.rechazar(t, l, decision.motivo);
    const argumentos = decision.tipo === "sin_confirmado" ? { ...(l.argumentos as object), confirmado: undefined } : l.argumentos;
    return ejecutarHerramienta(reg, argumentos, t.ctx);
  }

  /** Respuesta `{ ok: false }` sin ejecutar, anotada igual en out/log.jsonl (RN7, CA4). */
  private rechazar(t: EstadoTurno, l: LlamadaHerramienta, error: string): string {
    const linea = { ts: new Date().toISOString(), herramienta: l.nombre, mensaje_id: mensajeIdDe(l.argumentos), ok: false, resumen: error.slice(0, 200) };
    fs.mkdirSync(dirSalida(t.ctx), { recursive: true });
    fs.appendFileSync(path.join(dirSalida(t.ctx), "log.jsonl"), JSON.stringify(linea) + "\n");
    return fallo(error);
  }
}

/**
 * Crea el ciclo del agente que usa la API (PRD §6.1, §6.3 CA1-CA5, §8).
 * @param opciones adaptador, raíz del proyecto, system prompt, catálogo y topes; todo con valores por defecto.
 */
export function crearMotor(opciones: OpcionesMotor = {}): MotorAgente {
  const directorio = opciones.directorio ?? RAIZ;
  const topes: Topes = {
    iteraciones: opciones.topes?.iteraciones ?? numeroDe(process.env.MAX_ITERACIONES, 25),
    tokensSesion: opciones.topes?.tokensSesion ?? numeroDe(process.env.MAX_TOKENS_SESION, 600_000),
    tokensGlobal: opciones.topes?.tokensGlobal ?? numeroDe(process.env.MAX_TOKENS_GLOBAL, 3_000_000),
  };
  return new Motor(
    opciones.adaptador ?? crearAdaptador(),
    directorio,
    opciones.sistema ?? sistemaPorDefecto(directorio),
    opciones.herramientas ?? catalogo("contratos", contratos),
    topes,
  );
}
