import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { extraer, registrar, validar } from "../src/tools/contratos.ts";
import { leerMaestro, leerProcesados } from "../src/tools/almacen.ts";
import { camposEnRevision } from "../src/tools/clasificacion.ts";
import { extraccionDeMensaje, fechaRegistro } from "../src/tools/mensajes.ts";
import { REGLAS, type CampoConConfianza } from "../src/tools/reglas.ts";
import type { Contexto } from "../src/tools/nucleo.ts";
import { proyectoTemporal } from "./ayudas.ts";

/**
 * Variantes de un «msg-007» que trajo el jurado hostil: montos con multiplicador o pago periódico, pólizas
 * en lista o con cláusulas de prórroga, documentos sin firma, actas, renovaciones, consorcios y fechas de correo.
 */

const BUZON_ORIGINAL = process.env.BUZON_DIR;
after(() => {
  if (BUZON_ORIGINAL === undefined) delete process.env.BUZON_DIR;
  else process.env.BUZON_DIR = BUZON_ORIGINAL;
});

const PERIFERIA = "PERIFERIA IT GROUP S.A.S., identificada con NIT 900.123.456-7, con domicilio en Medellín, Colombia, quien en adelante se denominará EL CONTRATISTA";

interface Partes {
  membrete?: string;
  titulo?: string;
  partes?: string;
  objeto?: string;
  valor?: string;
  plazo?: string;
  garantias?: string;
  firma?: string;
}

/** Contrato sintético con cláusulas reemplazables; por defecto, limpio, firmado y con póliza de cumplimiento. */
function contrato(p: Partes = {}): string {
  return [
    p.membrete,
    p.titulo ?? "CONTRATO DE PRESTACIÓN DE SERVICIOS No. CT-2026-020",
    p.partes ?? `Entre los suscritos, ACME ANDINA S.A.S., identificada con NIT 901.234.567-8, con domicilio en Bogotá D.C., quien en adelante se denominará EL CONTRATANTE, y ${PERIFERIA}, se ha celebrado el presente contrato:`,
    p.objeto ?? "PRIMERA. OBJETO. EL CONTRATISTA se obliga a ejecutar el desarrollo de una aplicación móvil de autogestión.",
    p.valor ?? "SEGUNDA. VALOR. El valor total del presente contrato es de CIEN MILLONES DE PESOS M/CTE (COP $100.000.000), IVA incluido.",
    p.plazo ?? "TERCERA. PLAZO. El plazo de ejecución será desde el primero (1) de septiembre de 2026 hasta el treinta y uno (31) de agosto de 2027.",
    p.garantias ?? "CUARTA. GARANTÍAS. EL CONTRATISTA constituirá a favor del CONTRATANTE una póliza de cumplimiento por el veinte por ciento (20%) del valor del contrato.",
    p.firma ?? "Para constancia se firma en Bogotá D.C., a los veinte (20) días del mes de agosto de 2026.",
  ].filter((b) => b !== undefined).join("\n\n");
}

/** Proyecto temporal con un buzón alterno de un mensaje `m01`; nunca escribe en el repositorio. */
function buzon(adjuntos: Record<string, string>, fecha = "2026-09-02T10:00:00-05:00"): Contexto {
  const ctx = proyectoTemporal();
  const carpeta = path.join(ctx.directory, "buzon-jurado", "m01");
  fs.mkdirSync(carpeta, { recursive: true });
  for (const [nombre, texto] of Object.entries(adjuntos)) fs.writeFileSync(path.join(carpeta, nombre), texto);
  const correo = { id: "m01", de: "lgomez@periferia-ficticia.com", para: "contratos@periferia-ficticia.com", asunto: "Contrato", fecha, cuerpo: "Adjunto.", adjuntos: Object.keys(adjuntos) };
  fs.writeFileSync(path.join(carpeta, "correo.json"), JSON.stringify(correo));
  process.env.BUZON_DIR = "buzon-jurado";
  return ctx;
}

const unContrato = (p: Partes): Contexto => buzon({ "contrato.txt": contrato(p) });

interface CampoJson { valor: unknown; confianza: number }
/** Respuesta de una herramienta, sin tipar: es el JSON tal cual lo recibe el modelo. */
const json = (s: string) => JSON.parse(s);
const extraerEn = async (ctx: Contexto) => json(await extraer.execute({ mensaje_id: "m01" }, ctx));
const validarEn = async (ctx: Contexto) => json(await validar.execute({ mensaje_id: "m01", contrato: {} }, ctx));
const registrarEn = async (ctx: Contexto, confirmado?: boolean) => json(await registrar.execute({ mensaje_id: "m01", contrato: {}, confirmado }, ctx));
const campo = (r: { data: { contrato: Record<string, CampoJson> } }, k: string): [unknown, number] => [r.data.contrato[k].valor, r.data.contrato[k].confianza];

