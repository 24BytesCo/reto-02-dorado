import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { extraer, leer_buzon } from "../src/tools/contratos.ts";
import { proyectoTemporal } from "./ayudas.ts";

const BUZON_ORIGINAL = process.env.BUZON_DIR;
after(() => {
  if (BUZON_ORIGINAL === undefined) delete process.env.BUZON_DIR;
  else process.env.BUZON_DIR = BUZON_ORIGINAL;
});

const contratoBase = (ctx: { directory: string }): string =>
  fs.readFileSync(path.join(ctx.directory, "fixtures/reto-02/buzon/msg-001/contrato.txt"), "utf8");

/** Buzón alterno dentro del proyecto temporal con un mensaje malo (a) entre dos buenos (b). */
function buzonConMalos(): ReturnType<typeof proyectoTemporal> {
  const ctx = proyectoTemporal();
  const base = contratoBase(ctx);
  const casos: Record<string, string> = {
    "err-1-vacio": "",
    "err-2-fecha": base.replace("treinta y uno (31) de julio de 2027", "treinta y uno (31) de febrero de 2027"),
    "err-3-moneda": base.replace("(COP $265.000.000)", "(EUR 50.000,00)"),
    "err-4-bueno": base,
  };
  const dir = path.join(ctx.directory, "buzon-errores");
  for (const [id, texto] of Object.entries(casos)) {
    fs.mkdirSync(path.join(dir, id), { recursive: true });
    fs.writeFileSync(path.join(dir, id, "contrato.txt"), texto);
    const correo = { id, de: "lgomez@periferia-ficticia.com", para: "contratos@periferia-ficticia.com", asunto: id, fecha: "2026-09-01T09:00:00-05:00", cuerpo: "adjunto", adjuntos: ["contrato.txt"] };
    fs.writeFileSync(path.join(dir, id, "correo.json"), JSON.stringify(correo));
  }
  process.env.BUZON_DIR = "buzon-errores";
  return ctx;
}

const llamar = async (id: string, ctx: ReturnType<typeof proyectoTemporal>) =>
  JSON.parse(await extraer.execute({ mensaje_id: id }, ctx)) as { ok: boolean; error?: string; data?: unknown };

test("HU-6: contrato vacío da { ok:false, error } legible", async () => {
  const r = await llamar("err-1-vacio", buzonConMalos());
  assert.equal(r.ok, false);
  assert.match(r.error!, /err-1-vacio no trae contrato/);
});

test("HU-6: fecha inexistente (31 de febrero) da error legible", async () => {
  const r = await llamar("err-2-fecha", buzonConMalos());
  assert.equal(r.ok, false);
  assert.match(r.error!, /fecha inválida: 31\/2\/2027/);
});

test("HU-6: moneda desconocida (EUR) da error legible con las monedas aceptadas", async () => {
  const r = await llamar("err-3-moneda", buzonConMalos());
  assert.equal(r.ok, false);
  assert.match(r.error!, /moneda desconocida: EUR/);
  assert.match(r.error!, /COP/);
});

test("HU-6: el contrato bueno del mismo lote se extrae con normalidad", async () => {
  const r = await llamar("err-4-bueno", buzonConMalos());
  assert.equal(r.ok, true);
});

test("HU-6: leer_buzon no falla con los casos malos y lista los cuatro mensajes", async () => {
  const ctx = buzonConMalos();
  const r = JSON.parse(await leer_buzon.execute({}, ctx)) as { ok: boolean; data: { mensajes: { id: string }[] } };
  assert.equal(r.ok, true);
  assert.deepEqual(r.data.mensajes.map((m) => m.id), ["err-1-vacio", "err-2-fecha", "err-3-moneda", "err-4-bueno"]);
});

test("HU-6: un caso malo no impide el siguiente (se extraen todos en secuencia)", async () => {
  const ctx = buzonConMalos();
  const oks: boolean[] = [];
  for (const id of ["err-1-vacio", "err-2-fecha", "err-3-moneda", "err-4-bueno"]) oks.push((await llamar(id, ctx)).ok);
  assert.deepEqual(oks, [false, false, false, true]);
});
