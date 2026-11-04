import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { alertas, extraer, leer_buzon, registrar, validar } from "../src/tools/contratos.ts";
import { leerMaestro, leerProcesados, rutas } from "../src/tools/almacen.ts";
import { similitudObjeto } from "../src/tools/clasificacion.ts";
import type { Contexto } from "../src/tools/nucleo.ts";
import { proyectoTemporal } from "./ayudas.ts";

/**
 * Casos de la verificación adversaria que el buzón del reto no trae: variantes de redacción de contratos
 * reales, correos rotos y la confirmación de campos que no estaban en revisión.
 */

const BUZON_ORIGINAL = process.env.BUZON_DIR;
after(() => {
  if (BUZON_ORIGINAL === undefined) delete process.env.BUZON_DIR;
  else process.env.BUZON_DIR = BUZON_ORIGINAL;
});

const PERIFERIA = "PERIFERIA IT GROUP S.A.S., identificada con NIT 900.123.456-7, con domicilio en Medellín, Colombia, representada legalmente por Roberto Andrade Salazar, quien en adelante se denominará EL CONTRATISTA";

interface Partes {
  membrete?: string;
  titulo?: string;
  partes?: string;
  objeto?: string;
  valor?: string;
  plazo?: string;
  garantias?: string;
}

/** Contrato sintético con cláusulas reemplazables; por defecto es un contrato limpio de ACME, sin póliza ni monedas en palabras. */
function contrato(p: Partes = {}): string {
  const bloques = [
    p.membrete,
    p.titulo ?? "CONTRATO DE PRESTACIÓN DE SERVICIOS No. CT-2026-020",
    p.partes ?? `Entre los suscritos, ACME SOLUCIONES S.A.S., identificada con NIT 901.555.666-2, con domicilio en Bogotá D.C., representada legalmente por Ana Ruiz, quien en adelante se denominará EL CONTRATANTE, y ${PERIFERIA}, se ha celebrado el presente contrato:`,
    p.objeto ?? "PRIMERA. OBJETO. EL CONTRATISTA prestará servicios de desarrollo de una aplicación móvil de ventas.",
    p.valor ?? "SEGUNDA. VALOR. El valor total del presente contrato es de CIEN MILLONES DE PESOS M/CTE (COP $100.000.000), IVA incluido.",
    p.plazo ?? "TERCERA. PLAZO. El plazo de ejecución será desde el primero (1) de septiembre de 2026 hasta el treinta y uno (31) de agosto de 2027.",
    p.garantias ?? "CUARTA. CONFIDENCIALIDAD. Las partes mantendrán la confidencialidad.",
    "Para constancia se firma en Bogotá D.C., a los treinta (30) días del mes de agosto de 2026.",
  ];
  return bloques.filter((b) => b !== undefined).join("\n\n");
}

interface Mensaje {
  id: string;
  adjuntos?: Record<string, string>;
  /** Contenido literal de correo.json; `null` = no se escribe el archivo. */
  correo?: string | null;
}

/** Proyecto temporal con un buzón alterno dentro del proyecto (nunca en el repositorio). */
function buzon(mensajes: Mensaje[]): Contexto {
  const ctx = proyectoTemporal();
  const dir = path.join(ctx.directory, "buzon-casos");
  for (const m of mensajes) {
    const carpeta = path.join(dir, m.id);
    fs.mkdirSync(carpeta, { recursive: true });
    const adjuntos = m.adjuntos ?? { "contrato.txt": contrato() };
    for (const [nombre, texto] of Object.entries(adjuntos)) fs.writeFileSync(path.join(carpeta, nombre), texto);
    const correo = { id: m.id, de: "lgomez@periferia-ficticia.com", para: "contratos@periferia-ficticia.com", asunto: "Contrato", fecha: "2026-09-01T10:00:00-05:00", cuerpo: "Adjunto.", adjuntos: Object.keys(adjuntos) };
    if (m.correo !== null) fs.writeFileSync(path.join(carpeta, "correo.json"), m.correo ?? JSON.stringify(correo));
  }
  process.env.BUZON_DIR = "buzon-casos";
  return ctx;
}

/** Buzón con un único contrato. */
const unContrato = (p: Partes): Contexto => buzon([{ id: "m01", adjuntos: { "contrato.txt": contrato(p) } }]);

