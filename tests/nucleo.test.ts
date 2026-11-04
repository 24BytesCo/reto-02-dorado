import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { catalogo, ejecutarHerramienta, ok, type Contexto, type Herramienta } from "../src/tools/nucleo.ts";

const ctx = (): Contexto => ({ directory: fs.mkdtempSync(path.join(os.tmpdir(), "reto-")), sessionId: "prueba" });

const eco: Herramienta<{ mensaje_id: z.ZodString }> = {
  description: "Devuelve el id que recibe.",
  args: { mensaje_id: z.string().describe("Id del mensaje") },
  async execute(args) {
    return ok({ id: args.mensaje_id, resumen: `eco ${args.mensaje_id}` });
  },
};
const explota: Herramienta<{}> = {
  description: "Lanza un error a propósito.",
  args: {},
  async execute() {
    throw new Error("falló por dentro");
  },
};

test("el nombre visible es <archivo>_<export> y solo entran los exports con forma de herramienta", () => {
  const regs = catalogo("contratos", { eco, explota, OTRA_COSA: 42 });
  assert.deepEqual(regs.map((r) => r.nombre), ["contratos_eco", "contratos_explota"]);
});

test("argumentos inválidos: no ejecuta, devuelve { ok: false } legible y lo anota en el log", async () => {
  const c = ctx();
  const [reg] = catalogo("contratos", { eco });
  const r = JSON.parse(await ejecutarHerramienta(reg, { mensaje_id: 7 }, c));
  assert.equal(r.ok, false);
  assert.match(r.error, /argumentos inválidos para contratos_eco/);
  const log = fs.readFileSync(path.join(c.directory, "out", "log.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(log.length, 1);
  assert.equal(log[0].ok, false);
  assert.equal(log[0].herramienta, "contratos_eco");
});

test("una herramienta que lanza nunca rompe al llamador: responde { ok: false }", async () => {
  const [reg] = catalogo("contratos", { explota });
  const r = JSON.parse(await ejecutarHerramienta(reg, {}, ctx()));
  assert.deepEqual(r, { ok: false, error: "falló por dentro" });
});

test("cada llamada exitosa deja { ts, herramienta, mensaje_id, ok, resumen } en out/log.jsonl (RN7)", async () => {
  const c = ctx();
  const [reg] = catalogo("contratos", { eco });
  await ejecutarHerramienta(reg, { mensaje_id: "msg-001" }, c);
  const [linea] = fs.readFileSync(path.join(c.directory, "out", "log.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(Object.keys(linea), ["ts", "herramienta", "mensaje_id", "ok", "resumen"]);
  assert.equal(linea.mensaje_id, "msg-001");
  assert.equal(linea.resumen, "eco msg-001");
});
