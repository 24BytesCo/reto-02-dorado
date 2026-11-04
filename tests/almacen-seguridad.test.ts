import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { escribirAtomico, escribirMaestro, leerCorreo, leerMaestro, leerProcesados, marcarProcesado, rutas, serializarCsv, parsearCsv } from "../src/tools/almacen.ts";
import { dirSalida, ejecutarHerramienta, catalogo, erroresEnEspanol, ok } from "../src/tools/nucleo.ts";
import * as contratos from "../src/tools/contratos.ts";
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

test("el .env.example no trae valores (PRD §6.5): la clave y los números vacíos, con el valor por defecto en el comentario", () => {
  const t = fs.readFileSync(path.join(RAIZ, ".env.example"), "utf8");
  assert.match(t, /low \| medium \| high \| xhigh \| max/);
  assert.match(t, /^ANTHROPIC_API_KEY=$/m);
  assert.match(t, /^MAX_TOKENS_GLOBAL=$/m);
  assert.match(t, /por defecto 3000000/);
  const conValor = t.split("\n").filter((l) => /^[A-Z_]+=.+/.test(l)).map((l) => l.split("=")[0]);
  assert.deepEqual(conValor, ["LLM_PROVEEDOR"], "solo el proveedor lleva valor: el adaptador no acepta vacío");
});

test("OUT_DIR y BUZON_DIR vacíos toman su valor por defecto (out y el buzón del fixture)", () => {
  const ctx = proyectoTemporal();
  const previo = { out: process.env.OUT_DIR, buzon: process.env.BUZON_DIR };
  process.env.OUT_DIR = "";
  process.env.BUZON_DIR = "";
  try {
    assert.equal(dirSalida(ctx), path.join(ctx.directory, "out"));
    assert.equal(rutas(ctx).buzon, path.join(ctx.directory, "fixtures/reto-02/buzon"));
  } finally {
    if (previo.out === undefined) delete process.env.OUT_DIR; else process.env.OUT_DIR = previo.out;
    if (previo.buzon === undefined) delete process.env.BUZON_DIR; else process.env.BUZON_DIR = previo.buzon;
  }
});

// ── C8: escrituras atómicas y registrar que lee procesados.json antes de escribir ──

test("escribirAtomico reemplaza el archivo vía temporal + rename y no deja .tmp", () => {
  const ctx = proyectoTemporal();
  const ruta = path.join(ctx.directory, "out", "x.json");
  escribirAtomico(ruta, "uno");
  escribirAtomico(ruta, "dos");
  assert.equal(fs.readFileSync(ruta, "utf8"), "dos");
  assert.deepEqual(fs.readdirSync(path.dirname(ruta)), ["x.json"]);
});

test("escribirMaestro y marcarProcesado usan renameSync (el maestro nunca queda a medias)", (t) => {
  const ctx = proyectoTemporal();
  const renombres: string[] = [];
  const original = fs.renameSync;
  t.mock.method(fs, "renameSync", (de: fs.PathLike, a: fs.PathLike) => {
    renombres.push(path.basename(String(a)));
    original(de, a);
  });
  escribirMaestro(ctx, leerMaestro(ctx));
  marcarProcesado(ctx, "msg-004", "duplicado", "CT-2026-012");
  assert.deepEqual(renombres, ["maestro-contratos.csv", "procesados.json"]);
});

test("R2: con procesados.json a medias, registrar falla ANTES de escribir maestro, historial o archivo", async () => {
  const ctx = proyectoTemporal();
  const [reg] = catalogo("contratos", contratos).filter((r) => r.nombre === "contratos_registrar");
  fs.mkdirSync(rutas(ctx).out, { recursive: true });
  fs.writeFileSync(rutas(ctx).procesados, '{"msg-005": {"accion": "rech');
  const r = JSON.parse(await ejecutarHerramienta(reg, { mensaje_id: "msg-001" }, ctx));
  assert.equal(r.ok, false);
  assert.match(r.error, /procesados\.json está dañado/);
  assert.ok(!fs.existsSync(rutas(ctx).historial));
  assert.ok(!fs.existsSync(path.join(rutas(ctx).sharepoint, "Contratos")));
  assert.ok(!leerMaestro(ctx).some((f) => f.id_contrato === "CT-2026-015"));
});

test("S8 y C8: re-registrar un mensaje procesado no escribe y conserva la primera acción, con ultima_accion e intentos", async () => {
  const ctx = proyectoTemporal();
  const registrar = (id: string) => contratos.registrar.execute({ mensaje_id: id }, ctx).then((x) => JSON.parse(x));
  await registrar("msg-001");
  const maestro = fs.readFileSync(rutas(ctx).maestro, "utf8");
  const r = await registrar("msg-001");
  assert.equal(r.data.accion, "duplicado");
  assert.equal(r.data.ya_procesado, true);
  assert.equal(fs.readFileSync(rutas(ctx).maestro, "utf8"), maestro);
  assert.equal(fs.readFileSync(rutas(ctx).historial, "utf8").trim().split("\n").length, 1);
  const p = leerProcesados(ctx)["msg-001"];
  assert.equal(p.accion, "nuevo");
  assert.equal(p.id_contrato, "CT-2026-015");
  assert.equal(p.ultima_accion, "duplicado");
  assert.equal(p.intentos, 2);
});

// ── Cosmético: errores de validación de zod en español ──

test("los errores de validación de los argumentos salen en español, campo por campo", async () => {
  const ctx = proyectoTemporal();
  const H = new Map(catalogo("contratos", contratos).map((r) => [r.nombre, r]));
  const r = JSON.parse(await ejecutarHerramienta(H.get("contratos_validar")!, { mensaje_id: 6 }, ctx));
  assert.equal(r.error, "argumentos inválidos para contratos_validar: mensaje_id: se esperaba texto y llegó número");
  const falta = JSON.parse(await ejecutarHerramienta(H.get("contratos_registrar")!, {}, ctx));
  assert.match(falta.error, /mensaje_id: es obligatorio/);
  const esquema = z.object({ a: z.string().min(3), b: z.number().max(5), c: z.enum(["COP", "USD"]), d: z.string().regex(/^x$/) });
  const e = esquema.safeParse({ a: "x", b: 9, c: "EUR", d: "y" });
  assert.ok(!e.success);
  const texto = erroresEnEspanol(e.error);
  assert.match(texto, /a: demasiado pequeño: mínimo 3 caracteres/);
  assert.match(texto, /b: demasiado grande: máximo 5/);
  assert.match(texto, /c: valor no admitido; se esperaba uno de: "COP", "USD"/);
  assert.match(texto, /d: no tiene el formato esperado/);
  assert.doesNotMatch(texto, /Invalid|expected|received|Too (small|big)/);
});