interface CampoJson { valor: unknown; confianza: number }
/** Respuesta de una herramienta, sin tipar: como en el resto de las pruebas, es el JSON tal cual. */
const json = (s: string) => JSON.parse(s);
const extraerEn = async (ctx: Contexto, id = "m01") => json(await extraer.execute({ mensaje_id: id }, ctx));
const validarEn = async (ctx: Contexto, id = "m01") => json(await validar.execute({ mensaje_id: id, contrato: {} }, ctx));
const campo = (r: { data: { contrato: Record<string, CampoJson> } }, k: string): CampoJson => r.data.contrato[k];

const usarBuzonReal = () => delete process.env.BUZON_DIR;

// ── 1. CA2 al confirmar ──

test("CA2: confirmar msg-006 no permite cambiar el cliente ni el id, que no estaban en revisión", async () => {
  usarBuzonReal();
  const ctx = proyectoTemporal();
  for (const colado of [{ cliente: "Otra Empresa S.A.S." }, { id_contrato: "CM-9999-99" }]) {
    const r = json(await registrar.execute({ mensaje_id: "msg-006", contrato: { valor: 0, fecha_fin: "2027-08-31", ...colado }, confirmado: true }, ctx));
    const campoColado = Object.keys(colado)[0];
    assert.deepEqual(r, { ok: false, error: `el campo ${campoColado} no estaba en revisión: no se puede cambiar al confirmar; valida de nuevo y pide confirmación` });
  }
  const dos = json(await registrar.execute({ mensaje_id: "msg-006", contrato: { cliente: "X", nit_cliente: "1" }, confirmado: true }, ctx));
  assert.match(dos.error!, /^los campos cliente, nit_cliente no estaban en revisión/);
  assert.equal(leerMaestro(ctx).length, 8);
  assert.ok(!("msg-006" in leerProcesados(ctx)));
  const bien = json(await registrar.execute({ mensaje_id: "msg-006", contrato: { valor: 0, fecha_fin: "2027-08-31" }, confirmado: true }, ctx));
  assert.equal(bien.data.accion, "nuevo");
});

// ── 2. Encabezados de cláusula ──

test("encabezados de cláusula habituales: el objeto se extrae sin el prefijo", async () => {
  const objeto = "EL CONTRATISTA prestará servicios de desarrollo de una aplicación móvil de ventas.";
  for (const cabeza of ["CLÁUSULA PRIMERA. OBJETO.", "PRIMERA: OBJETO.", "PRIMERA. OBJETO DEL CONTRATO.", "1. OBJETO."]) {
    const r = await extraerEn(unContrato({ objeto: `${cabeza} ${objeto}` }));
    assert.equal(campo(r, "objeto").valor, "Desarrollo de una aplicación móvil de ventas", cabeza);
  }
});

test("VALOR, PLAZO y GARANTÍAS con «CLÁUSULA …» y numerales se reconocen", async () => {
  const r = await extraerEn(unContrato({
    valor: "CLÁUSULA SEGUNDA. VALOR DEL CONTRATO. El valor total es de (COP $100.000.000).",
    plazo: "3. PLAZO: desde el primero (1) de septiembre de 2026 hasta el treinta y uno (31) de agosto de 2027.",
    garantias: "CLÁUSULA CUARTA: GARANTÍAS. EL CONTRATISTA constituirá una póliza de cumplimiento.",
  }));
  assert.deepEqual([campo(r, "valor").valor, campo(r, "fecha_inicio").valor, campo(r, "fecha_fin").valor], [100000000, "2026-09-01", "2027-08-31"]);
  assert.deepEqual([campo(r, "requiere_poliza").valor, campo(r, "tipo_poliza").valor], [true, "cumplimiento"]);
});

test("RN4: con partes y sin objeto identificable no se rechaza; el objeto va a revisión y el mensaje queda pendiente", async () => {
  const ctx = unContrato({ objeto: "PRIMERA. ALCANCE. EL CONTRATISTA desarrollará una aplicación." });
  const v = await validarEn(ctx);
  assert.equal(v.data.clasificacion, "nuevo");
  assert.deepEqual(v.data.requiere_revision, ["objeto"]);
  const r = json(await registrar.execute({ mensaje_id: "m01", contrato: {} }, ctx));
  assert.deepEqual(r, { ok: false, error: "requiere revisión: objeto" });
  assert.deepEqual(leerProcesados(ctx), {});
});

// ── 3. Póliza ──

