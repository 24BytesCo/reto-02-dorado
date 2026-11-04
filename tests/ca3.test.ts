import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { proyectoTemporal } from "./ayudas.ts";
import type { Contexto } from "../src/tools/nucleo.ts";
import type { Mensaje, Respuesta } from "../src/llm/adapter.ts";
import { AdaptadorAnthropic, SIN_CLAVE } from "../src/llm/anthropic.ts";
import { ErrorLlm } from "../src/llm/errores.ts";
import { AdaptadorSimulado, respuestaHerramientas as rh, respuestaTexto as rt, type PasoGuion } from "../src/llm/simulado.ts";
import { actualizarPendientes, decidirConfirmacion, MENSAJE_BLOQUEO, MENSAJE_SIN_CONFIRMACION, mensajeConfirma, type Pendientes } from "../src/agent/confirmacion.ts";
import { crearMotor, type OpcionesMotor } from "../src/agent/motor.ts";

/** Pruebas adversarias del ciclo con las herramientas reales: CA3 burlable, rollback, respuesta vacía y topes. */

const SESION = "sesion-ca3";
const CONFIRMACION_PRD = "confirmo el valor 0 y la fecha fin 2027-08-31";
const VALIDAR_006 = { id: "v1", nombre: "contratos_validar", argumentos: { mensaje_id: "msg-006" } };
const registrar006 = (contrato?: Record<string, unknown>) => ({
  id: "r1",
  nombre: "contratos_registrar",
  argumentos: { mensaje_id: "msg-006", confirmado: true, ...(contrato ? { contrato } : {}) },
});

function preparar(guion: PasoGuion[], extra: OpcionesMotor = {}) {
  const ctx = proyectoTemporal();
  const adaptador = new AdaptadorSimulado(guion);
  return { ctx, adaptador, motor: crearMotor({ adaptador, directorio: ctx.directory, sistema: "s", ...extra }) };
}

