import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { registrar } from "../src/tools/contratos.ts";
import { leerMaestro, leerProcesados, rutas } from "../src/tools/almacen.ts";
import type { Contexto } from "../src/tools/nucleo.ts";
import { proyectoTemporal } from "./ayudas.ts";

type Corregido = Parameters<typeof registrar.execute>[0]["contrato"];
const registrarEn = async (ctx: Contexto, id: string, contrato: Corregido = {}, confirmado?: boolean) =>
  JSON.parse(await registrar.execute({ mensaje_id: id, contrato, confirmado }, ctx));
const historial = (ctx: Contexto) =>
  fs.existsSync(rutas(ctx).historial) ? fs.readFileSync(rutas(ctx).historial, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
const archivado = (ctx: Contexto, relativa: string) => fs.existsSync(path.join(rutas(ctx).sharepoint, relativa));
const fila = (ctx: Contexto, id: string) => leerMaestro(ctx).find((f) => f.id_contrato === id);

test("msg-001 (HU-4): inserta la fila con la ruta, archiva el contrato, anota el historial y marca procesado", async () => {
  const ctx = proyectoTemporal();
  const r = await registrarEn(ctx, "msg-001");
  const ruta = "Contratos/2026/industrias-delta/CT-2026-015.txt";
  assert.deepEqual({ ...r.data, resumen: undefined }, { id_contrato: "CT-2026-015", accion: "nuevo", ruta_archivo: ruta, resumen: undefined });
  assert.equal(fila(ctx, "CT-2026-015")?.ruta_sharepoint, ruta);
  assert.equal(fila(ctx, "CT-2026-015")?.estado_poliza, "pendiente");
  assert.ok(archivado(ctx, ruta));
  const [h] = historial(ctx);
  assert.deepEqual(Object.keys(h), ["ts", "id_contrato", "accion", "cambios", "mensaje_id"]);
  assert.equal(h.cambios.valor, "265000000");
  assert.equal(leerProcesados(ctx)["msg-001"].accion, "nuevo");
});

test("msg-002: sin póliza queda no_aplica en su carpeta de cliente", async () => {
  const ctx = proyectoTemporal();
  const r = await registrarEn(ctx, "msg-002");
  assert.equal(r.data.ruta_archivo, "Contratos/2026/corporacion-andina-de-servicios/CT-2026-016.txt");
  assert.equal(fila(ctx, "CT-2026-016")?.estado_poliza, "no_aplica");
});

test("msg-003 (RN2): modifica la fila existente sin agregar otra, conserva su ruta y archiva el otrosí aparte", async () => {
  const ctx = proyectoTemporal();
  const r = await registrarEn(ctx, "msg-003");
  const ruta = "Contratos/2026/minera-los-andes/CT-2026-011-otrosi-1.txt";
  assert.equal(r.data.accion, "actualizacion");
  assert.equal(r.data.ruta_archivo, ruta);
  assert.equal(leerMaestro(ctx).length, 8);
  const f = fila(ctx, "CT-2026-011");
  assert.deepEqual([f?.valor, f?.fecha_fin, f?.estado_poliza], ["520000", "2027-11-01", "pendiente"]);
  assert.equal(f?.ruta_sharepoint, "Contratos/2026/minera-los-andes/CT-2026-011.pdf");
  assert.ok(archivado(ctx, ruta));
  const [h] = historial(ctx);
  assert.equal(h.accion, "actualizacion");
  assert.deepEqual(h.cambios.valor, { antes: "350000", despues: "520000" });
});

test("reaplicar un otrosí ya aplicado es duplicado y no escribe", async () => {
  const ctx = proyectoTemporal();
  await registrarEn(ctx, "msg-003");
  const r = await registrarEn(ctx, "msg-003");
  assert.equal(r.data.accion, "duplicado");
  assert.equal(historial(ctx).length, 1);
});

test("msg-004 (RN1): duplicado sin tocar maestro, historial ni archivo; sí queda procesado", async () => {
  const ctx = proyectoTemporal();
  leerMaestro(ctx);
  const antes = fs.readFileSync(rutas(ctx).maestro, "utf8");
  const r = await registrarEn(ctx, "msg-004");
  assert.deepEqual([r.data.accion, r.data.ruta_archivo, r.data.id_contrato], ["duplicado", null, "CT-2026-012"]);
  assert.equal(fs.readFileSync(rutas(ctx).maestro, "utf8"), antes);
  assert.equal(historial(ctx).length, 0);
  assert.ok(!fs.existsSync(path.join(rutas(ctx).sharepoint, "Contratos")));
  assert.equal(leerProcesados(ctx)["msg-004"].accion, "duplicado");
});

test("msg-005 (RN4): rechazado con motivo, solo queda procesado", async () => {
  const ctx = proyectoTemporal();
  const r = await registrarEn(ctx, "msg-005");
  assert.deepEqual([r.data.accion, r.data.ruta_archivo], ["rechazado", null]);
  assert.match(r.data.motivo, /cotización/);
  assert.equal(historial(ctx).length, 0);
  assert.equal(leerProcesados(ctx)["msg-005"].accion, "rechazado");
});

test("msg-006 (RN5): sin confirmar responde exactamente «requiere revisión: valor, fecha_fin» y no escribe", async () => {
  const ctx = proyectoTemporal();
  const r = await registrarEn(ctx, "msg-006");
  assert.deepEqual(r, { ok: false, error: "requiere revisión: valor, fecha_fin" });
  assert.equal(leerMaestro(ctx).length, 8);
  assert.ok(!("msg-006" in leerProcesados(ctx)));
});

test("msg-006 confirmado: queda registrado con los valores confirmados y el historial guarda propuesto y confirmado", async () => {
  const ctx = proyectoTemporal();
  const r = await registrarEn(ctx, "msg-006", { valor: 0, fecha_fin: "2027-08-31" }, true);
  assert.equal(r.data.ruta_archivo, "Contratos/2026/distribuidora-caribe/CM-2026-03.txt");
  const f = fila(ctx, "CM-2026-03");
  assert.deepEqual([f?.valor, f?.fecha_fin, f?.comercial], ["0", "2027-08-31", ""]);
  assert.deepEqual(historial(ctx)[0].cambios.confirmados, {
    valor: { propuesto: "0", confirmado: "0" },
    fecha_fin: { propuesto: "2027-08-31", confirmado: "2027-08-31" },
  });
});

test("CA2: un valor que no salió de la herramienta no entra sin confirmación", async () => {
  const ctx = proyectoTemporal();
  assert.deepEqual(await registrarEn(ctx, "msg-001", { valor: 999 }), { ok: false, error: "requiere revisión: valor" });
  assert.equal(fila(ctx, "CT-2026-015"), undefined);
  await registrarEn(ctx, "msg-001", { valor: 999 }, true);
  assert.deepEqual(historial(ctx)[0].cambios.confirmados, { valor: { propuesto: "265000000", confirmado: "999" } });
});

test("idempotencia (O2): registrar dos veces msg-001 no duplica la fila; la segunda vez es duplicado", async () => {
  const ctx = proyectoTemporal();
  await registrarEn(ctx, "msg-001");
  const r = await registrarEn(ctx, "msg-001");
  assert.equal(r.data.accion, "duplicado");
  assert.equal(leerMaestro(ctx).filter((f) => f.id_contrato === "CT-2026-015").length, 1);
  assert.equal(historial(ctx).length, 1);
});

test("HU-6: una moneda inválida en lo corregido devuelve { ok: false } y no escribe", async () => {
  const ctx = proyectoTemporal();
  const r = await registrarEn(ctx, "msg-001", { moneda: "EUR" }, true);
  assert.equal(r.ok, false);
  assert.match(r.error, /moneda desconocida/);
  assert.ok(!("msg-001" in leerProcesados(ctx)));
});

test("estado final (O1, O2, RN6): 11 filas, 4 líneas de historial, 6 procesados y el fixture intacto", async () => {
  const ctx = proyectoTemporal();
  const fixture = fs.readFileSync(rutas(ctx).maestroOriginal, "utf8");
  for (const id of ["msg-001", "msg-002", "msg-003", "msg-004", "msg-005", "msg-006"]) await registrarEn(ctx, id);
  await registrarEn(ctx, "msg-006", { valor: 0, fecha_fin: "2027-08-31" }, true);
  assert.equal(leerMaestro(ctx).length, 11);
  assert.deepEqual(historial(ctx).map((h) => h.accion), ["nuevo", "nuevo", "actualizacion", "nuevo"]);
  assert.equal(Object.keys(leerProcesados(ctx)).length, 6);
  assert.equal(fs.readFileSync(rutas(ctx).maestroOriginal, "utf8"), fixture);
});