test("póliza: cláusulas PÓLIZAS, GARANTÍAS Y SEGUROS y «garantía única de cumplimiento» exigen póliza", async () => {
  for (const garantias of [
    "CUARTA. PÓLIZAS. EL CONTRATISTA constituirá una póliza de cumplimiento por el diez por ciento (10%) del valor.",
    "CUARTA. GARANTÍAS Y SEGUROS. EL CONTRATISTA constituirá una póliza de cumplimiento.",
    "CUARTA. GARANTÍAS. EL CONTRATISTA constituirá una garantía única de cumplimiento por el diez por ciento (10%).",
    "CUARTA. SEGUROS. EL CONTRATISTA tomará una póliza de responsabilidad civil.",
  ]) {
    const r = await extraerEn(unContrato({ garantias }));
    assert.equal(campo(r, "requiere_poliza").valor, true, garantias);
    assert.ok(campo(r, "requiere_poliza").confianza >= 0.8, garantias);
  }
});

test("póliza mencionada fuera de una cláusula de garantías: true con 0,6 y entra a revisión", async () => {
  const ctx = unContrato({ garantias: "CUARTA. OBLIGACIONES. EL CONTRATISTA entregará la póliza de cumplimiento antes del inicio." });
  const r = await extraerEn(ctx);
  assert.deepEqual(campo(r, "requiere_poliza"), { ...campo(r, "requiere_poliza"), valor: true, confianza: 0.6 });
  assert.ok((await validarEn(ctx)).data.requiere_revision.includes("requiere_poliza"));
});

test("sin ninguna mención de póliza o garantía: false con 0,9", async () => {
  const r = await extraerEn(unContrato({}));
  assert.deepEqual([campo(r, "requiere_poliza").valor, campo(r, "requiere_poliza").confianza], [false, 0.9]);
});

// ── 4. leer_buzon robusto ──

test("HU-6: correo.json roto, incompleto o ausente y un adjunto ilegible no tumban leer_buzon", async () => {
  const ctx = buzon([
    { id: "a-bueno" },
    { id: "b-roto", correo: "{roto" },
    { id: "c-incompleto", correo: JSON.stringify({ id: "c-incompleto", adjuntos: [] }) },
    { id: "d-sin-correo", correo: null },
    { id: "e-adjunto-carpeta", adjuntos: {}, correo: JSON.stringify({ id: "e-adjunto-carpeta", de: "x@y", asunto: "a", fecha: "2026-09-01", adjuntos: [".."] }) },
  ]);
  const r = json(await leer_buzon.execute({}, ctx));
  assert.equal(r.ok, true);
  const mensajes = r.data.mensajes as Array<{ id: string; tiene_contrato: boolean; clasificacion?: string; motivo?: string }>;
  assert.deepEqual(mensajes.map((m) => m.id), ["a-bueno", "b-roto", "c-incompleto", "d-sin-correo", "e-adjunto-carpeta"]);
  assert.equal(mensajes[0].tiene_contrato, true);
  for (const m of mensajes.slice(1)) {
    assert.deepEqual([m.tiene_contrato, m.clasificacion], [false, "rechazado"], m.id);
    assert.ok(m.motivo && !m.motivo.includes(ctx.directory) && !m.motivo.includes(path.sep + "tmp"), `${m.id}: ${m.motivo}`);
  }
  assert.match(mensajes[3].motivo!, /falta el archivo correo\.json/);
});

// ── 5. Redacciones comunes ──

test("membrete antes del título: sigue siendo contrato y conserva su número", async () => {
  const r = await extraerEn(unContrato({ membrete: "PERIFERIA IT GROUP S.A.S.\nNIT 900.123.456-7" }));
  assert.equal(r.ok, true);
  assert.equal(campo(r, "id_contrato").valor, "CT-2026-020");
});

test("contraparte nombrada después de Periferia sin coma, y «identificada con el NIT»", async () => {
  const despues = `Entre ${PERIFERIA.replace(", quien en adelante se denominará EL CONTRATISTA", "")} (EL CONTRATISTA) y ACME SOLUCIONES S.A.S., NIT 901.555.666-2, con domicilio en Bogotá, representada por Ana Ruiz (EL CONTRATANTE), se celebra el presente contrato:`;
  const conEl = "Entre los suscritos, ACME SOLUCIONES S.A.S., identificada con el NIT 901.555.666-2, con domicilio en Bogotá D.C. (EL CONTRATANTE), y " + PERIFERIA + ".";
  for (const partes of [despues, conEl]) {
    const r = await extraerEn(unContrato({ partes }));
    assert.equal(campo(r, "nit_cliente").valor, "901555666", partes);
  }
});

