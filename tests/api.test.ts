import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { proyectoTemporal, RAIZ } from "./ayudas.ts";
import { crearApp, type OpcionesApp } from "../src/server.ts";
import { crearMotor } from "../src/agent/motor.ts";
import type { Mensaje } from "../src/llm/adapter.ts";
import { AdaptadorSimulado, respuestaHerramientas, respuestaTexto } from "../src/llm/simulado.ts";
import { leer_buzon } from "../src/tools/contratos.ts";
import { listarMensajes, marcarProcesado } from "../src/tools/almacen.ts";
import type { EventoAgente, MotorAgente, ResultadoTurno, SesionPublica, TurnoGuardado } from "../src/agent/tipos.ts";

const SESION = "sesion-api-1";
const JSON_CABECERA = { "Content-Type": "application/json" };

// ── Ayudas ──

/** Motor de verdad con el adaptador simulado: un turno llama a `contratos_leer_buzon` y responde con texto. */
function motorSimulado(directorio: string): MotorAgente {
  const guion = (mensajes: Mensaje[]) =>
    mensajes.at(-1)?.rol === "usuario"
      ? respuestaHerramientas([{ id: "t1", nombre: "contratos_leer_buzon", argumentos: {} }])
      : respuestaTexto("Hay 6 mensajes en el buzón.");
  return crearMotor({ adaptador: new AdaptadorSimulado(guion), directorio, sistema: "sistema de prueba" });
}

/** Promesa que se resuelve a mano: sirve para dejar un turno "trabajando" mientras se prueba otra petición. */
function diferida() {
  let liberar: () => void = () => {};
  const promesa = new Promise<void>((resolver) => {
    liberar = resolver;
  });
  return { promesa, liberar };
}

/** Motor falso: emite eventos, espera una compuerta y devuelve un resultado fijo. No toca disco. */
class MotorFalso implements MotorAgente {
  llamadas = 0;
  reinicios = 0;
  private readonly guardados = new Map<string, TurnoGuardado[]>();

  constructor(
    private readonly compuerta: Promise<void> = Promise.resolve(),
    private readonly pideConfirmacion = false,
  ) {}

  async turno(sessionId: string, mensaje: string, emitir?: (evento: EventoAgente) => void): Promise<ResultadoTurno> {
    this.llamadas++;
    emitir?.({ tipo: "herramienta", id: "t1", nombre: "contratos_validar", argumentos: { mensaje_id: "msg-006" } });
    await this.compuerta;
    emitir?.({ tipo: "resultado", id: "t1", nombre: "contratos_validar", ok: true, resumen: "nuevo; revisión: valor" });
    const resultado: ResultadoTurno = {
      reply: "Necesito que confirmes el valor.",
      toolCalls: [{ id: "t1", nombre: "contratos_validar", argumentos: { mensaje_id: "msg-006" }, ok: true, resumen: "nuevo; revisión: valor" }],
      needsConfirmation: this.pideConfirmacion,
      pendientes: this.pideConfirmacion ? ["msg-006"] : [],
    };
    this.guardados.set(sessionId, [...(this.guardados.get(sessionId) ?? []), { ts: "2026-09-03T00:00:00Z", usuario: mensaje, ...resultado }]);
    return resultado;
  }

  sesion(sessionId: string): SesionPublica | null {
    const turnos = this.guardados.get(sessionId);
    return turnos ? { id: sessionId, creada: "2026-09-03T00:00:00Z", turnos, tokens: 0 } : null;
  }

  reiniciar(): void {
    this.reinicios++;
    this.guardados.clear();
  }
}

/** Levanta la app en un puerto efímero de localhost; `cerrar` corta también las conexiones SSE abiertas. */
async function levantar(motor: MotorAgente, directorio: string, opciones: OpcionesApp = {}) {
  const app = crearApp(motor, directorio, { info: { provider: "simulado", model: "simulado" }, ...opciones });
  const servidor = await new Promise<Server>((listo) => {
    const s = app.listen(0, "127.0.0.1", () => listo(s));
  });
  const { port } = servidor.address() as AddressInfo;
  const cerrar = () =>
    new Promise<void>((listo) => {
      servidor.closeAllConnections();
      servidor.close(() => listo());
    });
  return { url: `http://127.0.0.1:${port}`, cerrar };
}

const enviarChat = (url: string, cuerpo: unknown, cabeceras: Record<string, string> = {}) =>
  fetch(`${url}/api/chat`, { method: "POST", headers: { ...JSON_CABECERA, ...cabeceras }, body: JSON.stringify(cuerpo) });

interface Trama {
  evento: string | undefined;
  datos: unknown;
}

