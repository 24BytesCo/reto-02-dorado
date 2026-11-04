import path from "node:path";
import express, { type Express, type NextFunction, type Request, type RequestHandler, type Response } from "express";
import { crearEnfriamiento, enfriamientoDeEntorno, turnoConProposito, type OpcionesEnfriamiento } from "./enfriamiento.ts";
import { z } from "zod";
import { crearMotor } from "./agent/motor.ts";
import { errorDeId } from "./agent/sesiones.ts";
import type { MotorAgente, ResultadoTurno } from "./agent/tipos.ts";
import { crearAdaptador } from "./llm/adapter.ts";
import { redactar } from "./llm/errores.ts";
import { limpiarSalida } from "./tools/almacen.ts";

/**
 * API HTTP del agente (PRD §6.4): chat con stream de eventos, sesiones, salud y reinicio.
 * Solo traduce HTTP ↔ motor: la lógica de negocio vive en src/tools/ y el ciclo en src/agent/.
 */

const RAIZ = path.resolve(import.meta.dirname, "..");
const DIR_WEB = path.join(RAIZ, "web");

/** El proxy (NPM) corta a los 60 s y Cloudflare a los 100 s sin bytes: un latido cada 15 s los mantiene abiertos. */
const LATIDO_MS = 15_000;
/** Tope de costo por IP (PRD §8): turnos aceptados por hora. */
const LIMITE_TURNOS_HORA = 40;
const HORA_MS = 3_600_000;

/** Proveedor y modelo que informa `GET /api/health`; nunca incluye claves (PRD §6.4). */
export interface InfoProveedor {
  provider: string;
  model: string;
}

/** Commit desplegado (`GIT_SHA`, que fija el Dockerfile con `--build-arg`), o `local` fuera de la imagen: así se ve qué versión corre el link. */
export const commitDesplegado = (entorno: NodeJS.ProcessEnv = process.env): string => entorno.GIT_SHA?.trim() || "local";

/** Ajustes de `crearApp`; todos tienen valor por defecto para producción y las pruebas los acortan. */
export interface OpcionesApp {
  info?: InfoProveedor;
  /** Turnos por IP y hora (`LIMITE_TURNOS_HORA` en el entorno; 40 por defecto). */
  limiteTurnosHora?: number;
  latidoMs?: number;
  /** Pausa por conversación fuera de propósito; sin valor, desactivada (las pruebas la activan a propósito). */
  enfriamiento?: OpcionesEnfriamiento;
}

const MENSAJES = {
  ocupada: "Esta sesión ya tiene un turno en curso. Espera a que el agente termine antes de enviar otro mensaje.",
  reiniciarOcupado: "Hay un turno del agente en curso. Espera a que termine para reiniciar la demo.",
  reiniciarFallo: "No se pudo limpiar la carpeta de salida. Inténtalo de nuevo; si persiste, avisa al administrador.",
  interno: "Error interno del servidor. La sesión sigue activa; vuelve a intentarlo.",
  noEncontrada: "Ruta no encontrada.",
  sinSesion: "No existe una sesión con ese identificador.",
  jsonInvalido: "El cuerpo de la petición no es un JSON válido.",
  grande: "La petición es demasiado grande (máximo 32 kb).",
} as const;

/** Cuerpo de `POST /api/chat` (PRD §6.4). Los mensajes de error van en español para la analista. */
const Peticion = z.object(
  {
    sessionId: z
      .string({ error: "sessionId es obligatorio y debe ser texto." })
      .superRefine((id, ctx) => {
        const error = errorDeId(id);
        if (error) ctx.addIssue({ code: "custom", message: error });
      }),
    message: z
      .string({ error: "message es obligatorio y debe ser texto." })
      .min(1, { error: "message no puede estar vacío." })
      .max(4000, { error: "message supera el máximo de 4000 caracteres." })
      .refine((texto) => texto.trim().length > 0, { error: "message no puede estar vacío." }),
  },
  { error: "El cuerpo debe ser un objeto JSON con sessionId y message." },
);

function textoDeErrores(error: z.ZodError): string {
  return `Petición inválida. ${error.issues.map((i) => i.message).join(" ")}`;
}