// ── C1: montos ──

test("C1: valor mensual y total toma el total con 0,85", async () => {
  const r = await extraerEn(unContrato({ valor: "SEGUNDA. VALOR. EL CONTRATANTE pagará un valor mensual de COP 10.000.000, para un valor total de COP 120.000.000, IVA incluido." }));
  assert.deepEqual(campo(r, "valor"), [120000000, 0.85]);
});

test("C1: pago mensual sin «total» manda el valor a revisión con 0,5 y advertencia", async () => {
  const ctx = unContrato({ valor: "SEGUNDA. VALOR. EL CONTRATANTE pagará la suma mensual de COP 10.000.000 durante la ejecución." });
  const r = await extraerEn(ctx);
  assert.deepEqual(campo(r, "valor"), [10000000, 0.5]);
  assert.ok(r.data.advertencias.some((a: string) => /no dice cuál es el total/.test(a)));
  assert.ok((await validarEn(ctx)).data.requiere_revision.includes("valor"));
});

test("C1: dos montos distintos sin «total» van a revisión", async () => {
  const r = await extraerEn(unContrato({ valor: "SEGUNDA. VALOR. Un anticipo de COP 20.000.000 y un saldo de COP 80.000.000 contra entrega." }));
  assert.equal(campo(r, "valor")[1], 0.5);
});

test("C1: multiplicadores en palabras y apóstrofo de millones", async () => {
  const casos: Array<[string, number, string]> = [
    ["El valor total es de COP 1.200 millones, IVA incluido.", 1200000000, "COP"],
    ["El valor total es de USD 1,5 millones.", 1500000, "USD"],
    ["El valor total es de COP 2 mil millones.", 2000000000, "COP"],
    ["El valor total es de COP 350 mil.", 350000, "COP"],
    ["El valor total es de $265'000.000 M/CTE, IVA incluido.", 265000000, ""],
    ["El valor total es de DOSCIENTOS SESENTA Y CINCO MILLONES DE PESOS ($265'000.000), IVA incluido.", 265000000, "COP"],
  ];
  for (const [clausula, esperado, moneda] of casos) {
    const r = await extraerEn(unContrato({ valor: `SEGUNDA. VALOR. ${clausula}` }));
    assert.equal(campo(r, "valor")[0], esperado, clausula);
    if (moneda) assert.equal(campo(r, "moneda")[0], moneda, clausula);
  }
});

// ── C2: pólizas ──

test("C2: «En caso de que el contrato se prorrogue» no vuelve condicional una póliza obligatoria", async () => {
  const ctx = unContrato({ garantias: "CUARTA. GARANTÍAS. EL CONTRATISTA constituirá una póliza de cumplimiento por el veinte por ciento (20%) del valor del contrato. En caso de que el contrato se prorrogue, EL CONTRATISTA ampliará la vigencia de la póliza." });
  const r = await extraerEn(ctx);
  assert.deepEqual([campo(r, "requiere_poliza")[0], campo(r, "tipo_poliza")[0]], [true, "cumplimiento"]);
  assert.equal((await validarEn(ctx)).data.propuesta.estado_poliza, "pendiente");
});

test("C2: la póliza condicional sigue reconociéndose con «para cada orden» o «cuyo valor exceda»", async () => {
  for (const garantias of [
    "CUARTA. GARANTÍAS. Para cada orden de servicio EL CONTRATISTA constituirá póliza de cumplimiento.",
    "CUARTA. GARANTÍAS. Las órdenes cuyo valor exceda COP $50.000.000 exigirán póliza de cumplimiento.",
  ]) {
    const r = await extraerEn(unContrato({ garantias }));
    assert.deepEqual(campo(r, "requiere_poliza"), [false, 0.8], garantias);
  }
});

test("C2: listas de amparos se reconocen completas y en orden", async () => {
  const casos: Array<[string, string]> = [
    ["las pólizas de estabilidad y de calidad del servicio, cada una por el diez por ciento (10%).", "estabilidad;calidad"],
    ["una póliza de cumplimiento, de calidad del servicio y de salarios y prestaciones sociales.", "cumplimiento;calidad;salarios_prestaciones"],
    ["una póliza de cumplimiento y responsabilidad civil extracontractual.", "cumplimiento;responsabilidad_civil"],
  ];
  for (const [texto, tipos] of casos) {
    const r = await extraerEn(unContrato({ garantias: `CUARTA. GARANTÍAS. EL CONTRATISTA constituirá ${texto}` }));
    assert.equal(campo(r, "tipo_poliza")[0], tipos, texto);
  }
});

