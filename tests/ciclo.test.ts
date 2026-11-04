import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { proyectoTemporal } from "./ayudas.ts";
import { catalogo, fallo, ok, type Contexto, type Herramienta } from "../src/tools/nucleo.ts";
import * as contratos from "../src/tools/contratos.ts";
import { crearAdaptador, type Mensaje } from "../src/llm/adapter.ts";
import { AdaptadorAnthropic, traducir } from "../src/llm/anthropic.ts";
import { ErrorLlm } from "../src/llm/errores.ts";
import { AdaptadorSimulado, respuestaHerramientas, respuestaTexto, type Guion } from "../src/llm/simulado.ts";
import { MENSAJE_BLOQUEO } from "../src/agent/confirmacion.ts";
import { crearMotor, type OpcionesMotor } from "../src/agent/motor.ts";
import type { EventoAgente } from "../src/agent/tipos.ts";

const SESION = "sesion-prueba";
// Claves falsas armadas por partes: un barrido de secretos sobre tests/ no encuentra el literal.
const PREFIJO = "sk-" + "ant-";
const CON_CLAVE = new RegExp(PREFIJO);

/** Herramientas falsas con los nombres reales: validar siempre pide revisión y registrar cuenta sus ejecuciones. */
function catalogoFalso() {
  const ejecuciones = { registrar: 0 };
  const mensaje_id = z.string().describe("Id del mensaje");
  const validar: Herramienta<{ mensaje_id: typeof mensaje_id }> = {
    description: "Valida un contrato.",
    args: { mensaje_id },
    execute: async () => ok({ clasificacion: "nuevo", requiere_revision: ["valor", "fecha_fin"], resumen: "nuevo; revisión: valor, fecha_fin" }),
  };
  const confirmado = z.boolean().optional().describe("Confirmación de la analista");
  const registrar: Herramienta<{ mensaje_id: typeof mensaje_id; confirmado: typeof confirmado }> = {
    description: "Registra un contrato.",
    args: { mensaje_id, confirmado },
    execute: async (args) => {
      if (!args.confirmado) return fallo("requiere revisión: valor, fecha_fin");
      ejecuciones.registrar++;
      return ok({ id_contrato: "CM-2026-03", accion: "insertado", resumen: "CM-2026-03 insertado" });
    },
  };
  const eco: Herramienta<{}> = { description: "Eco.", args: {}, execute: async () => ok({ resumen: "eco" }) };
  return { herramientas: catalogo("contratos", { validar, registrar, eco }), ejecuciones };
}

function preparar(guion: Guion, extra: OpcionesMotor = {}) {
  const ctx = proyectoTemporal();
  const adaptador = new AdaptadorSimulado(guion);
  const motor = crearMotor({ adaptador, directorio: ctx.directory, sistema: "sistema de prueba", ...extra });
  return { ctx, adaptador, motor };
}