/** Límite simple por clave en memoria (ventana deslizante). Se reinicia con el proceso, y basta para la demo (PRD §8 Costo). */
function crearLimitador(maximo: number, ventanaMs: number) {
  const usos = new Map<string, number[]>();
  const purgar = (ahora: number) => {
    for (const [clave, marcas] of usos) if (ahora - (marcas.at(-1) ?? 0) >= ventanaMs) usos.delete(clave);
  };
  return {
    /** Consume un turno de la clave. Devuelve 0 si cabía, o los segundos que faltan para que se libere un cupo. */
    intentar(clave: string, ahora = Date.now()): number {
      if (usos.size > 500) purgar(ahora);
      const recientes = (usos.get(clave) ?? []).filter((t) => ahora - t < ventanaMs);
      if (recientes.length >= maximo) {
        usos.set(clave, recientes);
        return Math.max(1, Math.ceil(((recientes[0] ?? ahora) + ventanaMs - ahora) / 1000));
      }
      usos.set(clave, [...recientes, ahora]);
      return 0;
    },
  };
}

const pideStream = (req: Request): boolean => (req.get("accept") ?? "").includes("text/event-stream");

/** Escribe en el stream solo si el cliente sigue ahí: si se fue, el turno termina igual pero nadie lo escucha. */
function escribir(res: Response, trozo: string): void {
  if (!res.destroyed && !res.writableEnded) res.write(trozo);
}

/** Un evento SSE: `event: <tipo>` y los datos como JSON en una sola línea. */
function enviarEvento(res: Response, nombre: string, datos: unknown): void {
  escribir(res, `event: ${nombre}\ndata: ${JSON.stringify(datos)}\n\n`);
}

/** Aviso previo a la pausa (desde el segundo mensaje seguido sin trabajo): cuántos van y qué pasa al llegar al umbral. */
function avisoPrevio(seguidos: number, umbral: number, minutosBase: number): string | undefined {
  if (umbral <= 0 || seguidos < 2 || seguidos >= umbral) return undefined;
  return `Llevas ${seguidos} de ${umbral} mensajes seguidos fuera del propósito de esta herramienta. Al llegar a ${umbral}, la conexión queda en pausa ${minutosBase} min. Para seguir: procesa el buzón, revisa un contrato o pide las alertas.`;
}

/** Aviso de la pausa por uso fuera de propósito: explica para qué sirve la herramienta y cuánto falta. */
function mensajePausa(segundos: number): string {
  const minutos = Math.ceil(segundos / 60);
  return `Esta herramienta es solo para el registro de contratos. Por varios mensajes seguidos fuera de ese propósito, esta conexión queda en pausa ${minutos} min. Después podrás procesar el buzón, revisar un contrato o generar las alertas.`;
}

/** Resultado de respaldo si el motor llegara a lanzar (su contrato dice que no): la sesión no muere (CA5). */
function resultadoDeError(): ResultadoTurno {
  return { reply: MENSAJES.interno, toolCalls: [], needsConfirmation: false, pendientes: [] };
}

async function turnoSeguro(motor: MotorAgente, sessionId: string, message: string, emitir?: Parameters<MotorAgente["turno"]>[2]): Promise<ResultadoTurno> {
  try {
    return await motor.turno(sessionId, message, emitir);
  } catch {
    return resultadoDeError();
  }
}

/** Decora el resultado del turno antes de enviarlo (hoy: el aviso previo a la pausa). */
type Decorar = (resultado: ResultadoTurno) => ResultadoTurno;

/**
 * Responde el turno como stream SSE: un evento por cada `EventoAgente`, latido periódico y un `fin` con el resultado.
 * Si el navegador se desconecta, el turno se completa igual y queda en la sesión.
 */
async function responderStream(res: Response, motor: MotorAgente, sessionId: string, message: string, latidoMs: number, decorar: Decorar): Promise<ResultadoTurno> {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();
  escribir(res, ": abierto\n\n");
  const latido = setInterval(() => escribir(res, ": latido\n\n"), latidoMs);
  try {
    const resultado = decorar(await turnoSeguro(motor, sessionId, message, (evento) => enviarEvento(res, evento.tipo, evento)));
    enviarEvento(res, "fin", resultado);
    return resultado;
  } finally {
    clearInterval(latido);
    res.end();
  }
}

async function responderJson(res: Response, motor: MotorAgente, sessionId: string, message: string, decorar: Decorar): Promise<ResultadoTurno> {
  const resultado = decorar(await turnoSeguro(motor, sessionId, message));
  res.json(resultado);
  return resultado;
}