const maestro = (ctx: Contexto) => {
  const archivo = path.join(ctx.directory, "out", "sharepoint", "maestro-contratos.csv");
  return fs.existsSync(archivo) ? fs.readFileSync(archivo, "utf8") : "";
};
const leerLog = (ctx: Contexto) =>
  fs.readFileSync(path.join(ctx.directory, "out", "log.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);

/** T1 valida msg-006 y pregunta; T2 trae la llamada a registrar indicada con el mensaje de la analista. */
async function confirmarEnT2(mensaje: string, contrato?: Record<string, unknown>) {
  const p = preparar([rh([VALIDAR_006]), rt("¿Confirmas valor 0 y fecha fin 2027-08-31?"), rh([registrar006(contrato)]), rt("fin")]);
  const t1 = await p.motor.turno(SESION, "procesa msg-006");
  assert.deepEqual(t1.pendientes, ["msg-006"]);
  return { ...p, t2: await p.motor.turno(SESION, mensaje) };
}

test("CA3: «NO confirmo nada» con valores inventados se bloquea y queda en log.jsonl", async () => {
  const { ctx, t2 } = await confirmarEnT2("NO confirmo nada, no registres", { valor: 999999999, fecha_fin: "2030-01-01", cliente: "=HYPERLINK(1)" });
  assert.equal(t2.toolCalls[0].ok, false);
  assert.equal(t2.toolCalls[0].resumen, MENSAJE_SIN_CONFIRMACION.slice(0, 200));
  assert.doesNotMatch(maestro(ctx), /CM-2026-03/);
  assert.deepEqual(t2.pendientes, ["msg-006"]);
  const bloqueo = leerLog(ctx).at(-1);
  assert.equal(bloqueo?.herramienta, "contratos_registrar");
  assert.equal(bloqueo?.ok, false);
});

test("CA3: «confirmo» con un valor que ni propuso la extracción ni escribió la analista se bloquea", async () => {
  const { ctx, t2 } = await confirmarEnT2("confirmo", { valor: 999999999 });
  assert.equal(t2.toolCalls[0].ok, false);
  assert.match(t2.toolCalls[0].resumen, /valor/);
  assert.doesNotMatch(maestro(ctx), /CM-2026-03/);
});

test("CA3 §11: «confirmo el valor 0 y la fecha fin 2027-08-31» registra msg-006", async () => {
  const { ctx, t2 } = await confirmarEnT2(CONFIRMACION_PRD, { valor: 0, fecha_fin: "2027-08-31" });
  assert.equal(t2.toolCalls[0].ok, true, t2.toolCalls[0].resumen);
  assert.match(maestro(ctx), /CM-2026-03/);
  assert.equal(t2.needsConfirmation, false);
});

test("CA3: «confirmo» a secas con los valores propuestos registra msg-006", async () => {
  for (const contrato of [undefined, { valor: 0, fecha_fin: "2027-08-31" }]) {
    const { ctx, t2 } = await confirmarEnT2("Sí, confirmo", contrato);
    assert.equal(t2.toolCalls[0].ok, true, t2.toolCalls[0].resumen);
    assert.match(maestro(ctx), /CM-2026-03/);
  }
});

test("CA3: confirmar en el mismo turno sigue bloqueado aunque el mensaje diga «confirmo»", async () => {
  const { ctx, motor } = preparar([rh([VALIDAR_006]), rh([registrar006()]), rt("¿Confirmas?")]);
  const r = await motor.turno(SESION, "confirmo todo de antemano");
  assert.equal(r.toolCalls[1].resumen, MENSAJE_BLOQUEO.slice(0, 200));
  assert.doesNotMatch(maestro(ctx), /CM-2026-03/);
});

test("CA3: confirmado:true sobre msg-001 limpio en el primer turno se registra (§11 «registra lo limpio»)", async () => {
  const { ctx, motor } = preparar([rh([{ id: "a", nombre: "contratos_registrar", argumentos: { mensaje_id: "msg-001", confirmado: true } }]), rt("fin")]);
  const r = await motor.turno(SESION, "registra msg-001");
  assert.equal(r.toolCalls[0].ok, true, r.toolCalls[0].resumen);
  assert.equal(r.needsConfirmation, false);
  assert.ok(maestro(ctx).split("\n").length > 1);
});

test("CA3: validar que da duplicado tras registrar no reactiva el pendiente", async () => {
  const { t2 } = await (async () => {
    const p = preparar([rh([VALIDAR_006]), rt("¿Confirmas?"), rh([registrar006()]), rh([{ ...VALIDAR_006, id: "v2" }]), rt("Quedó registrado.")]);
    await p.motor.turno(SESION, "procesa msg-006");
    return { t2: await p.motor.turno(SESION, CONFIRMACION_PRD) };
  })();
  assert.equal(t2.toolCalls[0].ok, true);
  assert.equal(t2.needsConfirmation, false);
  assert.deepEqual(t2.pendientes, []);
});

test("CA3 en unidad: Object.hasOwn y turno numérico; un id «constructor» no salta el candado", () => {
  const pendientes: Pendientes = {};
  const args = { mensaje_id: "constructor", confirmado: true };
  assert.deepEqual(decidirConfirmacion(pendientes, 5, "confirmo", "contratos_registrar", args), { tipo: "sin_confirmado" });
  const pide = JSON.stringify({ ok: true, data: { clasificacion: "nuevo", requiere_revision: ["valor"], propuesta: { valor: "0" } } });
  actualizarPendientes(pendientes, 5, "contratos_validar", { mensaje_id: "constructor" }, pide);
  assert.ok(Object.hasOwn(pendientes, "constructor"));
  assert.equal(decidirConfirmacion(pendientes, 5, "confirmo", "contratos_registrar", args).tipo, "bloquear");
  assert.equal(decidirConfirmacion(pendientes, 6, "confirmo", "contratos_registrar", args).tipo, "ejecutar");
  const duplicado = JSON.stringify({ ok: true, data: { clasificacion: "duplicado", requiere_revision: ["valor"] } });
  actualizarPendientes(pendientes, 6, "contratos_validar", { mensaje_id: "otro" }, duplicado);
  assert.equal(Object.hasOwn(pendientes, "otro"), false);
});

test("CA3 en unidad: afirmación sin negación; números sin separadores y fechas DD/MM/AAAA", () => {
  assert.equal(mensajeConfirma("Sí, de acuerdo"), true);
  assert.equal(mensajeConfirma("no apruebo"), false);
  assert.equal(mensajeConfirma("hola"), false);
  const pendientes: Pendientes = { "msg-x": { turno: 1, campos: ["valor", "fecha_fin"], propuestos: { valor: "0", fecha_fin: "2027-08-31" } } };
  const decidir = (mensaje: string, contrato: object) =>
    decidirConfirmacion(pendientes, 2, mensaje, "contratos_registrar", { mensaje_id: "msg-x", confirmado: true, contrato }).tipo;
  assert.equal(decidir("confirmo el valor $1.500.000 y fin 31/08/2028", { valor: 1_500_000, fecha_fin: "2028-08-31" }), "ejecutar");
  assert.equal(decidir("confirmo el valor 1.500.000", { valor: 2_500_000 }), "bloquear");
  assert.equal(decidir("confirmo", { valor: 0, fecha_fin: "2027-08-31" }), "ejecutar");
});

test("CA5: si el proveedor cae tras registrar, el registro y su resultado quedan en el historial y no hay pendiente falso", async () => {
  const p = preparar([rh([VALIDAR_006]), rt("¿Confirmas?"), rh([registrar006()]), new ErrorLlm("caído"), rt("ok")]);
  await p.motor.turno(SESION, "procesa msg-006");
  const t2 = await p.motor.turno(SESION, CONFIRMACION_PRD);
  assert.match(t2.reply, /caído/);
  assert.equal(t2.needsConfirmation, false);
  assert.deepEqual(t2.pendientes, []);
  assert.match(maestro(p.ctx), /CM-2026-03/);
  await p.motor.turno(SESION, "¿qué pasó?");
  const enviado = p.adaptador.envios.at(-1)?.mensajes ?? [];
  const resultados = enviado.filter((m): m is Extract<Mensaje, { rol: "resultados" }> => m.rol === "resultados");
  assert.ok(resultados.some((m) => m.resultados.some((r) => r.id === "r1" && !r.esError)), "el modelo ve que ya registró");
  assert.equal(enviado.filter((m) => m.rol === "usuario").length, 3, "sin mensajes de usuario sueltos ni duplicados");
});

test("CA5: si falla a mitad de las llamadas, las que no tienen resultado reciben «llamada interrumpida»", async () => {
  const p = preparar([rh([VALIDAR_006, { id: "v2", nombre: "contratos_validar", argumentos: { mensaje_id: "msg-001" } }]), rt("ok")]);
  // Un emisor que falla (p. ej. el stream del front se cayó) al anunciar la segunda llamada: la primera ya se ejecutó.
  let anuncios = 0;
  const r = await p.motor.turno(SESION, "valida", (e) => {
    if (e.tipo === "herramienta" && ++anuncios === 2) throw new Error("stream cerrado");
  });
  assert.match(r.reply, /No pude completar/);
  assert.deepEqual(r.toolCalls.map((c) => c.id), ["v1"]);
  await p.motor.turno(SESION, "sigue");
  const enviado = p.adaptador.envios.at(-1)?.mensajes ?? [];
  const resultados = enviado.find((m) => m.rol === "resultados");
  assert.ok(resultados?.rol === "resultados");
  assert.deepEqual(resultados.resultados.map((x) => x.id), ["v1", "v2"]);
});

test("CA5: una respuesta vacía del modelo no se guarda y el reply nunca sale vacío", async () => {
  const vacia: Respuesta = { texto: "", llamadas: [], uso: { entrada: 0, salida: 0, cacheLeida: 0 }, fin: "fin", crudo: [] };
  const p = preparar([rh([{ id: "e", nombre: "contratos_leer_buzon", argumentos: {} }]), vacia, rt("sigo")]);
  const r = await p.motor.turno(SESION, "lee el buzón");
  assert.equal(r.reply, "El modelo no devolvió texto; pídeme que continúe.");
  await p.motor.turno(SESION, "continúa");
  const enviado = p.adaptador.envios.at(-1)?.mensajes ?? [];
  assert.ok(enviado.every((m) => m.rol !== "asistente" || m.texto !== "" || m.llamadas.length > 0));
});

/** Servidor local que imita la Messages API y guarda los cuerpos recibidos. */
async function servidorFalso(): Promise<{ url: string; cuerpos: { messages: { role: string; content: unknown }[] }[]; cerrar: () => void }> {
  const cuerpos: { messages: { role: string; content: unknown }[] }[] = [];
  const srv = http.createServer((req, res) => {
    let datos = "";
    req.on("data", (c: Buffer) => (datos += c.toString()));
    req.on("end", () => {
      cuerpos.push(JSON.parse(datos));
      const usage = { input_tokens: 1, output_tokens: 1 };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "m", type: "message", role: "assistant", model: "x", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", stop_sequence: null, usage }));
    });
  });
  await new Promise<void>((listo) => srv.listen(0, "127.0.0.1", () => listo()));
  const direccion = srv.address();
  const puerto = typeof direccion === "object" && direccion ? direccion.port : 0;
  return { url: `http://127.0.0.1:${puerto}`, cuerpos, cerrar: () => srv.close() };
}

test("anthropic: un crudo vacío no se reenvía como asistente sin contenido (evita el 400)", async () => {
  const srv = await servidorFalso();
  const previa = process.env.ANTHROPIC_BASE_URL;
  process.env.ANTHROPIC_BASE_URL = srv.url;
  try {
    const adaptador = new AdaptadorAnthropic({ ANTHROPIC_API_KEY: "clave-de-prueba" });
    const historial: Mensaje[] = [{ rol: "usuario", texto: "a" }, { rol: "asistente", texto: "", llamadas: [], crudo: [] }, { rol: "usuario", texto: "b" }];
    await adaptador.enviar("s", historial, []);
    const asistente = srv.cuerpos[0].messages[1];
    assert.equal(asistente.role, "assistant");
    assert.ok(Array.isArray(asistente.content) && asistente.content.length > 0);
  } finally {
    if (previa === undefined) delete process.env.ANTHROPIC_BASE_URL;
    else process.env.ANTHROPIC_BASE_URL = previa;
    srv.cerrar();
  }
});

test("anthropic sin ANTHROPIC_API_KEY: error claro sin llamar al proveedor", async () => {
  await assert.rejects(new AdaptadorAnthropic({}).enviar("s", [{ rol: "usuario", texto: "x" }], []), (e: unknown) => e instanceof ErrorLlm && e.message === SIN_CLAVE);
  const p = preparar([], { adaptador: new AdaptadorAnthropic({}) });
  assert.match((await p.motor.turno(SESION, "hola")).reply, /Falta ANTHROPIC_API_KEY en el backend/);
});

test("tope global de tokens: una sesión nueva no lo reinicia y persiste en out/uso.json (PRD §8 Costo)", async () => {
  const uso = { entrada: 80, salida: 30, cacheLeida: 0 };
  const p = preparar([rt("primera", uso), rt("no debería")], { topes: { tokensGlobal: 100 } });
  await p.motor.turno("sesion-g1", "hola");
  const r = await p.motor.turno("sesion-g2", "otra sesión");
  assert.equal(p.adaptador.envios.length, 1);
  assert.match(r.reply, /tope global de 100 tokens/);
  const guardado = JSON.parse(fs.readFileSync(path.join(p.ctx.directory, "out", "uso.json"), "utf8")) as { tokens: number };
  assert.equal(guardado.tokens, 110);
  const otro = crearMotor({ adaptador: new AdaptadorSimulado([rt("x")]), directorio: p.ctx.directory, sistema: "s", topes: { tokensGlobal: 100 } });
  assert.match((await otro.turno("sesion-g3", "hola")).reply, /tope global/);
});

test("CA5: un archivo de sesión corrupto se aparta como .corrupto y se abre una sesión nueva", async () => {
  const p = preparar([rt("nueva")]);
  const carpeta = path.join(p.ctx.directory, "out", "sesiones");
  fs.mkdirSync(carpeta, { recursive: true });
  fs.writeFileSync(path.join(carpeta, `${SESION}.json`), "{corrupto");
  assert.equal(p.motor.sesion(SESION), null);
  assert.ok(fs.existsSync(path.join(carpeta, `${SESION}.json.corrupto`)));
  assert.equal((await p.motor.turno(SESION, "hola")).reply, "nueva");
});
