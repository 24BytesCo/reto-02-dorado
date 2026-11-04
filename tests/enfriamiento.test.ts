import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { crearEnfriamiento, enfriamientoDeEntorno } from "../src/enfriamiento.ts";
import { crearApp } from "../src/server.ts";
import type { MotorAgente, ResultadoTurno } from "../src/agent/tipos.ts";
import { proyectoTemporal } from "./ayudas.ts";

const opciones = { umbral: 3, minutosBase: 5, maximoMinutos: 60 };

test("tras el umbral de turnos sin trabajo, la conexión queda en pausa 5 minutos", () => {
  let t = 0;
  const e = crearEnfriamiento(opciones, () => t);
  assert.equal(e.registrar("ip", false), 0);
  assert.equal(e.registrar("ip", false), 0);
  assert.equal(e.registrar("ip", false), 300);
  assert.equal(e.bloqueo("ip"), 300);
  t = 300_000;
  assert.equal(e.bloqueo("ip"), 0);
});

test("un turno con trabajo real reinicia el contador", () => {
  const e = crearEnfriamiento(opciones, () => 0);
  e.registrar("ip", false);
  e.registrar("ip", false);
  e.registrar("ip", true);
  assert.equal(e.registrar("ip", false), 0);
  assert.equal(e.bloqueo("ip"), 0);
});

test("cada reincidencia triplica la pausa hasta el techo, y cada IP lleva su propia cuenta", () => {
  let t = 0;
  const e = crearEnfriamiento(opciones, () => t);
  const pausas: number[] = [];
  for (let i = 0; i < 4; i++) {
    let p = 0;
    for (let j = 0; j < 3; j++) p = e.registrar("ip", false);
    pausas.push(p / 60);
    t += p * 1000;
  }
  assert.deepEqual(pausas, [5, 15, 45, 60]);
  assert.equal(e.bloqueo("otra-ip"), 0);
});

test("con umbral 0 queda desactivado, y la configuración se lee del entorno", () => {
  const e = crearEnfriamiento({ ...opciones, umbral: 0 }, () => 0);
  for (let i = 0; i < 10; i++) assert.equal(e.registrar("ip", false), 0);
  assert.deepEqual(enfriamientoDeEntorno({}), { umbral: 6, minutosBase: 5, maximoMinutos: 1440 });
  assert.deepEqual(enfriamientoDeEntorno({ ENFRIAMIENTO_UMBRAL: "0" }).umbral, 0);
});

/** Motor falso: responde sin herramientas, como un agente que solo conversa. */
const motorConversador: MotorAgente = {
  async turno(): Promise<ResultadoTurno> {
    return { reply: "Esta herramienta es solo para el registro de contratos.", toolCalls: [], needsConfirmation: false, pendientes: [] };
  },
  sesion: () => null,
  reiniciar: () => undefined,
};

test("la API pone en pausa a la conexión que encadena mensajes fuera de propósito (429 con el aviso)", async () => {
  const app = crearApp(motorConversador, proyectoTemporal().directory, { enfriamiento: { umbral: 2, minutosBase: 5, maximoMinutos: 60 } });
  const servidor = app.listen(0);
  try {
    const url = `http://127.0.0.1:${(servidor.address() as AddressInfo).port}/api/chat`;
    const enviar = (message: string) =>
      fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionId: "sesion-enfriamiento", message }) });
    assert.equal((await enviar("cuanto es 2+2")).status, 200);
    assert.equal((await enviar("que dia es hoy")).status, 200);
    const bloqueada = await enviar("cuentame un chiste");
    assert.equal(bloqueada.status, 429);
    assert.equal(bloqueada.headers.get("retry-after"), "300");
    assert.match(((await bloqueada.json()) as { error: string }).error, /solo para el registro de contratos.*en pausa 5 min/);
  } finally {
    servidor.close();
  }
});