/** Error del analizador del cuerpo (`express.json`): JSON roto o más de 32 kb. */
function estadoDeCuerpo(error: unknown): { estado: number; mensaje: string } | null {
  if (typeof error !== "object" || error === null || !("type" in error)) return null;
  if (error.type === "entity.too.large") return { estado: 413, mensaje: MENSAJES.grande };
  if (error.type === "entity.parse.failed") return { estado: 400, mensaje: MENSAJES.jsonInvalido };
  return null;
}

/** Errores siempre en lenguaje claro: nunca el mensaje interno ni la traza, y redactados por si acaso (PRD §8 Seguridad). */
function manejarErrores(error: unknown, _req: Request, res: Response, _next: NextFunction): void {
  const cuerpo = estadoDeCuerpo(error);
  if (res.headersSent) {
    res.end();
    return;
  }
  res.status(cuerpo?.estado ?? 500).json({ error: redactar(cuerpo?.mensaje ?? MENSAJES.interno) });
}

function cabecerasDeSeguridad(_req: Request, res: Response, next: NextFunction): void {
  res.set({
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "default-src 'self'; frame-ancestors 'none'",
  });
  next();
}

/** `info` de respaldo cuando quien crea la app no lo pasa: lo que dice el entorno (el arranque real pasa el del adaptador). */
function infoDeEntorno(entorno: NodeJS.ProcessEnv = process.env): InfoProveedor {
  const provider = (entorno.LLM_PROVEEDOR || "anthropic").trim().toLowerCase();
  return { provider, model: provider === "simulado" ? "simulado" : entorno.LLM_MODELO || "claude-opus-5-5" };
}

/**
 * Crea la app Express con la API del PRD §6.4 y el front estático de `web/`.
 * No escucha en ningún puerto: eso lo hace el arranque, así las pruebas la levantan donde quieran.
 * @param motor ciclo del agente (CA1-CA5).
 * @param directorio raíz del proyecto, de donde sale `out/` para el reinicio.
 */
