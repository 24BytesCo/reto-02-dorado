/**
 * Verificación sin modelo de lenguaje (PRD §6.6): procesa los 6 mensajes del buzón en orden
 * llamando directamente a las mismas herramientas que usa el agente, con su validación zod y su log.
 * Determinista: limpia out/ al inicio y no imprime marcas de tiempo.
 *
 *   npm run demo        (o: bun run demo.ts)
 */
import { catalogo, ejecutarHerramienta, type Contexto } from "./src/tools/nucleo.ts";
import * as contratos from "./src/tools/contratos.ts";
import { leerMaestro, leerProcesados, limpiarSalida, rutas } from "./src/tools/almacen.ts";
import fs from "node:fs";

const HOY = "2026-09-03";
const ctx: Contexto = { directory: import.meta.dirname, sessionId: "demo" };
const herramientas = new Map(catalogo("contratos", contratos).map((r) => [r.nombre, r]));

interface Respuesta {
  ok: boolean;
  data?: Record<string, unknown>;
  error?: string;
}

/** Llama a una herramienta por el nombre que ve el modelo. */
async function llamar(nombre: string, args: Record<string, unknown>): Promise<Respuesta> {
  const reg = herramientas.get(nombre);
  if (!reg) throw new Error(`no existe la herramienta ${nombre}`);
  return JSON.parse(await ejecutarHerramienta(reg, args, ctx)) as Respuesta;
}

const lista = (v: unknown): string => (Array.isArray(v) && v.length > 0 ? v.join(", ") : "ninguno");

async function procesar(mensaje: { id: string; tiene_contrato: boolean; motivo?: string }): Promise<void> {
  console.log(`\n── ${mensaje.id}`);
  if (mensaje.tiene_contrato) {
    const extraccion = await llamar("contratos_extraer", { mensaje_id: mensaje.id });
    if (!extraccion.ok) console.log(`   extracción: ${extraccion.error}`);
  }
  const validacion = await llamar("contratos_validar", { mensaje_id: mensaje.id, contrato: {} });
  if (!validacion.ok) {
    console.log(`   error: ${validacion.error}`);
    return;
  }
  const v = validacion.data ?? {};
  console.log(`   clasificación:       ${String(v.clasificacion)}`);
  console.log(`   campos en revisión:  ${lista(v.requiere_revision)}`);
  if (v.motivo) console.log(`   motivo:              ${String(v.motivo)}`);
  const registro = await llamar("contratos_registrar", { mensaje_id: mensaje.id, contrato: {} });
  console.log(`   acción:              ${registro.ok ? String(registro.data?.accion) : `sin registrar (${registro.error})`}`);
  if (registro.ok && registro.data?.ruta_archivo) console.log(`   archivo:             ${String(registro.data.ruta_archivo)}`);
}

limpiarSalida(ctx);
console.log("Demo sin modelo · reto 02 · Periferia IT Group");
console.log(`Fecha de referencia para alertas: ${HOY}`);

const buzon = await llamar("contratos_leer_buzon", {});
const mensajes = (buzon.data?.mensajes ?? []) as Array<{ id: string; tiene_contrato: boolean; motivo?: string }>;
console.log(`\nPrimera pasada: ${mensajes.length} mensajes`);
for (const m of mensajes) await procesar(m);

console.log("\nSegunda pasada: la analista confirma msg-006 (valor 0 y fecha fin 2027-08-31)");
const confirmado = await llamar("contratos_registrar", {
  mensaje_id: "msg-006",
  contrato: { valor: 0, fecha_fin: "2027-08-31" },
  confirmado: true,
});
console.log(`   acción: ${confirmado.ok ? String(confirmado.data?.accion) : confirmado.error}`);

const alertas = await llamar("contratos_alertas", { hoy: HOY });
if (alertas.ok) {
  const a = alertas.data ?? {};
  const ids = (x: unknown) => lista(Array.isArray(x) ? x.map((c: { id_contrato: string }) => c.id_contrato) : []);
  console.log(`\nAlertas (${String(a.ruta)}):`);
  console.log(`   vencen en ≤ 60 días:        ${ids(a.vencen)}`);
  console.log(`   pólizas pendientes:         ${ids(a.polizas_pendientes)}`);
  console.log(`   registrados desde el corte: ${ids(a.registrados_desde_corte)}`);
} else console.log(`\nAlertas: ${alertas.error}`);

const historial = fs.existsSync(rutas(ctx).historial) ? fs.readFileSync(rutas(ctx).historial, "utf8").trim().split("\n").length : 0;
console.log(`\nResultado: maestro con ${leerMaestro(ctx).length} filas, ${historial} líneas de historial, ${Object.keys(leerProcesados(ctx)).length} mensajes procesados.`);
