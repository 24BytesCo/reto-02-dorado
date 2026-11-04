import { test } from "node:test";
import assert from "node:assert/strict";
import { leer_buzon } from "../src/tools/contratos.ts";
import { marcarProcesado } from "../src/tools/almacen.ts";
import { tipoDocumento } from "../src/tools/extraccion.ts";
import { proyectoTemporal } from "./ayudas.ts";

interface Mensaje { id: string; tiene_contrato: boolean; clasificacion?: string; motivo?: string; de: string; asunto: string; fecha: string; adjuntos: string[] }
const leer = async (ctx = proyectoTemporal()): Promise<Mensaje[]> => JSON.parse(await leer_buzon.execute({}, ctx)).data.mensajes;

test("HU-1: lista los 6 mensajes con { id, de, asunto, fecha, adjuntos, tiene_contrato }", async () => {
  const mensajes = await leer();
  assert.deepEqual(mensajes.map((m) => m.id), ["msg-001", "msg-002", "msg-003", "msg-004", "msg-005", "msg-006"]);
  for (const k of ["id", "de", "asunto", "fecha", "adjuntos", "tiene_contrato"]) assert.ok(k in mensajes[0], k);
});

test("HU-1: la cotización (msg-005) sale sin contrato, rechazada y con motivo", async () => {
  const m = (await leer()).find((x) => x.id === "msg-005")!;
  assert.equal(m.tiene_contrato, false);
  assert.equal(m.clasificacion, "rechazado");
  assert.match(m.motivo!, /cotización/);
});

test("el otrosí (msg-003) cuenta como documento contractual aunque el adjunto no se llame contrato.txt", async () => {
  const m = (await leer()).find((x) => x.id === "msg-003")!;
  assert.equal(m.tiene_contrato, true);
});

test("se reconoce «OTROSÍ» con tilde: \\b de JavaScript no sirve tras letras acentuadas", () => {
  assert.equal(tipoDocumento("OTROSÍ No. 1 AL CONTRATO\n\nEntre A y B"), "otrosi");
  assert.equal(tipoDocumento("COTIZACIÓN No. 1\nCliente: X"), null);
});

test("HU-1: un mensaje ya procesado no vuelve a aparecer", async () => {
  const ctx = proyectoTemporal();
  marcarProcesado(ctx, "msg-004", "duplicado", "CT-2026-012");
  assert.ok(!(await leer(ctx)).some((m) => m.id === "msg-004"));
});
