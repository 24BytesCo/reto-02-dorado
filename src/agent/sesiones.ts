import fs from "node:fs";
import path from "node:path";
import type { Mensaje } from "../llm/adapter.ts";
import type { SesionPublica, TurnoGuardado } from "./tipos.ts";

/**
 * Sesiones del agente en memoria, reflejadas en `out/sesiones/<id>.json` (PRD §6.1: sesiones en memoria o archivo).
 * El historial vive en el backend: el navegador no puede falsificar resultados de herramientas ni una confirmación.
 */

/** Estado completo de una sesión, con el historial crudo del proveedor (no sale por la API). */
export interface Sesion {
  id: string;
  creada: string;
  historial: Mensaje[];
  turnos: TurnoGuardado[];
  tokens: number;
  /** CA3: mensaje del buzón → número del turno en que se pidió su revisión. */
  pendientes: Record<string, number>;
  /** Turnos iniciados; el siguiente turno recibe este número más uno. */
  numeroTurno: number;
}

const ID_VALIDO = /^[\w-]{6,64}$/;

/** Devuelve un error legible si el `sessionId` no es válido, o `null` si lo es (evita rutas raras en `out/sesiones/`). */
export function errorDeId(id: string): string | null {
  return ID_VALIDO.test(id) ? null : "sessionId inválido: usa entre 6 y 64 letras, números, guiones o guiones bajos.";
}

/** Vista pública (GET /api/sessions/:id): sin el historial crudo ni los pendientes internos. */
export function aPublica(s: Sesion): SesionPublica {
  return { id: s.id, creada: s.creada, turnos: s.turnos, tokens: s.tokens };
}

/** Almacén de sesiones: memoria primero, disco al reiniciarse el proceso. */
export class AlmacenSesiones {
  private readonly memoria = new Map<string, Sesion>();

  /** @param carpeta ruta absoluta de `out/sesiones`. */
  constructor(private readonly carpeta: string) {}

  /** Sesión existente (de memoria o recargada de disco), o `null`. */
  obtener(id: string): Sesion | null {
    const enMemoria = this.memoria.get(id);
    if (enMemoria) return enMemoria;
    const archivo = this.archivo(id);
    if (!fs.existsSync(archivo)) return null;
    const sesion = JSON.parse(fs.readFileSync(archivo, "utf8")) as Sesion;
    this.memoria.set(id, sesion);
    return sesion;
  }

  /** Sesión existente o una nueva vacía. */
  obtenerOCrear(id: string): Sesion {
    const existente = this.obtener(id);
    if (existente) return existente;
    const nueva: Sesion = { id, creada: new Date().toISOString(), historial: [], turnos: [], tokens: 0, pendientes: {}, numeroTurno: 0 };
    this.memoria.set(id, nueva);
    return nueva;
  }

  /** Persiste la sesión; escribe a un temporal y renombra para no dejar un JSON a medias si el proceso muere. */
  guardar(s: Sesion): void {
    fs.mkdirSync(this.carpeta, { recursive: true });
    const temporal = `${this.archivo(s.id)}.tmp`;
    fs.writeFileSync(temporal, JSON.stringify(s));
    fs.renameSync(temporal, this.archivo(s.id));
  }

  /** Olvida las sesiones en memoria; borrar `out/` es tarea de la API (POST /api/reset). */
  reiniciar(): void {
    this.memoria.clear();
  }

  private archivo(id: string): string {
    return path.join(this.carpeta, `${id}.json`);
  }
}