test("valor: «$100.000.000» sin código se toma con 0,85 y «más IVA 19%» no es una moneda", async () => {
  const r = await extraerEn(unContrato({ valor: "SEGUNDA. VALOR. El valor total es de cien millones de pesos ($100.000.000) más IVA 19%." }));
  assert.equal(r.ok, true);
  assert.deepEqual([campo(r, "valor").valor, campo(r, "valor").confianza, campo(r, "moneda").valor], [100000000, 0.85, "COP"]);
});

test("«según las tarifas» con monto explícito no es indeterminado; sin monto sí", async () => {
  const conMonto = await extraerEn(unContrato({ valor: "SEGUNDA. VALOR. El valor es de (COP $100.000.000), que se facturará según las tarifas del Anexo 1." }));
  assert.deepEqual([campo(conMonto, "valor").valor, conMonto.data.valor_indeterminado], [100000000, false]);
  const sinMonto = await extraerEn(unContrato({ valor: "SEGUNDA. VALOR. Cada servicio se pagará según las tarifas del Anexo 1." }));
  assert.deepEqual([campo(sinMonto, "valor").valor, sinMonto.data.valor_indeterminado], [0, true]);
});

test("HU-6: euros, € o libras en la cláusula de valor son moneda desconocida", async () => {
  for (const valor of ["SEGUNDA. VALOR. CINCUENTA MIL EUROS (€ 50.000,00).", "SEGUNDA. VALOR. € 50.000,00.", "SEGUNDA. VALOR. Diez mil libras esterlinas."]) {
    const r = await extraerEn(unContrato({ valor }));
    assert.equal(r.ok, false, valor);
    assert.match(r.error!, /moneda desconocida/, valor);
  }
});

test("moneda deducida solo por el país baja a 0,6 y va a revisión; msg-006 sigue COP con 0,85 por su código", async () => {
  const ctx = unContrato({ valor: "SEGUNDA. VALOR. El valor total es de $100.000.000." });
  const r = await extraerEn(ctx);
  assert.deepEqual([campo(r, "moneda").valor, campo(r, "moneda").confianza], ["COP", 0.6]);
  assert.ok((await validarEn(ctx)).data.requiere_revision.includes("moneda"));
  usarBuzonReal();
  const m6 = await extraerEn(proyectoTemporal(), "msg-006");
  assert.deepEqual([campo(m6, "moneda").valor, campo(m6, "moneda").confianza], ["COP", 0.85]);
});

test("similitud de objeto: plural, «servicio(s)» y «del CONTRATANTE» no la bajan", () => {
  assert.ok(similitudObjeto("Servicios de arquitectura de nube y migración", "Servicio de arquitectura de nube y migración") >= 0.9);
  assert.ok(similitudObjeto("Soporte y mantenimiento plataforma SAP", "Soporte y mantenimiento de plataformas SAP") >= 0.9);
  assert.ok(similitudObjeto("Soporte y mantenimiento plataforma SAP", "Soporte y mantenimiento de la plataforma SAP del CONTRATANTE") >= 0.9);
});

test("RN2: mismo NIT y objeto casi idéntico sin número es actualización, no una fila nueva", async () => {
  const ctx = unContrato({
    titulo: "CONTRATO DE PRESTACIÓN DE SERVICIOS",
    partes: `Entre los suscritos, INDUSTRIAS DELTA S.A.S., identificada con NIT 890.900.111-4, con domicilio en Bogotá D.C. (EL CONTRATANTE), y ${PERIFERIA}.`,
    objeto: "PRIMERA. OBJETO. EL CONTRATISTA prestará el servicio de soporte y mantenimiento de la plataforma SAP del CONTRATANTE.",
  });
  const v = await validarEn(ctx);
  assert.deepEqual([v.data.clasificacion, v.data.id_contrato_existente], ["actualizacion", "CT-2025-018"]);
});

test("RTN con guiones se normaliza y casa con el maestro; RUC de Panamá con guiones casa por su primer segmento", async () => {
  const rtn = unContrato({ partes: `Entre AGROEXPORT SULA S. DE R.L., identificada con RTN 0801-9995-123456, con domicilio en San Pedro Sula, Honduras (EL CONTRATANTE), y ${PERIFERIA}.` });
  const r1 = await extraerEn(rtn);
  assert.deepEqual([campo(r1, "nit_cliente").valor, campo(r1, "cliente").valor, campo(r1, "pais").valor], ["08019995123456", "Agroexport Sula S. de R.L.", "HN"]);
  const ruc = unContrato({
    titulo: "CONTRATO DE PRESTACIÓN DE SERVICIOS No. CT-2026-004",
    partes: `Entre LOGÍSTICA DEL ISTMO S.A., identificada con RUC 155612345-2-2017, con domicilio en Ciudad de Panamá, Panamá (EL CONTRATANTE), y ${PERIFERIA}.`,
    valor: "SEGUNDA. VALOR. El valor total es de (USD 180,000.00).",
  });
  const r2 = await extraerEn(ruc);
  assert.equal(campo(r2, "nit_cliente").valor, "155612345");
  assert.ok(!(await validarEn(ruc)).data.requiere_revision.includes("conflicto: nit_cliente"));
});

