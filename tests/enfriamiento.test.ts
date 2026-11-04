import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { crearEnfriamiento, enfriamientoDeEntorno, turnoConProposito } from "../src/enfriamiento.ts";
import { crearApp } from "../src/server.ts";
import type { MotorAgente, ResultadoTurno } from "../src/agent/tipos.ts";
import { proyectoTemporal } from "./ayudas.ts";

const opciones = { umbral: 3, minutosBase: 5, maximoMinutos: 60 };

test("tras el umbral de turnos sin trabajo, la conexión queda en pausa 5 minutos", () => {
  let t = 0;
  const e = crearEnfriamiento(opciones, () => t);
  assert.deepEqual(e.registrar("ip", false), { pausa: 0, seguidos: 1, umbral: 3 });
  assert.deepEqual(e.registrar("ip", false), { pausa: 0, seguidos: 2, umbral: 3 });
  assert.equal(e.registrar("ip", false).pausa, 300);
  assert.equal(e.bloqueo("ip"), 300);
  t = 300_000;
  assert.equal(e.bloqueo("ip"), 0);
});

test("un turno con trabajo real reinicia el contador", () => {
  const e = crearEnfriamiento(opciones, () => 0);
  e.registrar("ip", false);
  e.registrar("ip", false);
  assert.equal(e.registrar("ip", true).seguidos, 0);
  assert.equal(e.registrar("ip", false).pausa, 0);
  assert.equal(e.bloqueo("ip"), 0);
});

test("cada reincidencia triplica la pausa hasta el techo, y cada IP lleva su propia cuenta", () => {
  let t = 0;
  const e = crearEnfriamiento(opciones, () => t);
  const pausas: number[] = [];
  for (let i = 0; i < 4; i++) {
    let p = 0;
    for (let j = 0; j < 3; j++) p = e.registrar("ip", false).pausa;
    pausas.push(p / 60);
    t += p * 1000;
  }
  assert.deepEqual(pausas, [5, 15, 45, 60]);
  assert.equal(e.bloqueo("otra-ip"), 0);
});

test("con umbral 0 queda desactivado, y la configuración se lee del entorno", () => {
  const e = crearEnfriamiento({ ...opciones, umbral: 0 }, () => 0);
  for (let i = 0; i < 10; i++) assert.equal(e.registrar("ip", false).pausa, 0);
  assert.deepEqual(enfriamientoDeEntorno({}), { umbral: 12, minutosBase: 5, maximoMinutos: 1440 });
  assert.deepEqual(enfriamientoDeEntorno({ ENFRIAMIENTO_UMBRAL: "0" }).umbral, 0);
});

test("C9: umbral 12 por defecto (también con la variable vacía), 0 con el modo simulado salvo que ENFRIAMIENTO_UMBRAL lo fije", () => {
  assert.equal(enfriamientoDeEntorno({ ENFRIAMIENTO_UMBRAL: "" }).umbral, 12);
  assert.equal(enfriamientoDeEntorno({ LLM_PROVEEDOR: "simulado" }).umbral, 0);
  assert.equal(enfriamientoDeEntorno({ LLM_PROVEEDOR: " Simulado ", ENFRIAMIENTO_UMBRAL: "" }).umbral, 0);
  assert.equal(enfriamientoDeEntorno({ LLM_PROVEEDOR: "simulado", ENFRIAMIENTO_UMBRAL: "4" }).umbral, 4);
  assert.deepEqual(enfriamientoDeEntorno({ ENFRIAMIENTO_MINUTOS: "", ENFRIAMIENTO_MAXIMO_MINUTOS: "" }), { umbral: 12, minutosBase: 5, maximoMinutos: 1440 });
});

test("C9: no cuenta como fuera de propósito un turno con pendientes, que pide confirmación o que habla del dominio", () => {
  const vacio = { toolCalls: [], pendientes: [], needsConfirmation: false };
  assert.equal(turnoConProposito("cuéntame un chiste", vacio), false);
  assert.equal(turnoConProposito("¿y eso?", { ...vacio, pendientes: ["msg-006"] }), true);
  assert.equal(turnoConProposito("ok", { ...vacio, needsConfirmation: true }), true);
  assert.equal(turnoConProposito("x", { ...vacio, toolCalls: [{}] }), true);
  for (const m of ["¿Qué significa estado_poliza pendiente?", "¿Por qué msg-004 es duplicado?", "¿Cuántos hay en el BUZON?",
    "¿Qué pasa con la póliza?", "¿qué vence en las alertas?", "¿el maestro se toca?", "Registra todo", "Confirmo", "¿cuál es el contrato?"]) {
    assert.equal(turnoConProposito(m, vacio), true, m);
  }
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
  const app = crearApp(motorConversador, proyectoTemporal().directory, { enfriamiento: { umbral: 3, minutosBase: 5, maximoMinutos: 60 } });
  const servidor = app.listen(0);
  try {
    const url = `http://127.0.0.1:${(servidor.address() as AddressInfo).port}/api/chat`;
    const enviar = (message: string) =>
      fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionId: "sesion-enfriamiento", message }) });
    const primero = (await (await enviar("cuanto es 2+2")).json()) as { aviso?: string };
    assert.equal(primero.aviso, undefined, "el primer mensaje fuera de propósito no avisa todavía");
    const segundo = (await (await enviar("que dia es hoy")).json()) as { aviso?: string };
    assert.match(segundo.aviso ?? "", /Llevas 2 de 3 mensajes seguidos.*pausa 5 min/, "el segundo avisa cuánto falta para la pausa");
    assert.equal((await enviar("cuentame un chiste")).status, 200, "el tercero se atiende y activa la pausa");
    const bloqueada = await enviar("otra cosa");
    assert.equal(bloqueada.status, 429);
    assert.equal(bloqueada.headers.get("retry-after"), "300");
    assert.match(((await bloqueada.json()) as { error: string }).error, /solo para el registro de contratos.*en pausa 5 min/);
  } finally {
    servidor.close();
  }
});

test("C9: preguntas legítimas del dominio sin herramientas no ponen en pausa (la defensa no se bloquea)", async () => {
  const app = crearApp(motorConversador, proyectoTemporal().directory, { enfriamiento: { umbral: 3, minutosBase: 5, maximoMinutos: 60 } });
  const servidor = app.listen(0);
  try {
    const url = `http://127.0.0.1:${(servidor.address() as AddressInfo).port}/api/chat`;
    const enviar = (message: string) =>
      fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionId: "sesion-dominio", message }) });
    const preguntas = ["¿Qué significa estado_poliza pendiente?", "¿Por qué msg-004 es duplicado?", "¿Qué hace el maestro?",
      "¿Dónde queda el otrosí del contrato?", "¿Qué pasa con una póliza vencida?", "¿Cuántas alertas hay?", "Procesa el buzón"];
    for (const p of preguntas) {
      const r = await enviar(p);
      assert.equal(r.status, 200, p);
      assert.equal(((await r.json()) as { aviso?: string }).aviso, undefined, p);
    }
  } finally {
    servidor.close();
  }
});