/** Separa un cuerpo SSE en tramas; los comentarios (": latido") no traen `event:` ni `data:`. */
function tramas(cuerpo: string): Trama[] {
  return cuerpo
    .split("\n\n")
    .filter((t) => t.trim())
    .map((t) => {
      const datos = /^data: (.+)$/m.exec(t)?.[1];
      return { evento: /^event: (.+)$/m.exec(t)?.[1], datos: datos ? (JSON.parse(datos) as unknown) : undefined };
    });
}

async function esperarA(condicion: () => boolean): Promise<void> {
  for (let i = 0; i < 400 && !condicion(); i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(condicion(), "la condición no se cumplió a tiempo");
}

// ── /api/health ──

test("health devuelve solo { ok, provider, model }", async (t) => {
  const ctx = proyectoTemporal();
  const s = await levantar(new MotorFalso(), ctx.directory, { info: { provider: "simulado", model: "modelo-x" } });
  t.after(s.cerrar);
  const r = await fetch(`${s.url}/api/health`);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true, provider: "simulado", model: "modelo-x" });
});

// ── POST /api/chat (JSON) ──

test("chat en JSON responde reply, toolCalls y needsConfirmation", async (t) => {
  const ctx = proyectoTemporal();
  const s = await levantar(motorSimulado(ctx.directory), ctx.directory);
  t.after(s.cerrar);
  const r = await enviarChat(s.url, { sessionId: SESION, message: "procesa el buzón" });
  assert.equal(r.status, 200);
  const cuerpo = (await r.json()) as ResultadoTurno;
  assert.equal(cuerpo.reply, "Hay 6 mensajes en el buzón.");
  assert.equal(cuerpo.toolCalls.length, 1);
  assert.equal(cuerpo.toolCalls[0]?.nombre, "contratos_leer_buzon");
  assert.equal(cuerpo.toolCalls[0]?.ok, true);
  assert.equal(cuerpo.needsConfirmation, false);
});

test("chat en JSON propaga needsConfirmation y los mensajes pendientes del motor (CA3)", async (t) => {
  const ctx = proyectoTemporal();
  const s = await levantar(new MotorFalso(Promise.resolve(), true), ctx.directory);
  t.after(s.cerrar);
  const cuerpo = (await (await enviarChat(s.url, { sessionId: SESION, message: "hola" })).json()) as ResultadoTurno;
  assert.equal(cuerpo.needsConfirmation, true);
  assert.deepEqual(cuerpo.pendientes, ["msg-006"]);
});

test("un body inválido responde 400 con un error claro en español", async (t) => {
  const ctx = proyectoTemporal();
  const motor = new MotorFalso();
  const s = await levantar(motor, ctx.directory);
  t.after(s.cerrar);
  const casos: Array<[string, unknown, RegExp]> = [
    ["sin message", { sessionId: SESION }, /message es obligatorio/],
    ["message vacío", { sessionId: SESION, message: "" }, /no puede estar vacío/],
    ["message de solo espacios", { sessionId: SESION, message: "   " }, /no puede estar vacío/],
    ["message de 4001 caracteres", { sessionId: SESION, message: "a".repeat(4001) }, /máximo de 4000/],
    ["sin sessionId", { message: "hola" }, /sessionId es obligatorio/],
    ["sessionId con caracteres raros", { sessionId: "../../etc", message: "hola" }, /sessionId inválido/],
    ["cuerpo que es una lista y no un objeto", ["hola"], /objeto JSON/],
  ];
  for (const [nombre, cuerpo, patron] of casos) {
    const r = await enviarChat(s.url, cuerpo);
    assert.equal(r.status, 400, nombre);
    const { error } = (await r.json()) as { error: string };
    assert.match(error, patron, nombre);
  }
  assert.equal(motor.llamadas, 0, "un body inválido nunca llega al motor");
});

test("un message de exactamente 4000 caracteres se acepta", async (t) => {
  const ctx = proyectoTemporal();
  const s = await levantar(new MotorFalso(), ctx.directory);
  t.after(s.cerrar);
  const r = await enviarChat(s.url, { sessionId: SESION, message: "a".repeat(4000) });
  assert.equal(r.status, 200);
});

test("JSON roto responde 400 y un cuerpo de más de 32 kb responde 413, sin filtrar detalles internos", async (t) => {
  const ctx = proyectoTemporal();
  const s = await levantar(new MotorFalso(), ctx.directory);
  t.after(s.cerrar);
  const roto = await fetch(`${s.url}/api/chat`, { method: "POST", headers: JSON_CABECERA, body: "{no es json" });
  assert.equal(roto.status, 400);
  assert.match(((await roto.json()) as { error: string }).error, /no es un JSON válido/);
  const grande = await fetch(`${s.url}/api/chat`, { method: "POST", headers: JSON_CABECERA, body: JSON.stringify({ sessionId: SESION, message: "a".repeat(40_000) }) });
  assert.equal(grande.status, 413);
  assert.match(((await grande.json()) as { error: string }).error, /demasiado grande/);
});