// ── 6. Bajas ──

test("RN1: revalidar msg-006 ya registrado es duplicado sin nada que confirmar", async () => {
  usarBuzonReal();
  const ctx = proyectoTemporal();
  await registrar.execute({ mensaje_id: "msg-006", contrato: { valor: 0, fecha_fin: "2027-08-31" }, confirmado: true }, ctx);
  const v = await validarEn(ctx, "msg-006");
  assert.deepEqual([v.data.clasificacion, v.data.requiere_revision], ["duplicado", []]);
});

test("otrosí de un contrato inexistente: no se marca procesado y el motivo dice que queda pendiente", async () => {
  const otrosi = `OTROSÍ No. 1 AL CONTRATO DE PRESTACIÓN DE SERVICIOS No. CT-2026-099

Entre ACME SOLUCIONES S.A.S., identificada con NIT 901.555.666-2 (EL CONTRATANTE), y PERIFERIA IT GROUP S.A.S., NIT 900.123.456-7 (EL CONTRATISTA), se acuerda modificar el contrato:

PRIMERA. Modificar la cláusula TERCERA (PLAZO), la cual quedará así: "El plazo se extiende hasta el treinta (30) de junio de 2027."`;
  const ctx = buzon([{ id: "m01", adjuntos: { "otrosi.txt": otrosi } }]);
  const r = json(await registrar.execute({ mensaje_id: "m01", contrato: {} }, ctx));
  assert.deepEqual([r.data.accion, r.data.procesado], ["rechazado", false]);
  assert.match(r.data.motivo, /queda pendiente/);
  assert.deepEqual(leerProcesados(ctx), {});
});

test("«a partir del 1 de septiembre» es un inicio explícito y el fin se deriva del plazo en meses", async () => {
  const r = await extraerEn(unContrato({ plazo: "TERCERA. PLAZO. Doce (12) meses contados a partir del primero (1) de septiembre de 2026." }));
  assert.deepEqual([campo(r, "fecha_inicio").valor, campo(r, "fecha_inicio").confianza], ["2026-09-01", 0.95]);
  assert.equal(campo(r, "fecha_fin").valor, "2027-09-01");
});

test("el número del contrato acepta «N°», «Nº» y «No»", async () => {
  for (const marca of ["N°", "Nº", "No"]) {
    const r = await extraerEn(unContrato({ titulo: `CONTRATO DE PRESTACIÓN DE SERVICIOS ${marca} CT-2026-020` }));
    assert.equal(campo(r, "id_contrato").valor, "CT-2026-020", marca);
  }
});

test("§6.2: execute nunca lanza, ni con args ni ctx undefined", async () => {
  const sinArgs = undefined as never;
  for (const h of [extraer, validar, registrar, alertas, leer_buzon]) {
    const r = json(await h.execute(sinArgs, sinArgs));
    assert.equal(r.ok, false);
  }
});

test("HU-4: el historial tiene cambios {campo:{antes,despues}} y archivo y confirmados como claves de la línea", async () => {
  usarBuzonReal();
  const ctx = proyectoTemporal();
  for (const id of ["msg-001", "msg-003"]) await registrar.execute({ mensaje_id: id, contrato: {} }, ctx);
  await registrar.execute({ mensaje_id: "msg-006", contrato: { valor: 0, fecha_fin: "2027-08-31" }, confirmado: true }, ctx);
  const lineas = fs.readFileSync(rutas(ctx).historial, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
  for (const l of lineas) {
    for (const cambio of Object.values(l.cambios as Record<string, unknown>)) assert.deepEqual(Object.keys(cambio as object), ["antes", "despues"]);
    assert.equal(typeof l.archivo, "string");
  }
  assert.equal(lineas[1].archivo, "Contratos/2026/minera-los-andes/CT-2026-011-otrosi-1.txt");
  assert.ok(lineas[2].confirmados);
  assert.equal((lineas[0].cambios as Record<string, { antes: unknown }>).valor.antes, null);
});
