import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { extraer } from "../src/tools/contratos.ts";
import { RAIZ, proyectoTemporal } from "./ayudas.ts";

interface CampoJson { valor: unknown; confianza: number }
const extraerDe = async (id: string) => JSON.parse(await extraer.execute({ mensaje_id: id }, proyectoTemporal()));
const valores = (c: Record<string, CampoJson>, campos: string[]) => Object.fromEntries(campos.map((k) => [k, c[k].valor]));

test("msg-001: contrato completo con póliza, todo con confianza ≥ 0,8", async () => {
  const r = await extraerDe("msg-001");
  const c = r.data.contrato;
  assert.deepEqual(valores(c, ["id_contrato", "cliente", "nit_cliente", "pais", "valor", "moneda", "fecha_inicio", "fecha_fin", "requiere_poliza", "tipo_poliza", "estado_poliza", "comercial"]), {
    id_contrato: "CT-2026-015", cliente: "Industrias Delta S.A.S.", nit_cliente: "890900111", pais: "CO",
    valor: 265000000, moneda: "COP", fecha_inicio: "2026-08-01", fecha_fin: "2027-07-31",
    requiere_poliza: true, tipo_poliza: "cumplimiento", estado_poliza: "pendiente", comercial: "Laura Gómez Restrepo",
  });
  for (const k of ["id_contrato", "cliente", "nit_cliente", "pais", "objeto", "valor", "moneda", "fecha_inicio", "fecha_fin", "requiere_poliza"]) {
    assert.ok(c[k].confianza >= 0.8, `${k} con confianza ${c[k].confianza}`);
  }
});

test("msg-002: RUC de Ecuador intacto, dólares con formato 120,000.00 y sin póliza", async () => {
  const c = (await extraerDe("msg-002")).data.contrato;
  assert.deepEqual(valores(c, ["nit_cliente", "pais", "valor", "moneda", "fecha_fin", "requiere_poliza", "estado_poliza"]), {
    nit_cliente: "1790012345001", pais: "EC", valor: 120000, moneda: "USD", fecha_fin: "2027-08-14", requiere_poliza: false, estado_poliza: "no_aplica",
  });
});

test("msg-003: el otrosí apunta al contrato que modifica, no al número del otrosí, y lo ausente es null con confianza 0", async () => {
  const r = (await extraerDe("msg-003")).data;
  assert.equal(r.tipo_documento, "otrosi");
  assert.equal(r.numero_otrosi, 1);
  assert.deepEqual(valores(r.contrato, ["id_contrato", "valor", "moneda", "fecha_fin"]), { id_contrato: "CT-2026-011", valor: 520000, moneda: "PEN", fecha_fin: "2027-11-01" });
  assert.deepEqual(r.contrato.objeto, { valor: null, confianza: 0 });
});

test("msg-006: valor por demanda y plazo en meses quedan con confianza < 0,8; el resto no", async () => {
  const r = (await extraerDe("msg-006")).data;
  const c = r.contrato;
  assert.equal(r.valor_indeterminado, true);
  assert.deepEqual(valores(c, ["id_contrato", "valor", "moneda", "fecha_inicio", "fecha_fin", "requiere_poliza"]), {
    id_contrato: "CM-2026-03", valor: 0, moneda: "COP", fecha_inicio: "2026-08-31", fecha_fin: "2027-08-31", requiere_poliza: false,
  });
  const bajos = ["id_contrato", "cliente", "nit_cliente", "pais", "objeto", "valor", "moneda", "fecha_inicio", "fecha_fin", "requiere_poliza", "tipo_poliza"].filter((k) => c[k].confianza < 0.8);
  assert.deepEqual(bajos, ["valor", "fecha_fin"]);
  assert.ok(c.objeto.valor.length <= 200);
  assert.ok(r.advertencias.some((a: string) => a.includes("jperez@periferia-ficticia.com")));
});

test("msg-005: la cotización no se extrae, devuelve { ok: false } con el motivo", async () => {
  const r = await extraerDe("msg-005");
  assert.equal(r.ok, false);
  assert.match(r.error, /cotización/);
});

test("ninguna regla del extractor está escrita para un mensaje o contrato concreto", () => {
  for (const archivo of ["src/tools/extraccion.ts", "src/tools/contratos.ts"]) {
    const codigo = fs.readFileSync(path.join(RAIZ, archivo), "utf8");
    assert.doesNotMatch(codigo, /msg-0\d\d|CT-20\d\d|CM-20\d\d/, archivo);
  }
});