// ── GET /api/sessions/:id ──

test("sessions responde 404 antes del primer turno y 200 con el historial después", async (t) => {
  const ctx = proyectoTemporal();
  const s = await levantar(motorSimulado(ctx.directory), ctx.directory);
  t.after(s.cerrar);
  const antes = await fetch(`${s.url}/api/sessions/${SESION}`);
  assert.equal(antes.status, 404);
  assert.match(((await antes.json()) as { error: string }).error, /No existe una sesión/);

  await enviarChat(s.url, { sessionId: SESION, message: "procesa el buzón" });
  const despues = await fetch(`${s.url}/api/sessions/${SESION}`);
  assert.equal(despues.status, 200);
  const sesion = (await despues.json()) as SesionPublica;
  assert.equal(sesion.id, SESION);
  assert.equal(sesion.turnos.length, 1);
  assert.equal(sesion.turnos[0]?.usuario, "procesa el buzón");
  assert.equal(sesion.turnos[0]?.toolCalls[0]?.nombre, "contratos_leer_buzon");
  assert.ok(!("historial" in sesion), "el historial crudo del proveedor no sale por la API");
});

test("sessions con un id inválido responde 404, no un error de servidor", async (t) => {
  const ctx = proyectoTemporal();
  const s = await levantar(motorSimulado(ctx.directory), ctx.directory);
  t.after(s.cerrar);
  const r = await fetch(`${s.url}/api/sessions/${encodeURIComponent("../x")}`);
  assert.equal(r.status, 404);
});

// ── POST /api/reset ──

test("reset responde ok, borra out/ y deja el buzón con los 6 mensajes", async (t) => {
  const ctx = proyectoTemporal();
  const s = await levantar(motorSimulado(ctx.directory), ctx.directory);
  t.after(s.cerrar);
  await enviarChat(s.url, { sessionId: SESION, message: "procesa el buzón" });
  for (const id of listarMensajes(ctx)) marcarProcesado(ctx, id, "registrado", null);
  const pendientes = async () => (JSON.parse(await leer_buzon.execute({}, ctx)) as { data: { mensajes: unknown[] } }).data.mensajes.length;
  assert.equal(await pendientes(), 0, "antes del reset todo está procesado");

  const r = await fetch(`${s.url}/api/reset`, { method: "POST" });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true });
  assert.equal(fs.existsSync(path.join(ctx.directory, "out", "procesados.json")), false);
  assert.equal(await pendientes(), 6);
  assert.equal((await fetch(`${s.url}/api/sessions/${SESION}`)).status, 404, "las sesiones también se olvidan");
});

// ── SSE ──

test("con Accept: text/event-stream responde SSE con las cabeceras correctas y termina con 'fin'", async (t) => {
  const ctx = proyectoTemporal();
  const s = await levantar(motorSimulado(ctx.directory), ctx.directory);
  t.after(s.cerrar);
  const r = await enviarChat(s.url, { sessionId: SESION, message: "procesa el buzón" }, { Accept: "text/event-stream" });
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type") ?? "", /^text\/event-stream/);
  assert.equal(r.headers.get("cache-control"), "no-cache");
  assert.equal(r.headers.get("connection"), "keep-alive");
  assert.equal(r.headers.get("x-accel-buffering"), "no");

  const eventos = tramas(await r.text()).filter((e) => e.evento);
  assert.deepEqual(
    eventos.map((e) => e.evento).filter((n) => n !== "uso"),
    ["herramienta", "resultado", "texto", "fin"],
  );
  assert.equal(eventos.at(-1)?.evento, "fin", "el último evento es 'fin'");
  const fin = eventos.at(-1)?.datos as ResultadoTurno;
  assert.equal(fin.reply, "Hay 6 mensajes en el buzón.");
  assert.equal(fin.toolCalls.length, 1);
  assert.equal(fin.needsConfirmation, false);
  const resultado = eventos.find((e) => e.evento === "resultado")?.datos as { ok: boolean; nombre: string };
  assert.equal(resultado.nombre, "contratos_leer_buzon");
  assert.equal(resultado.ok, true);
});

test("el stream manda un comentario ': latido' mientras el turno sigue trabajando", async (t) => {
  const ctx = proyectoTemporal();
  const { promesa, liberar } = diferida();
  const motor = new MotorFalso(promesa);
  const s = await levantar(motor, ctx.directory, { latidoMs: 20 });
  t.after(s.cerrar);
  const respuesta = enviarChat(s.url, { sessionId: SESION, message: "hola" }, { Accept: "text/event-stream" });
  await esperarA(() => motor.llamadas === 1);
  await new Promise((r) => setTimeout(r, 120));
  liberar();
  const cuerpo = await (await respuesta).text();
  assert.match(cuerpo, /^: latido$/m);
  assert.equal(tramas(cuerpo).filter((e) => e.evento).at(-1)?.evento, "fin");
});