const leerLog = (ctx: Contexto) =>
  fs.readFileSync(path.join(ctx.directory, "out", "log.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));

/** Invariante CA5: todo mensaje del asistente con llamadas va seguido de sus resultados, con los mismos ids. */
function sinLlamadasColgadas(mensajes: Mensaje[]): void {
  mensajes.forEach((m, i) => {
    if (m.rol !== "asistente" || m.llamadas.length === 0) return;
    const siguiente = mensajes[i + 1];
    assert.equal(siguiente?.rol, "resultados", `llamada colgada en la posición ${i}`);
    if (siguiente?.rol === "resultados") assert.deepEqual(siguiente.resultados.map((r) => r.id), m.llamadas.map((l) => l.id));
  });
}

test("flujo normal: dos herramientas reales en una respuesta vuelven en un solo mensaje de resultados (PRD §6.3, CA4)", async () => {
  const eventos: EventoAgente[] = [];
  const { ctx, adaptador, motor } = preparar([
    respuestaHerramientas(
      [
        { id: "t1", nombre: "contratos_leer_buzon", argumentos: {} },
        { id: "t2", nombre: "contratos_extraer", argumentos: { mensaje_id: "msg-001" } },
      ],
      { entrada: 1000, salida: 100, cacheLeida: 0 },
    ),
    respuestaTexto("Listo: el buzón tiene mensajes y msg-001 se extrajo."),
  ]);
  const r = await motor.turno(SESION, "procesa el buzón", (e) => eventos.push(e));

  assert.equal(r.reply, "Listo: el buzón tiene mensajes y msg-001 se extrajo.");
  assert.deepEqual(r.toolCalls.map((c) => c.nombre), ["contratos_leer_buzon", "contratos_extraer"]);
  assert.equal(r.toolCalls[0].ok, true);
  assert.equal(r.needsConfirmation, false);
  const segundo = adaptador.envios[1].mensajes;
  const ultimo = segundo[segundo.length - 1];
  assert.equal(ultimo.rol, "resultados");
  if (ultimo.rol === "resultados") assert.deepEqual(ultimo.resultados.map((x) => x.id), ["t1", "t2"]);
  assert.equal(segundo.filter((m) => m.rol === "resultados").length, 1);
  assert.deepEqual(leerLog(ctx).map((l) => l.herramienta), ["contratos_leer_buzon", "contratos_extraer"]);
  const definicion = adaptador.envios[0].herramientas.find((h) => h.nombre === "contratos_extraer");
  assert.equal(definicion?.esquema.type, "object");
  assert.equal("$schema" in (definicion?.esquema ?? {}), false);
  assert.ok(eventos.some((e) => e.tipo === "uso" && e.costoUsd === 0));
  assert.deepEqual(eventos.filter((e) => e.tipo === "herramienta").length, 2);
  assert.equal(catalogo("contratos", contratos).length, adaptador.envios[0].herramientas.length);
});

test("CA3: confirmar en el mismo turno en que validar pidió revisión se bloquea; en el turno siguiente se ejecuta", async () => {
  const { herramientas, ejecuciones } = catalogoFalso();
  const confirmar = { id: "r1", nombre: "contratos_registrar", argumentos: { mensaje_id: "msg-006", confirmado: true } };
  const { ctx, motor } = preparar(
    [
      respuestaHerramientas([{ id: "v1", nombre: "contratos_validar", argumentos: { mensaje_id: "msg-006" } }]),
      respuestaHerramientas([confirmar]),
      respuestaTexto("msg-006 requiere revisión de valor y fecha_fin. ¿Confirmas?"),
      respuestaHerramientas([{ id: "v2", nombre: "contratos_validar", argumentos: { mensaje_id: "msg-006" } }]),
      respuestaHerramientas([{ ...confirmar, id: "r2" }]),
      respuestaTexto("msg-006 quedó registrado."),
    ],
    { herramientas },
  );

  const primero = await motor.turno(SESION, "registra lo limpio");
  assert.equal(ejecuciones.registrar, 0, "no debe ejecutarse en el mismo turno");
  assert.equal(primero.toolCalls[1].ok, false);
  assert.equal(primero.toolCalls[1].resumen, MENSAJE_BLOQUEO.slice(0, 200));
  assert.equal(primero.needsConfirmation, true);
  assert.deepEqual(primero.pendientes, ["msg-006"]);
  const bloqueo = leerLog(ctx).find((l) => l.herramienta === "contratos_registrar");
  assert.deepEqual(Object.keys(bloqueo), ["ts", "herramienta", "mensaje_id", "ok", "resumen"]);
  assert.equal(bloqueo.mensaje_id, "msg-006");
  assert.equal(bloqueo.ok, false);

  // Volver a validar en el turno de la confirmación no reinicia el pendiente.
  const segundo = await motor.turno(SESION, "confirmo el valor 0 y la fecha fin 2027-08-31");
  assert.equal(ejecuciones.registrar, 1);
  assert.equal(segundo.toolCalls[1].ok, true);
  assert.equal(segundo.needsConfirmation, false);
  assert.deepEqual(segundo.pendientes, []);
});

test("CA3: confirmado:true sobre un mensaje sin pendiente se ejecuta SIN confirmado y registrar decide", async () => {
  const { herramientas, ejecuciones } = catalogoFalso();
  const { ctx, motor } = preparar(
    [
      respuestaHerramientas([{ id: "r1", nombre: "contratos_registrar", argumentos: { mensaje_id: "msg-001", confirmado: true } }]),
      respuestaTexto("listo"),
    ],
    { herramientas },
  );
  const r = await motor.turno(SESION, "registra msg-001");
  assert.equal(ejecuciones.registrar, 0, "el falso registrar sin confirmado pide revisión");
  assert.equal(r.toolCalls[0].ok, false);
  assert.match(r.toolCalls[0].resumen, /^requiere revisión/);
  assert.notEqual(r.toolCalls[0].resumen, MENSAJE_BLOQUEO.slice(0, 200));
  assert.deepEqual(r.pendientes, ["msg-001"], "el rechazo de registrar crea el pendiente para el turno siguiente");
  assert.equal(leerLog(ctx)[0].herramienta, "contratos_registrar");
});

test("CA1: al llegar al tope de iteraciones hay una última llamada sin herramientas que resume", async () => {
  const { herramientas } = catalogoFalso();
  let n = 0;
  const { adaptador, motor } = preparar(
    (_mensajes, opciones) =>
      opciones.sinHerramientas
        ? respuestaTexto("Hice 3 pasos; falta registrar.")
        : respuestaHerramientas([{ id: `e${++n}`, nombre: "contratos_eco", argumentos: {} }]),
    { herramientas, topes: { iteraciones: 3 } },
  );
  const r = await motor.turno(SESION, "trabaja sin parar");
  assert.equal(adaptador.envios.length, 4);
  assert.deepEqual(adaptador.envios.map((e) => e.opciones.sinHerramientas === true), [false, false, false, true]);
  assert.equal(r.reply, "Hice 3 pasos; falta registrar.");
  assert.equal(r.toolCalls.length, 3);
  sinLlamadasColgadas(adaptador.envios[3].mensajes);
});

test("CA5: si el proveedor falla a mitad de turno, se conservan las parejas ya ejecutadas y la sesión sigue", async () => {
  const { herramientas } = catalogoFalso();
  const eventos: EventoAgente[] = [];
  const { adaptador, motor } = preparar(
    [
      respuestaHerramientas([{ id: "e1", nombre: "contratos_eco", argumentos: {} }]),
      new ErrorLlm("El proveedor del modelo no respondió a tiempo (tiempo de espera agotado)."),
      respuestaTexto("Hola de nuevo."),
    ],
    { herramientas },
  );
  const caido = await motor.turno(SESION, "procesa el buzón", (e) => eventos.push(e));
  assert.match(caido.reply, /tiempo de espera agotado/);
  assert.match(caido.reply, /sesión sigue activa/);
  assert.ok(eventos.some((e) => e.tipo === "error"));

  const despues = await motor.turno(SESION, "¿sigues ahí?");
  assert.equal(despues.reply, "Hola de nuevo.");
  const enviado = adaptador.envios[2].mensajes;
  assert.deepEqual(enviado.map((m) => m.rol), ["usuario", "asistente", "resultados", "usuario"]);
  assert.deepEqual(enviado.at(-1), { rol: "usuario", texto: "¿sigues ahí?" });
  sinLlamadasColgadas(enviado);
  assert.equal(motor.sesion(SESION)?.turnos.length, 2);
});

test("tope de tokens por sesión: superado, responde claro sin llamar al modelo (PRD §8 Costo)", async () => {
  const { adaptador, motor } = preparar([respuestaTexto("primera", { entrada: 80, salida: 30, cacheLeida: 500 })], {
    topes: { tokensSesion: 100 },
  });
  await motor.turno(SESION, "hola");
  const r = await motor.turno(SESION, "otra vez");
  assert.equal(adaptador.envios.length, 1);
  assert.match(r.reply, /tope de 100 tokens/);
  assert.equal(motor.sesion(SESION)?.tokens, 110);
});

test("una clave del proveedor en un error nunca llega a la respuesta ni a los eventos (PRD §8 Seguridad)", async () => {
  const eventos: EventoAgente[] = [];
  const { motor } = preparar([new Error(`falló con la clave ${PREFIJO}api03-abcDEF_123-xyz`)]);
  const r = await motor.turno(SESION, "hola", (e) => eventos.push(e));
  assert.doesNotMatch(r.reply, CON_CLAVE);
  assert.match(r.reply, /\[clave oculta\]/);
  assert.doesNotMatch(JSON.stringify(eventos), CON_CLAVE);
  const traducido = traducir(Anthropic.APIError.generate(400, { error: { message: `mal ${PREFIJO}xxx` } }, `mal ${PREFIJO}xxx`, new Headers()));
  assert.doesNotMatch(traducido.message, CON_CLAVE);
  assert.match(traducir(new Anthropic.APIConnectionTimeoutError()).message, /tiempo de espera agotado/);
  assert.match(traducir(Anthropic.APIError.generate(429, {}, "límite", new Headers())).message, /límite de uso/);
  assert.match(traducir(Anthropic.APIError.generate(401, {}, "x", new Headers())).message, /credencial/);
  assert.doesNotMatch(JSON.stringify(new AdaptadorAnthropic({ ANTHROPIC_API_KEY: `${PREFIJO}falsa-123` })), CON_CLAVE);
});

test("persistencia: un motor nuevo recarga la sesión desde out/sesiones y continúa con su historial", async () => {
  const { ctx, motor } = preparar([respuestaTexto("primera respuesta")]);
  await motor.turno(SESION, "hola");
  assert.ok(fs.existsSync(path.join(ctx.directory, "out", "sesiones", `${SESION}.json`)));

  const adaptador = new AdaptadorSimulado([respuestaTexto("segunda respuesta")]);
  const otro = crearMotor({ adaptador, directorio: ctx.directory, sistema: "s" });
  assert.equal(otro.sesion(SESION)?.turnos[0].reply, "primera respuesta");
  await otro.turno(SESION, "sigo");
  assert.deepEqual(adaptador.envios[0].mensajes.map((m) => m.rol), ["usuario", "asistente", "usuario"]);
  otro.reiniciar();
  assert.equal(otro.sesion(SESION)?.turnos.length, 2, "tras reiniciar la memoria, se recarga del disco");
});

test("sessionId inválido: error claro, sin sesión ni archivo", async () => {
  const { ctx, motor } = preparar([]);
  const r = await motor.turno("../x", "hola");
  assert.match(r.reply, /sessionId inválido/);
  assert.equal(motor.sesion("../x"), null);
  assert.equal(fs.existsSync(path.join(ctx.directory, "out", "sesiones")), false);
});

test("la fábrica elige el adaptador por LLM_PROVEEDOR; el simulado sin guion explica que no hay modelo", async () => {
  const simulado = crearAdaptador({ LLM_PROVEEDOR: "simulado" });
  assert.equal(simulado.proveedor, "simulado");
  assert.match((await simulado.enviar("", [], [])).texto, /No hay un modelo/);
  assert.equal(crearAdaptador({ LLM_MODELO: "claude-sonnet-5-5" }).modelo, "claude-sonnet-5-5");
  assert.throws(() => crearAdaptador({ LLM_PROVEEDOR: "otro" }), /LLM_PROVEEDOR desconocido/);
});
