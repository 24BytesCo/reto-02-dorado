import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { z } from "zod";
import * as contratos from "../src/tools/contratos.ts";
import { validar } from "../src/tools/contratos.ts";
import { extraccionDeMensaje } from "../src/tools/mensajes.ts";
import { clasificar, idAutomatico, similitudObjeto } from "../src/tools/clasificacion.ts";
import { leerMaestro, rutas } from "../src/tools/almacen.ts";
import { catalogo, ejecutarHerramienta, type Contexto } from "../src/tools/nucleo.ts";
import type { FilaMaestro } from "../src/tools/reglas.ts";
import { proyectoTemporal } from "./ayudas.ts";

type Corregido = Parameters<typeof validar.execute>[0]["contrato"];
const validarDe = async (id: string, contrato: Corregido = {}, ctx: Contexto = proyectoTemporal()) =>
  JSON.parse(await validar.execute({ mensaje_id: id, contrato }, ctx));

test("msg-001 (RN3): nuevo, sin revisión, póliza pendiente, fuente buzón y fecha de registro del correo", async () => {
  const d = (await validarDe("msg-001")).data;
  assert.equal(d.clasificacion, "nuevo");
  assert.deepEqual(d.requiere_revision, []);
  assert.equal(d.propuesta.estado_poliza, "pendiente");
  assert.equal(d.propuesta.fuente, "buzon");
  assert.equal(d.propuesta.fecha_registro, "2026-08-04");
  assert.equal(d.propuesta.comercial, "Laura Gómez Restrepo");
  assert.equal(d.propuesta.ruta_sharepoint, "");
});

test("msg-002 (RN3): nuevo sin póliza queda no_aplica", async () => {
  const d = (await validarDe("msg-002")).data;
  assert.equal(d.clasificacion, "nuevo");
  assert.equal(d.propuesta.estado_poliza, "no_aplica");
});

test("RN2 nunca solo por NIT: msg-001, msg-002 y msg-006 comparten NIT con contratos del maestro y son nuevos", async () => {
  const ctx = proyectoTemporal();
  const maestro = leerMaestro(ctx);
  for (const id of ["msg-001", "msg-002", "msg-006"]) {
    const d = (await validarDe(id, {}, ctx)).data;
    assert.equal(d.clasificacion, "nuevo", id);
    const mismoNit = maestro.filter((f) => f.nit_cliente === d.propuesta.nit_cliente);
    assert.ok(mismoNit.length > 0, `${id} comparte NIT`);
    for (const f of mismoNit) assert.ok(similitudObjeto(f.objeto, d.propuesta.objeto) < 0.9, `${id} frente a ${f.id_contrato}`);
  }
});

test("msg-003 (RN2): el otrosí actualiza con diferencias de valor, fecha_fin y póliza (S3) y lo ausente hereda la fila", async () => {
  const d = (await validarDe("msg-003")).data;
  assert.equal(d.clasificacion, "actualizacion");
  assert.equal(d.id_contrato_existente, "CT-2026-011");
  assert.deepEqual(d.requiere_revision, []);
  assert.deepEqual(d.diferencias, {
    valor: { antes: "350000", despues: "520000" },
    fecha_fin: { antes: "2027-05-01", despues: "2027-11-01" },
    estado_poliza: { antes: "vigente", despues: "pendiente" },
  });
  assert.equal(d.propuesta.fecha_inicio, "2026-05-02");
  assert.equal(d.propuesta.ruta_sharepoint, "Contratos/2026/minera-los-andes/CT-2026-011.pdf");
});

test("msg-004 (RN1 antes que RN2): mismo id, valor y fechas es duplicado aunque el objeto esté redactado distinto", async () => {
  const d = (await validarDe("msg-004")).data;
  assert.equal(d.clasificacion, "duplicado");
  assert.equal(d.id_contrato_existente, "CT-2026-012");
  assert.equal(d.diferencias, undefined);
});

test("msg-005 (RN4): la cotización se rechaza con motivo y sin propuesta", async () => {
  const d = (await validarDe("msg-005")).data;
  assert.equal(d.clasificacion, "rechazado");
  assert.match(d.motivo, /cotización/);
  assert.equal(d.propuesta, null);
});

test("msg-006 (RN5, HU-3): nuevo con revisión exactamente en valor y fecha_fin; el remitente desconocido no bloquea", async () => {
  const d = (await validarDe("msg-006")).data;
  assert.equal(d.clasificacion, "nuevo");
  assert.deepEqual(d.requiere_revision, ["valor", "fecha_fin"]);
  assert.equal(d.propuesta.comercial, "");
  assert.ok(d.advertencias.some((a: string) => a.includes("jperez@periferia-ficticia.com")));
});

test("CA2: un valor distinto de lo extraído entra a revisión aunque el campo no fuera dudoso", async () => {
  const d = (await validarDe("msg-001", { valor: 999 })).data;
  assert.deepEqual(d.requiere_revision, ["valor"]);
  assert.equal(d.propuesta.valor, "999");
});

test("los valores corregidos iguales a lo extraído no agregan revisión", async () => {
  assert.deepEqual((await validarDe("msg-006", { valor: 0, fecha_fin: "2027-08-31" })).data.requiere_revision, ["valor", "fecha_fin"]);
  assert.deepEqual((await validarDe("msg-001", { moneda: "COP" })).data.requiere_revision, []);
});

