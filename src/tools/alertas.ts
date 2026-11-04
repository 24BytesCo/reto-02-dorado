import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { fechaIso } from "./extraccion.ts";
import { leerMaestro, rutas } from "./almacen.ts";
import type { Contexto } from "./nucleo.ts";
import { REGLAS, type FilaMaestro } from "./reglas.ts";

/** Argumentos de `contratos_alertas` (HU-5): la fecha de referencia se inyecta, nunca se lee del reloj. */
export const argsAlertas = {
  hoy: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "formato esperado YYYY-MM-DD")
    .describe("Fecha de referencia del reporte en formato YYYY-MM-DD, p. ej. 2026-09-03; se pasa como argumento para que el resultado sea determinista"),
};

/** Contrato que vence dentro de la ventana de alerta (HU-5, sección 1). */
export interface Vence { id_contrato: string; cliente: string; fecha_fin: string; dias_restantes: number; comercial: string }
/** Contrato con póliza exigida y no vigente (HU-5, sección 2). */
export interface PolizaPendiente { id_contrato: string; cliente: string; tipo_poliza: string; estado_poliza: string; comercial: string }
/** Contrato registrado desde la fecha de corte del maestro (HU-5, sección 3). */
export interface RegistradoDesdeCorte { id_contrato: string; cliente: string; fecha_registro: string; fuente: string }
/** Contrato cuya fecha de fin ya pasó (HU-5, subsección de la sección 1; S14). */
export interface Vencido { id_contrato: string; cliente: string; fecha_fin: string; dias_restantes: number }

/** Resultado de `contratos_alertas` (PRD §6.2). */
export interface ResultadoAlertas {
  ruta: string;
  vencen: Vence[];
  polizas_pendientes: PolizaPendiente[];
  registrados_desde_corte: RegistradoDesdeCorte[];
  vencidos: Vencido[];
  resumen: string;
}

const MS_DIA = 86_400_000;

/** Valida `hoy` como fecha real del calendario; "2026-02-31" da un error legible (HU-6). */
function validarHoy(hoy: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(hoy)) throw new Error(`la fecha de referencia «${hoy}» no tiene el formato YYYY-MM-DD`);
  const [a, m, d] = hoy.split("-").map(Number);
  try {
    fechaIso(a, m, d);
  } catch {
    throw new Error(`la fecha de referencia «${hoy}» no existe en el calendario`);
  }
}

const aMs = (iso: string): number => {
  const [a, m, d] = iso.split("-").map(Number);
  return Date.UTC(a, m - 1, d);
};

/** Días entre dos fechas ISO (positivo si `fin` es posterior), calculados en UTC sin reloj. */
function diasEntre(desde: string, fin: string): number {
  return Math.round((aMs(fin) - aMs(desde)) / MS_DIA);
}

/** Sección 1: contratos con 0 ≤ días ≤ ventana, del más próximo al más lejano (HU-5). */
function calcularVencen(filas: FilaMaestro[], hoy: string): Vence[] {
  return filas
    .filter((f) => f.fecha_fin !== "")
    .map((f) => ({ id_contrato: f.id_contrato, cliente: f.cliente, fecha_fin: f.fecha_fin, dias_restantes: diasEntre(hoy, f.fecha_fin), comercial: f.comercial }))
    .filter((c) => c.dias_restantes >= 0 && c.dias_restantes <= REGLAS.diasAlertaVencimiento)
    .sort((a, b) => a.dias_restantes - b.dias_restantes || a.id_contrato.localeCompare(b.id_contrato));
}

/** Subsección de la sección 1: fecha de fin ya pasada, la más reciente primero (S14). */
function calcularVencidos(filas: FilaMaestro[], hoy: string): Vencido[] {
  return filas
    .filter((f) => f.fecha_fin !== "")
    .map((f) => ({ id_contrato: f.id_contrato, cliente: f.cliente, fecha_fin: f.fecha_fin, dias_restantes: diasEntre(hoy, f.fecha_fin) }))
    .filter((c) => c.dias_restantes < 0)
    .sort((a, b) => b.dias_restantes - a.dias_restantes || a.id_contrato.localeCompare(b.id_contrato));
}

/** Sección 2: `requiere_poliza = true` y `estado_poliza != vigente` (HU-5). */
function calcularPolizasPendientes(filas: FilaMaestro[]): PolizaPendiente[] {
  return filas
    .filter((f) => f.requiere_poliza === "true" && f.estado_poliza !== "vigente")
    .map((f) => ({ id_contrato: f.id_contrato, cliente: f.cliente, tipo_poliza: f.tipo_poliza, estado_poliza: f.estado_poliza, comercial: f.comercial }));
}

