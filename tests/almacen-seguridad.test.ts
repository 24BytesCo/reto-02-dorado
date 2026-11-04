import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { escribirMaestro, leerCorreo, leerMaestro, rutas, serializarCsv, parsearCsv } from "../src/tools/almacen.ts";
import { ejecutarHerramienta, catalogo, ok } from "../src/tools/nucleo.ts";
import { RAIZ, proyectoTemporal } from "./ayudas.ts";

test("escribirMaestro neutraliza fórmulas en columnas de texto libre", () => {
  const ctx = proyectoTemporal();
  const filas = leerMaestro(ctx);
  for (const [i, v] of ["=HYPERLINK(\"x\")", "+1", "-2", "@SUM(A1)", "\tx", "\rx"].entries()) {
    filas[i] = { ...filas[i], cliente: v, objeto: v, tipo_poliza: v, comercial: v };
  }
  escribirMaestro(ctx, filas);
  const releido = leerMaestro(ctx);
  for (let i = 0; i < 6; i++) {
    for (const c of ["cliente", "objeto", "tipo_poliza", "comercial"] as const) assert.ok(releido[i][c].startsWith("'"));
  }
});

test("las columnas que no son de texto libre no se tocan y el fixture hace ida y vuelta idéntico", () => {
  const ctx = proyectoTemporal();
  const original = fs.readFileSync(rutas(ctx).maestroOriginal, "utf8");
  const filas = leerMaestro(ctx);
  filas[0] = { ...filas[0], valor: "-5" };
  escribirMaestro(ctx, filas);
  assert.equal(leerMaestro(ctx)[0].valor, "-5");
  escribirMaestro(ctx, leerMaestro(ctx).map((f, i) => (i === 0 ? { ...f, valor: parsearCsv(original)[1][5] } : f)));
  assert.equal(fs.readFileSync(rutas(ctx).maestro, "utf8"), original);
  assert.equal(serializarCsv(parsearCsv(original)), original);
});

test("leerCorreo con formato inválido da un mensaje legible sin rutas absolutas", () => {
  const ctx = proyectoTemporal();
  const dir = path.join(rutas(ctx).buzon, "msg-001");
  fs.writeFileSync(path.join(dir, "correo.json"), JSON.stringify({ id: 1 }));
  assert.throws(() => leerCorreo(ctx, "msg-001"), (e: Error) => /formato esperado/.test(e.message) && !e.message.includes(ctx.directory));
});

test("leerCorreo acepta correos sin para ni cuerpo", () => {
  const ctx = proyectoTemporal();
  const dir = path.join(rutas(ctx).buzon, "msg-001");
  fs.writeFileSync(path.join(dir, "correo.json"), JSON.stringify({ id: "msg-001", de: "a@b.co", asunto: "x", fecha: "2026-01-01", adjuntos: [] }));
  assert.equal(leerCorreo(ctx, "msg-001").asunto, "x");
});

test("un fallo al escribir el log no tumba la herramienta", async () => {
  const ctx = proyectoTemporal();
  fs.writeFileSync(path.join(ctx.directory, "out"), "archivo, no carpeta");
  const [reg] = catalogo("t", { prueba: { description: "d", args: {}, execute: async () => ok({ resumen: "bien" }) } });
  const original = console.error;
  console.error = () => {};
  try {
    const r = JSON.parse(await ejecutarHerramienta(reg, {}, ctx));
    assert.equal(r.ok, true);
  } finally {
    console.error = original;
  }
});

test("el .env.example documenta los esfuerzos y el tope global", () => {
  const t = fs.readFileSync(path.join(RAIZ, ".env.example"), "utf8");
  assert.match(t, /low \| medium \| high \| xhigh \| max/);
  assert.match(t, /^MAX_TOKENS_GLOBAL=3000000$/m);
});