// ── C5: partes, firma y actas ──

test("C5: «Los suscritos…» y «entre las partes» identifican a la contraparte", async () => {
  for (const partes of [
    `Los suscritos, ACME ANDINA S.A.S., identificada con NIT 901.234.567-8, quien se denominará EL CONTRATANTE, y ${PERIFERIA}, hemos convenido celebrar el presente contrato:`,
    `Se celebra el presente contrato entre las partes: ACME ANDINA S.A.S., identificada con NIT 901.234.567-8 (EL CONTRATANTE), y ${PERIFERIA}.`,
  ]) {
    const r = await extraerEn(unContrato({ partes }));
    assert.deepEqual([campo(r, "nit_cliente")[0], campo(r, "cliente")[0]], ["901234567", "Acme Andina S.A.S."], partes);
  }
});

test("C5: un BORRADOR pendiente de firma no se registra sin confirmación y pide revisar «firma»", async () => {
  const ctx = unContrato({ membrete: "BORRADOR - PENDIENTE DE FIRMA" });
  const v = await validarEn(ctx);
  assert.deepEqual(v.data.requiere_revision, ["firma"]);
  assert.ok(v.data.advertencias.some((a: string) => /parece no firmado/.test(a)));
  assert.deepEqual(await registrarEn(ctx), { ok: false, error: "requiere revisión: firma" });
  assert.deepEqual(leerProcesados(ctx), {});
  assert.equal((await registrarEn(ctx, true)).data.accion, "nuevo");
});

test("C5: «PROPUESTA… NO FIRMADA», «Sin firmas» o la firma con espacios en blanco piden revisar la firma", async () => {
  for (const p of [
    { membrete: "PROPUESTA COMERCIAL - NO FIRMADA" },
    { firma: "Documento para revisión del cliente. Sin firmas." },
    { firma: "Para constancia se firma en Bogotá D.C., a los ____ días del mes de __________ de 2026." },
  ]) {
    assert.deepEqual((await validarEn(unContrato(p))).data.requiere_revision, ["firma"], JSON.stringify(p));
  }
});

test("C5: «según la propuesta» en el cuerpo de un contrato firmado no es una marca de borrador", async () => {
  const objeto = "PRIMERA. OBJETO. EL CONTRATISTA se obliga a ejecutar el desarrollo de una aplicación móvil según la propuesta presentada.";
  assert.deepEqual((await validarEn(unContrato({ objeto }))).data.requiere_revision, []);
});

const ACTA = `ACTA DE TERMINACIÓN ANTICIPADA DEL CONTRATO No. CT-2026-006

Entre UNIVERSIDAD DEL VALLE DEL RÍO, NIT 890.399.001-2, (EL CONTRATANTE), y PERIFERIA IT GROUP S.A.S., NIT 900.123.456-7 (EL CONTRATISTA), se acuerda dar por terminado de mutuo acuerdo el contrato No. CT-2026-006 a partir del treinta (30) de septiembre de 2026.

Se firma en Cali, a los quince (15) días del mes de agosto de 2026.`;

test("C5: un acta de terminación propone adelantar fecha_fin del contrato existente y espera confirmación", async () => {
  const ctx = buzon({ "acta.txt": ACTA });
  const v = await validarEn(ctx);
  assert.deepEqual([v.data.clasificacion, v.data.id_contrato_existente, v.data.requiere_revision], ["actualizacion", "CT-2026-006", ["fecha_fin"]]);
  assert.deepEqual(v.data.diferencias, { fecha_fin: { antes: "2027-02-19", despues: "2026-09-30" } });
  assert.equal((await registrarEn(ctx)).ok, false);
  assert.equal((await registrarEn(ctx, true)).data.accion, "actualizacion");
  assert.equal(leerMaestro(ctx).find((f) => f.id_contrato === "CT-2026-006")?.fecha_fin, "2026-09-30");
});

test("C5: un acta de un contrato que no está en el maestro queda pendiente, nunca rechazada y procesada", async () => {
  const ctx = buzon({ "acta.txt": ACTA.replaceAll("CT-2026-006", "CT-2026-099") });
  const r = await registrarEn(ctx, true);
  assert.deepEqual([r.data.accion, r.data.procesado], ["rechazado", false]);
  assert.match(r.data.motivo, /acta de terminación .* queda pendiente/);
  assert.deepEqual(leerProcesados(ctx), {});
});

// ── S1: fecha de registro ──

test("S1: la fecha del correo se valida: ISO y DD/MM/AAAA se aceptan; lo demás da error legible", () => {
  assert.equal(fechaRegistro("2026-08-04T09:15:00-05:00"), "2026-08-04");
  assert.equal(fechaRegistro("03/09/2026 10:15"), "2026-09-03");
  assert.throws(() => fechaRegistro("ayer"), /fecha del correo «ayer» no es válida/);
  assert.throws(() => fechaRegistro("31/02/2026"), /no existe en el calendario/);
});