export function crearApp(motor: MotorAgente, directorio: string, opciones: OpcionesApp = {}): Express {
  const info = opciones.info ?? infoDeEntorno();
  const latidoMs = opciones.latidoMs ?? LATIDO_MS;
  const limitador = crearLimitador(opciones.limiteTurnosHora ?? LIMITE_TURNOS_HORA, HORA_MS);
  const configEnfriamiento = opciones.enfriamiento ?? { umbral: 0, minutosBase: 1, maximoMinutos: 1 };
  const enfriamiento = crearEnfriamiento(configEnfriamiento);
  // El aviso se decide después del turno, pero se envía dentro del resultado: por eso el enfriamiento se consulta antes de responder.
  const conAviso = (resultado: ResultadoTurno, ip: string, mensaje: string): ResultadoTurno => {
    const r = enfriamiento.registrar(ip, turnoConProposito(mensaje, resultado));
    const aviso = avisoPrevio(r.seguidos, r.umbral, configEnfriamiento.minutosBase);
    return aviso ? { ...resultado, aviso } : resultado;
  };
  // Una sesión con turno en curso rechaza otro (409): el motor los encadenaría, pero la analista debe saberlo.
  const enCurso = new Set<string>();

  const chat: RequestHandler = async (req, res) => {
    const peticion = Peticion.safeParse(req.body);
    if (!peticion.success) {
      res.status(400).json({ error: textoDeErrores(peticion.error) });
      return;
    }
    const { sessionId, message } = peticion.data;
    if (enCurso.has(sessionId)) {
      res.status(409).json({ error: MENSAJES.ocupada });
      return;
    }
    const ip = req.ip ?? "desconocida";
    const pausa = enfriamiento.bloqueo(ip);
    if (pausa > 0) {
      res.set("Retry-After", String(pausa));
      res.status(429).json({ error: mensajePausa(pausa) });
      return;
    }
    const espera = limitador.intentar(ip);
    if (espera > 0) {
      res.set("Retry-After", String(espera));
      res.status(429).json({ error: `Se alcanzó el límite de turnos por hora desde esta conexión. Vuelve a intentarlo en ${Math.ceil(espera / 60)} min.` });
      return;
    }
    enCurso.add(sessionId);
    try {
      const decorar = (resultado: ResultadoTurno) => conAviso(resultado, ip, message);
      await (pideStream(req) ? responderStream(res, motor, sessionId, message, latidoMs, decorar) : responderJson(res, motor, sessionId, message, decorar));
    } finally {
      enCurso.delete(sessionId);
    }
  };

  const reiniciar: RequestHandler = (_req, res) => {
    if (enCurso.size > 0) {
      res.status(409).json({ error: MENSAJES.reiniciarOcupado });
      return;
    }
    try {
      limpiarSalida({ directory: directorio, sessionId: "reinicio" });
      motor.reiniciar();
      res.json({ ok: true });
    } catch {
      res.status(500).json({ error: MENSAJES.reiniciarFallo });
    }
  };

  const app = express();
  app.disable("x-powered-by");
  // Detrás de Cloudflare → NPM la IP real viene en X-Forwarded-For; solo se confía en proxies de red privada.
  app.set("trust proxy", "loopback, linklocal, uniquelocal");
  app.use(cabecerasDeSeguridad);
  app.use("/api", (_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });
  app.use("/api", express.json({ limit: "32kb" }));
  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, provider: info.provider, model: info.model, commit: commitDesplegado() });
  });
  app.post("/api/chat", chat);
  app.get("/api/sessions/:id", (req, res) => {
    const invalido = errorDeId(req.params.id);
    if (invalido) {
      res.status(400).json({ error: invalido });
      return;
    }
    const sesion = motor.sesion(req.params.id);
    if (sesion) res.json(sesion);
    else res.status(404).json({ error: MENSAJES.sinSesion });
  });
  app.post("/api/reset", reiniciar);
  app.use("/api", (_req, res) => {
    res.status(404).json({ error: MENSAJES.noEncontrada });
  });
  // `no-transform` en el HTML: Cloudflare no inyecta su script en línea de detección de bots, que la CSP
  // estricta bloquearía (documentación de JavaScript Detections). Así no hace falta abrir 'unsafe-inline'.
  // `no-cache` también en JS y CSS: tras un despliegue el navegador revalida y no sirve un app.js de hace horas.
  app.use(express.static(DIR_WEB, {
    setHeaders: (res, ruta) => {
      if (ruta.endsWith(".html")) res.setHeader("Cache-Control", "no-cache, no-transform");
      else if (ruta.endsWith(".js") || ruta.endsWith(".css")) res.setHeader("Cache-Control", "no-cache");
    },
  }));
  app.use(manejarErrores);
  return app;
}

/** Carga `.env` sin leerlo ni imprimirlo: si no existe (producción lee el entorno del contenedor) se sigue sin él. */
function cargarEntorno(): void {
  try {
    process.loadEnvFile(path.join(RAIZ, ".env"));
  } catch {
    // Sin .env: las variables ya vienen del entorno.
  }
}

function leerPuerto(valor: string | undefined): number {
  const n = Number(valor);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : 3000;
}

/** Arranque real: carga el entorno, crea el motor con el adaptador elegido y escucha en `PORT` (3000 por defecto). */
function arrancar(): void {
  cargarEntorno();
  try {
    const adaptador = crearAdaptador();
    const limite = Number(process.env.LIMITE_TURNOS_HORA);
    const app = crearApp(crearMotor({ adaptador, directorio: RAIZ }), RAIZ, {
      info: { provider: adaptador.proveedor, model: adaptador.modelo },
      limiteTurnosHora: limite > 0 ? Math.floor(limite) : undefined,
      enfriamiento: enfriamientoDeEntorno(),
    });
    const puerto = leerPuerto(process.env.PORT);
    const servidor = app.listen(puerto, () => console.log(`Agente de registro de contratos en http://localhost:${puerto} (${adaptador.proveedor}/${adaptador.modelo})`));
    // Más que el keep-alive del proxy (NPM/nginx) para que no cierre una conexión que el proxy ya reutilizó (502 intermitente).
    servidor.keepAliveTimeout = 65_000;
    // Docker manda SIGTERM al proceso 1; Node no lo atiende solo y tardaría 10 s en morir.
    process.on("SIGTERM", () => process.exit(0));
  } catch (error) {
    console.error(redactar(`No se pudo arrancar: ${error instanceof Error ? error.message : String(error)}`));
    process.exit(1);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) arrancar();
