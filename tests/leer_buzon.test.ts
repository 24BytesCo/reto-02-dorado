import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { extraer, leer_buzon, registrar, validar } from "../src/tools/contratos.ts";
import { esBinario, leerMaestro, leerProcesados, marcarProcesado, rutas } from "../src/tools/almacen.ts";
import type { Contexto } from "../src/tools/nucleo.ts";
import { tipoDocumento } from "../src/tools/extraccion.ts";
import { proyectoTemporal } from "./ayudas.ts";

interface Mensaje { id: string; tiene_contrato: boolean; clasificacion?: string; motivo?: string; pendiente?: boolean; advertencia?: string; de: string; asunto: string; fecha: string; adjuntos: string[] }
const leer = async (ctx = proyectoTemporal()): Promise<Mensaje[]> => JSON.parse(await leer_buzon.execute({}, ctx)).data.mensajes;

test("HU-1: lista los 6 mensajes con { id, de, asunto, fecha, adjuntos, tiene_contrato }", async () => {
  const mensajes = await leer();
  assert.deepEqual(mensajes.map((m) => m.id), ["msg-001", "msg-002", "msg-003", "msg-004", "msg-005", "msg-006"]);
  for (const k of ["id", "de", "asunto", "fecha", "adjuntos", "tiene_contrato"]) assert.ok(k in mensajes[0], k);
});

test("HU-1: la cotización (msg-005) sale sin contrato, rechazada y con motivo", async () => {
  const m = (await leer()).find((x) => x.id === "msg-005")!;
  assert.equal(m.tiene_contrato, false);
  assert.equal(m.clasificacion, "rechazado");
  assert.match(m.motivo!, /cotización/);
});

test("el otrosí (msg-003) cuenta como documento contractual aunque el adjunto no se llame contrato.txt", async () => {
  const m = (await leer()).find((x) => x.id === "msg-003")!;
  assert.equal(m.tiene_contrato, true);
});

test("se reconoce «OTROSÍ» con tilde: \\b de JavaScript no sirve tras letras acentuadas", () => {
  assert.equal(tipoDocumento("OTROSÍ No. 1 AL CONTRATO\n\nEntre A y B"), "otrosi");
  assert.equal(tipoDocumento("COTIZACIÓN No. 1\nCliente: X"), null);
});

test("HU-1: un mensaje ya procesado no vuelve a aparecer", async () => {
  const ctx = proyectoTemporal();
  marcarProcesado(ctx, "msg-004", "duplicado", "CT-2026-012");
  assert.ok(!(await leer(ctx)).some((m) => m.id === "msg-004"));
});

// ── C4: adjuntos binarios y varios contratos en un correo ──

/** Crea msg-007 copiando el correo de msg-001 con los adjuntos dados (nombre → contenido). */
function correoCon(ctx: Contexto, adjuntos: Record<string, string | Buffer>): void {
  const dir = path.join(rutas(ctx).buzon, "msg-007");
  fs.mkdirSync(dir);
  const correo = JSON.parse(fs.readFileSync(path.join(rutas(ctx).buzon, "msg-001", "correo.json"), "utf8"));
  fs.writeFileSync(path.join(dir, "correo.json"), JSON.stringify({ ...correo, id: "msg-007", adjuntos: Object.keys(adjuntos) }));
  for (const [nombre, contenido] of Object.entries(adjuntos)) fs.writeFileSync(path.join(dir, nombre), contenido);
}
const contratoDe = (msg: string) => fs.readFileSync(path.join(import.meta.dirname, "../fixtures/reto-02/buzon", msg, "contrato.txt"), "utf8");
const json = async (p: Promise<string>) => JSON.parse(await p);

test("esBinario: %PDF y bytes de control son binarios; el texto con tildes, tabuladores y CRLF no", () => {
  const ctx = proyectoTemporal();
  const f = (nombre: string, c: string | Buffer) => { const r = path.join(ctx.directory, nombre); fs.writeFileSync(r, c); return r; };
  assert.equal(esBinario(f("a.pdf", "%PDF-1.7\nEntre las partes")), true);
  assert.equal(esBinario(f("b.docx", Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00]))), true);
  assert.equal(esBinario(f("c.txt", "CONTRATO No. 1\r\n\tEntre ÁÉÍÓÚ ñ")), false);
  assert.equal(esBinario(path.join(ctx.directory, "no-existe.txt")), false);
});

test("C4: un adjunto PDF da «formato no soportado: revisión manual», no es contrato y queda pendiente (no procesado)", async () => {
  const ctx = proyectoTemporal();
  correoCon(ctx, { "contrato.pdf": "%PDF-1.7\nCONTRATO DE PRESTACIÓN DE SERVICIOS\nEntre los suscritos" });
  const m = (await leer(ctx)).find((x) => x.id === "msg-007")!;
  assert.equal(m.tiene_contrato, false);
  assert.equal(m.pendiente, true);
  assert.equal(m.clasificacion, undefined, "no sale como rechazado");
  assert.match(m.motivo!, /formato no soportado: revisión manual/);
  const e = await json(extraer.execute({ mensaje_id: "msg-007" }, ctx));
  assert.match(e.error, /formato no soportado: revisión manual/);
  const r = await json(registrar.execute({ mensaje_id: "msg-007" }, ctx));
  assert.equal(r.data.procesado, false);
  assert.ok(!("msg-007" in leerProcesados(ctx)));
  assert.ok((await leer(ctx)).some((x) => x.id === "msg-007"), "sigue en el buzón");
});

test("C4: dos adjuntos contractuales → validar pide revisión de «adjuntos» con advertencia y registrar exige confirmación", async () => {
  const ctx = proyectoTemporal();
  correoCon(ctx, { "contrato-a.txt": contratoDe("msg-001"), "contrato-b.txt": contratoDe("msg-002") });
  const m = (await leer(ctx)).find((x) => x.id === "msg-007")!;
  assert.equal(m.tiene_contrato, true);
  assert.match(m.advertencia!, /2 adjuntos.*contrato-b\.txt/);
  const v = await json(validar.execute({ mensaje_id: "msg-007" }, ctx));
  assert.ok(v.data.requiere_revision.includes("adjuntos"));
  assert.ok(v.data.advertencias.some((a: string) => /solo se procesó contrato-a\.txt/.test(a)));
  const filas = leerMaestro(ctx).length;
  const sinConfirmar = await json(registrar.execute({ mensaje_id: "msg-007" }, ctx));
  assert.equal(sinConfirmar.ok, false);
  assert.match(sinConfirmar.error, /requiere revisión:.*adjuntos/);
  assert.ok(!("msg-007" in leerProcesados(ctx)));
  assert.equal(leerMaestro(ctx).length, filas);
  const confirmado = await json(registrar.execute({ mensaje_id: "msg-007", confirmado: true }, ctx));
  assert.equal(confirmado.ok, true);
  assert.ok("msg-007" in leerProcesados(ctx));
});

test("C4: un contrato de texto más un PDF también pide revisión de «adjuntos»", async () => {
  const ctx = proyectoTemporal();
  correoCon(ctx, { "contrato.txt": contratoDe("msg-002"), "firmado.pdf": "%PDF-1.4 binario" });
  const v = await json(validar.execute({ mensaje_id: "msg-007" }, ctx));
  assert.ok(v.data.requiere_revision.includes("adjuntos"));
});