test("S1: un correo con fecha ilegible da { ok: false } legible y no registra nada", async () => {
  const ctx = buzon({ "contrato.txt": contrato() }, "el martes");
  const r = await registrarEn(ctx);
  assert.equal(r.ok, false);
  assert.match(r.error, /fecha del correo «el martes» no es válida/);
  assert.equal(leerMaestro(ctx).length, 8);
  const dma = await validarEn(buzon({ "contrato.txt": contrato() }, "03/09/2026 10:15"));
  assert.equal(dma.data.propuesta.fecha_registro, "2026-09-03");
});

// ── S2: renovación y NIT ajeno ──

test("S2: una renovación (mismo NIT y objeto, otro número) es nueva y no pisa el contrato vigente", async () => {
  const ctx = unContrato({
    titulo: "CONTRATO DE PRESTACIÓN DE SERVICIOS No. CT-2027-001",
    partes: `Entre los suscritos, UNIVERSIDAD DEL VALLE DEL RÍO, identificada con NIT 890.399.001-2, con domicilio en Cali, Colombia, quien en adelante se denominará EL CONTRATANTE, y ${PERIFERIA}:`,
    objeto: "PRIMERA. OBJETO. EL CONTRATISTA prestará servicios de fábrica de software para el sistema académico del CONTRATANTE.",
    plazo: "TERCERA. PLAZO. El plazo de ejecución será desde el veinte (20) de febrero de 2027 hasta el diecinueve (19) de febrero de 2028.",
  });
  const antes = leerMaestro(ctx).find((f) => f.id_contrato === "CT-2026-006");
  const v = await validarEn(ctx);
  assert.deepEqual([v.data.clasificacion, v.data.propuesta.id_contrato], ["nuevo", "CT-2027-001"]);
  assert.ok(v.data.advertencias.some((a: string) => a.includes("Posible renovación de CT-2026-006")));
  await registrarEn(ctx, true);
  assert.deepEqual(leerMaestro(ctx).find((f) => f.id_contrato === "CT-2026-006"), antes);
  assert.ok(leerMaestro(ctx).some((f) => f.id_contrato === "CT-2027-001"));
});

test("S2: un id que ya es de otro NIT no se puede pisar ni confirmando y el mensaje queda pendiente", async () => {
  const ctx = unContrato({ titulo: "CONTRATO DE PRESTACIÓN DE SERVICIOS No. CT-2026-012" });
  const antes = leerMaestro(ctx);
  const v = await validarEn(ctx);
  assert.deepEqual([v.data.clasificacion, v.data.propuesta, v.data.pendiente], ["rechazado", null, true]);
  const r = await registrarEn(ctx, true);
  assert.deepEqual([r.data.accion, r.data.procesado], ["rechazado", false]);
  assert.deepEqual(leerMaestro(ctx), antes);
  assert.deepEqual(leerProcesados(ctx), {});
});

// ── S3: más de una contraparte ──

test("S3: con dos contratantes (consorcio) el cliente va a revisión con advertencia", async () => {
  const ctx = unContrato({ partes: `Entre los suscritos, ACME ANDINA S.A.S., identificada con NIT 901.234.567-8, y BETA SERVICIOS LTDA., identificada con NIT 830.111.222-3, quienes conforman el CONSORCIO ACME-BETA y se denominarán EL CONTRATANTE, y ${PERIFERIA}:` });
  const v = await validarEn(ctx);
  assert.deepEqual(v.data.requiere_revision, ["cliente"]);
  assert.ok(v.data.advertencias.some((a: string) => /más de una contraparte/.test(a) && a.includes("830111222")));
});

// ── S4: confianzas deducidas desacopladas del umbral ──

test("S4: si sube el umbral, los campos deducidos con 0,8 pasan a revisión en vez de quedar fuera", () => {
  delete process.env.BUZON_DIR;
  const ext = extraccionDeMensaje(proyectoTemporal(), "msg-006");
  const reglas = REGLAS as { umbralConfianza: number };
  const original = reglas.umbralConfianza;
  try {
    reglas.umbralConfianza = 0.85;
    const campos = camposEnRevision(ext, {});
    const deducidos: CampoConConfianza[] = ["fecha_inicio", "requiere_poliza", "tipo_poliza"];
    for (const k of deducidos) assert.ok(campos.includes(k), k);
  } finally {
    reglas.umbralConfianza = original;
  }
  assert.deepEqual(camposEnRevision(ext, {}), ["valor", "fecha_fin"]);
});