// ── Un turno a la vez por sesión ──

test("un segundo mensaje de la misma sesión mientras hay un turno en curso recibe 409; otra sesión no", async (t) => {
  const ctx = proyectoTemporal();
  const { promesa, liberar } = diferida();
  const motor = new MotorFalso(promesa);
  const s = await levantar(motor, ctx.directory);
  t.after(s.cerrar);
  const primera = enviarChat(s.url, { sessionId: SESION, message: "uno" });
  await esperarA(() => motor.llamadas === 1);

  const segunda = await enviarChat(s.url, { sessionId: SESION, message: "dos" });
  assert.equal(segunda.status, 409);
  assert.match(((await segunda.json()) as { error: string }).error, /turno en curso/);
  const reinicio = await fetch(`${s.url}/api/reset`, { method: "POST" });
  assert.equal(reinicio.status, 409, "no se reinicia la demo con un turno corriendo");
  assert.equal(motor.reinicios, 0);

  const otra = enviarChat(s.url, { sessionId: "sesion-api-2", message: "tres" });
  await esperarA(() => motor.llamadas === 2);
  liberar();
  assert.equal((await primera).status, 200);
  assert.equal((await otra).status, 200);
  assert.equal((await enviarChat(s.url, { sessionId: SESION, message: "cuatro" })).status, 200, "la sesión queda libre al terminar");
});

// ── Límite por IP ──

test("pasado el límite de turnos por hora responde 429 con Retry-After y un mensaje claro", async (t) => {
  const ctx = proyectoTemporal();
  const motor = new MotorFalso();
  const s = await levantar(motor, ctx.directory, { limiteTurnosHora: 2 });
  t.after(s.cerrar);
  assert.equal((await enviarChat(s.url, { sessionId: SESION, message: "uno" })).status, 200);
  assert.equal((await enviarChat(s.url, { sessionId: SESION, message: "dos" })).status, 200);
  const tercera = await enviarChat(s.url, { sessionId: SESION, message: "tres" });
  assert.equal(tercera.status, 429);
  assert.ok(Number(tercera.headers.get("retry-after")) > 0);
  assert.match(((await tercera.json()) as { error: string }).error, /límite de turnos por hora/);
  assert.equal(motor.llamadas, 2);
});

// ── Estático y rutas desconocidas ──

test("sirve web/ como estático y las rutas /api desconocidas responden 404 en JSON", async (t) => {
  const ctx = proyectoTemporal();
  const s = await levantar(new MotorFalso(), ctx.directory);
  t.after(s.cerrar);
  const inicio = await fetch(`${s.url}/`);
  assert.equal(inicio.status, 200);
  assert.match(inicio.headers.get("content-type") ?? "", /text\/html/);
  assert.match(await inicio.text(), /Agente de registro de contratos/);
  assert.equal((await fetch(`${s.url}/app.js`)).status, 200);
  const desconocida = await fetch(`${s.url}/api/no-existe`);
  assert.equal(desconocida.status, 404);
  assert.deepEqual(await desconocida.json(), { error: "Ruta no encontrada." });
});

// ── Front ──

test("el botón «Ejemplo del PRD §11» usa el prompt literal del PRD", () => {
  const prd = fs.readFileSync(path.join(RAIZ, "PRD.md"), "utf8");
  const seccion = prd.slice(prd.indexOf("## 11. Prompt de ejemplo"));
  const bloque = /```\n([\s\S]*?)\n```/.exec(seccion)?.[1];
  assert.ok(bloque, "no se encontró el bloque de código del §11 en PRD.md");
  const app = fs.readFileSync(path.join(RAIZ, "web", "app.js"), "utf8");
  const enFront = /const PROMPT_PRD =\s*"([^"]+)"/.exec(app)?.[1];
  assert.ok(enFront, "no se encontró PROMPT_PRD en web/app.js");
  const normal = (texto: string) => texto.replace(/\s+/g, " ").trim();
  assert.equal(normal(enFront), normal(bloque));
});

test("el front no contiene claves ni usa innerHTML", () => {
  for (const archivo of ["index.html", "app.js", "estilos.css"]) {
    const texto = fs.readFileSync(path.join(RAIZ, "web", archivo), "utf8");
    assert.doesNotMatch(texto, /sk-ant|ANTHROPIC_API_KEY/, archivo);
    assert.doesNotMatch(texto, /innerHTML/, `${archivo} no debe insertar HTML crudo`);
  }
});