test("conflicto de identidad: mismo id con otro NIT es actualización con «conflicto: nit_cliente» en revisión", async () => {
  const d = (await validarDe("msg-004", { nit_cliente: "123456789" })).data;
  assert.equal(d.clasificacion, "actualizacion");
  assert.deepEqual(d.requiere_revision, ["nit_cliente", "conflicto: nit_cliente"]);
});

test("HU-6: fecha, moneda, país o id inválidos en lo corregido devuelven { ok: false } legible", async () => {
  assert.match((await validarDe("msg-001", { fecha_fin: "2027-02-31" })).error, /fecha inválida/);
  assert.match((await validarDe("msg-001", { fecha_inicio: "01/08/2026" })).error, /fecha_inicio inválida/);
  assert.match((await validarDe("msg-001", { moneda: "EUR" })).error, /moneda desconocida: EUR/);
  assert.match((await validarDe("msg-001", { pais: "MX" })).error, /país desconocido/);
  assert.match((await validarDe("msg-001", { id_contrato: "../../x" })).error, /id_contrato inválido/);
  assert.match((await validarDe("msg-001", { fecha_fin: "2026-01-01" })).error, /anterior a fecha_inicio/);
});

test("validar no escribe nada en el maestro", async () => {
  const ctx = proyectoTemporal();
  for (const id of ["msg-001", "msg-003", "msg-006"]) await validarDe(id, {}, ctx);
  assert.equal(fs.readFileSync(rutas(ctx).maestro, "utf8"), fs.readFileSync(rutas(ctx).maestroOriginal, "utf8"));
});

test("el backend valida los argumentos con zod: un valor que no es número no llega a ejecutarse", async () => {
  const reg = catalogo("contratos", contratos).find((r) => r.nombre === "contratos_validar")!;
  const r = JSON.parse(await ejecutarHerramienta(reg, { mensaje_id: "msg-001", contrato: { valor: "mucho" } }, proyectoTemporal()));
  assert.equal(r.ok, false);
  assert.match(r.error, /argumentos inválidos para contratos_validar/);
});

test("cada campo de los argumentos de validar y registrar lleva .describe() (PRD §6.2)", () => {
  for (const h of [contratos.validar, contratos.registrar]) {
    for (const [k, esquema] of Object.entries(h.args)) assert.ok((esquema as z.ZodType).description, k);
    for (const [k, esquema] of Object.entries(h.args.contrato.unwrap().shape)) assert.ok((esquema as z.ZodType).description, `contrato.${k}`);
  }
});

// ── Lógica pura: casos que el buzón no trae ──

const fila = (cambios: Partial<FilaMaestro>): FilaMaestro => ({ ...leerMaestro(proyectoTemporal())[0], ...cambios });

test("similitud de Jaccard: ignora tildes, mayúsculas y palabras vacías", () => {
  assert.equal(similitudObjeto("Implementación del CRM y soporte", "implementacion crm soporte"), 1);
  assert.equal(similitudObjeto("", ""), 0);
});

test("RN2 por NIT y objeto similar: sin el mismo id, actualiza la fila y marca el choque de id", () => {
  const ctx = proyectoTemporal();
  const ext = extraccionDeMensaje(ctx, "msg-001");
  const existente = fila({ id_contrato: "OTRO-1", nit_cliente: "890900111", objeto: ext.contrato.objeto.valor! });
  const r = clasificar({ extraccion: ext, corregido: {}, comercial: "", fecha_registro: "2026-08-04", maestro: [existente] });
  assert.equal(r.clasificacion, "actualizacion");
  assert.equal(r.id_contrato_existente, "OTRO-1");
  assert.ok(r.requiere_revision.includes("conflicto: id_contrato"));
});

test("un otrosí de un contrato que no está en el maestro se rechaza con motivo", () => {
  const ctx = proyectoTemporal();
  const ext = extraccionDeMensaje(ctx, "msg-003");
  const r = clasificar({ extraccion: ext, corregido: {}, comercial: "", fecha_registro: "2026-08-22", maestro: [] });
  assert.equal(r.clasificacion, "rechazado");
  assert.match(r.motivo!, /no está en el maestro/);
});

test("RN4: un contrato sin objeto identificable se rechaza", () => {
  const ext = extraccionDeMensaje(proyectoTemporal(), "msg-001");
  const sinObjeto = { ...ext, contrato: { ...ext.contrato, objeto: { valor: null, confianza: 0 } } };
  const r = clasificar({ extraccion: sinObjeto, corregido: {}, comercial: "", fecha_registro: "2026-08-04", maestro: [] });
  assert.equal(r.clasificacion, "rechazado");
  assert.match(r.motivo!, /objeto/);
});

test("§7.2: un contrato sin número recibe AUTO-<año>-<secuencia> y el id queda en revisión", () => {
  const ext = extraccionDeMensaje(proyectoTemporal(), "msg-001");
  const sinId = { ...ext, contrato: { ...ext.contrato, id_contrato: { valor: null, confianza: 0 } } };
  const r = clasificar({ extraccion: sinId, corregido: {}, comercial: "", fecha_registro: "2026-08-04", maestro: [] });
  assert.equal(r.propuesta?.id_contrato, "AUTO-2026-001");
  assert.deepEqual(r.requiere_revision, ["id_contrato"]);
  assert.equal(idAutomatico("2026", [fila({ id_contrato: "AUTO-2026-007" })]), "AUTO-2026-008");
});
