import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { generarAlertas } from "../src/tools/alertas.ts";
import { escribirMaestro, leerMaestro, rutas } from "../src/tools/almacen.ts";
import { proyectoTemporal } from "./ayudas.ts";

const HOY = "2026-09-03";

test("HU-5: vencen = CT-2026-009 (27 días) y CT-2026-004 (42 días), en ese orden; CT-2026-012 (72) no", () => {
  const r = generarAlertas(proyectoTemporal(), HOY);
  assert.deepEqual(r.vencen.map((c) => [c.id_contrato, c.dias_restantes]), [["CT-2026-009", 27], ["CT-2026-004", 42]]);
  assert.ok(!r.vencen.some((c) => c.id_contrato === "CT-2026-012"));
  assert.equal(r.vencen[0].comercial, "Carlos Ruiz Medina");
});

test("HU-5 / S14: los ya vencidos van en `vencidos`, no en `vencen`", () => {
  const r = generarAlertas(proyectoTemporal(), HOY);
  assert.deepEqual(r.vencidos.map((c) => [c.id_contrato, c.dias_restantes]), [["CT-2026-002", -56], ["CT-2025-018", -65]]);
});

test("HU-5: pólizas pendientes incluye CT-2026-004 y no CT-2025-018 (vigente)", () => {
  const ids = generarAlertas(proyectoTemporal(), HOY).polizas_pendientes.map((c) => c.id_contrato);
  assert.ok(ids.includes("CT-2026-004"));
  assert.ok(!ids.includes("CT-2025-018"));
});

test("HU-5: registrados desde el corte vacío con el fixture y con filas nuevas aparecen", () => {
  const ctx = proyectoTemporal();
  assert.deepEqual(generarAlertas(ctx, HOY).registrados_desde_corte, []);
  const filas = leerMaestro(ctx);
  escribirMaestro(ctx, [...filas, { ...filas[0], id_contrato: "CT-2026-015", fecha_registro: "2026-08-04", fuente: "buzon" }]);
  const r = generarAlertas(ctx, HOY);
  assert.deepEqual(r.registrados_desde_corte.map((c) => [c.id_contrato, c.fuente]), [["CT-2026-015", "buzon"]]);
});

test("HU-5: alertas.md tiene exactamente tres secciones y la fecha de referencia", () => {
  const ctx = proyectoTemporal();
  const r = generarAlertas(ctx, HOY);
  assert.equal(r.ruta, "out/alertas.md");
  const md = fs.readFileSync(rutas(ctx).alertas, "utf8");
  assert.equal(md.split("\n").filter((l) => l.startsWith("## ")).length, 3);
  assert.match(md, /### Vencidos sin renovación registrada/);
  assert.match(md, /2026-09-03/);
  assert.match(md, /CT-2026-009/);
});

test("HU-5: determinista, dos llamadas con el mismo hoy dan el mismo archivo", () => {
  const ctx = proyectoTemporal();
  generarAlertas(ctx, HOY);
  const a = fs.readFileSync(rutas(ctx).alertas, "utf8");
  generarAlertas(ctx, HOY);
  assert.equal(fs.readFileSync(rutas(ctx).alertas, "utf8"), a);
});

test("HU-5 / HU-6: hoy inválido da un error legible", () => {
  const ctx = proyectoTemporal();
  assert.throws(() => generarAlertas(ctx, "2026-02-31"), /no existe en el calendario/);
  assert.throws(() => generarAlertas(ctx, "3/9/2026"), /YYYY-MM-DD/);
});

test("RN6: lee la copia de out/, no el fixture", () => {
  const ctx = proyectoTemporal();
  generarAlertas(ctx, HOY);
  assert.ok(fs.existsSync(rutas(ctx).maestro));
});