/** Sección 3: `fecha_registro` en o después de la fecha de corte del maestro congelado (HU-5). */
function calcularRegistrados(filas: FilaMaestro[]): RegistradoDesdeCorte[] {
  return filas
    .filter((f) => f.fecha_registro >= REGLAS.fechaCorte)
    .map((f) => ({ id_contrato: f.id_contrato, cliente: f.cliente, fecha_registro: f.fecha_registro, fuente: f.fuente }))
    .sort((a, b) => a.fecha_registro.localeCompare(b.fecha_registro) || a.id_contrato.localeCompare(b.id_contrato));
}

/** Tabla Markdown; sin filas devuelve una línea explícita para que gerencia vea que se revisó. */
function tabla(cabeceras: string[], filas: string[][], vacio: string): string {
  if (filas.length === 0) return `_${vacio}_`;
  const celda = (v: string) => v.replace(/\|/g, "\\|") || "—";
  const linea = (c: string[]) => `| ${c.map(celda).join(" | ")} |`;
  return [linea(cabeceras), linea(cabeceras.map(() => "---")), ...filas.map(linea)].join("\n");
}

/** Markdown con exactamente tres secciones `## ` (HU-5); los vencidos van dentro de la primera. */
function renderizar(hoy: string, r: Omit<ResultadoAlertas, "ruta" | "resumen">): string {
  const ventana = REGLAS.diasAlertaVencimiento;
  return [
    "# Alertas de contratos",
    "",
    `Fecha de referencia: **${hoy}**.`,
    "",
    `## Vencen en ≤ ${ventana} días`,
    "",
    tabla(["Contrato", "Cliente", "Fecha fin", "Días restantes", "Comercial"],
      r.vencen.map((c) => [c.id_contrato, c.cliente, c.fecha_fin, String(c.dias_restantes), c.comercial]),
      `Ningún contrato vence en los próximos ${ventana} días.`),
    "",
    "### Vencidos sin renovación registrada",
    "",
    tabla(["Contrato", "Cliente", "Fecha fin", "Días restantes"],
      r.vencidos.map((c) => [c.id_contrato, c.cliente, c.fecha_fin, String(c.dias_restantes)]),
      "Ningún contrato vencido."),
    "",
    "## Pólizas pendientes (requiere_poliza = true y estado_poliza != vigente)",
    "",
    tabla(["Contrato", "Cliente", "Tipo de póliza", "Estado", "Comercial"],
      r.polizas_pendientes.map((c) => [c.id_contrato, c.cliente, c.tipo_poliza, c.estado_poliza, c.comercial]),
      "Ninguna póliza pendiente."),
    "",
    `## Registrados desde el ${REGLAS.fechaCorte} (gap cubierto)`,
    "",
    tabla(["Contrato", "Cliente", "Fecha de registro", "Fuente"],
      r.registrados_desde_corte.map((c) => [c.id_contrato, c.cliente, c.fecha_registro, c.fuente]),
      "Ningún contrato registrado desde el corte."),
    "",
  ].join("\n");
}

/**
 * Genera el reporte de riesgos para gerencia (HU-5): vencimientos en la ventana, pólizas
 * pendientes y registros desde el corte. Lee la copia del maestro en `out/` (RN6) y escribe
 * `out/alertas.md`. Es determinista: todo se calcula desde `hoy`, sin reloj (regla 11).
 * @param hoy fecha de referencia YYYY-MM-DD; debe existir en el calendario.
 * @throws Error legible si `hoy` es inválida (HU-6).
 */
export function generarAlertas(ctx: Contexto, hoy: string): ResultadoAlertas {
  validarHoy(hoy);
  const filas = leerMaestro(ctx);
  const partes = {
    vencen: calcularVencen(filas, hoy),
    polizas_pendientes: calcularPolizasPendientes(filas),
    registrados_desde_corte: calcularRegistrados(filas),
    vencidos: calcularVencidos(filas, hoy),
  };
  const destino = rutas(ctx).alertas;
  fs.mkdirSync(path.dirname(destino), { recursive: true });
  fs.writeFileSync(destino, renderizar(hoy, partes));
  const resumen = `${partes.vencen.length} vencen en ≤ ${REGLAS.diasAlertaVencimiento} días, ${partes.vencidos.length} vencidos, ${partes.polizas_pendientes.length} pólizas pendientes, ${partes.registrados_desde_corte.length} registrados desde el corte (referencia ${hoy})`;
  return { ruta: path.relative(path.resolve(ctx.directory), destino).split(path.sep).join("/"), ...partes, resumen };
}
