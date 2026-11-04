import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  escribirMaestro, leerCorreo, leerMaestro, leerProcesados, marcarProcesado, parsearCsv, rutas, serializarCsv, carpetaMensaje,
} from "../src/tools/almacen.ts";
import { RAIZ, proyectoTemporal } from "./ayudas.ts";

test("el CSV del fixture sobrevive leer y escribir sin cambiar un solo byte", () => {
  const original = fs.readFileSync(path.join(RAIZ, "fixtures/reto-02/maestro-contratos.csv"), "utf8");
  assert.equal(serializarCsv(parsearCsv(original)), original);
});

test("campos con comas y comillas se escriben entre comillas y se leen igual", () => {
  const registros = [["a", "b"], ["implementación, parametrización y soporte", 'dice "hola"']];
  assert.deepEqual(parsearCsv(serializarCsv(registros)), registros);
});

test("el maestro se copia a out/ la primera vez y el fixture nunca se toca (RN6)", () => {
  const ctx = proyectoTemporal();
  const antes = fs.readFileSync(rutas(ctx).maestroOriginal, "utf8");
  const filas = leerMaestro(ctx);
  assert.equal(filas.length, 8);
  assert.ok(fs.existsSync(rutas(ctx).maestro));
  escribirMaestro(ctx, filas.slice(0, 1));
  assert.equal(fs.readFileSync(rutas(ctx).maestroOriginal, "utf8"), antes);
});

test("los NIT con ceros a la izquierda se conservan como texto", () => {
  const filas = leerMaestro(proyectoTemporal());
  assert.equal(filas.find((f) => f.id_contrato === "CT-2026-009")?.nit_cliente, "08019995123456");
});

test("procesados.json registra los mensajes marcados", () => {
  const ctx = proyectoTemporal();
  marcarProcesado(ctx, "msg-004", "duplicado", "CT-2026-012");
  assert.equal(leerProcesados(ctx)["msg-004"].accion, "duplicado");
});

test("el correo se valida con zod y un id con ruta relativa se rechaza", () => {
  const ctx = proyectoTemporal();
  assert.equal(leerCorreo(ctx, "msg-001").adjuntos[0], "contrato.txt");
  assert.throws(() => carpetaMensaje(ctx, "../../.env"), /no existe en el buzón/);
});
