/**
 * Contrato entre el ciclo del agente (src/agent/) y la API HTTP (src/server.ts).
 * Ninguno de los dos depende de los tipos del proveedor LLM.
 */

/** Llamada a herramienta tal como se muestra en el chat (PRD §6.1: nombre, argumentos y resultado resumido). */
export interface LlamadaVisible {
  id: string;
  nombre: string;
  argumentos: unknown;
  ok: boolean;
  resumen: string;
}

/** Eventos que el ciclo emite mientras trabaja; la API los reenvía como stream al front. */
export type EventoAgente =
  | { tipo: "texto"; texto: string }
  | { tipo: "herramienta"; id: string; nombre: string; argumentos: unknown }
  | { tipo: "resultado"; id: string; nombre: string; ok: boolean; resumen: string }
  | { tipo: "error"; mensaje: string }
  | { tipo: "uso"; entrada: number; salida: number; cacheLeida: number; costoUsd: number };

/** Respuesta de un turno (PRD §6.4: `{ reply, toolCalls[], needsConfirmation }`). */
export interface ResultadoTurno {
  reply: string;
  toolCalls: LlamadaVisible[];
  /** CA3: el turno terminó con una pregunta de confirmación pendiente; se calcula en código. */
  needsConfirmation: boolean;
  /** Mensajes del buzón que esperan confirmación de la analista. */
  pendientes: string[];
  /** Lo agrega la API: aviso de uso fuera de propósito, calculado en código, para que el front lo muestre. */
  aviso?: string;
}

/** Un turno de la conversación, como lo devuelve `GET /api/sessions/:id`. */
export interface TurnoGuardado extends ResultadoTurno {
  ts: string;
  usuario: string;
}

/** Vista pública de una sesión: sin el historial crudo del proveedor. */
export interface SesionPublica {
  id: string;
  creada: string;
  turnos: TurnoGuardado[];
  tokens: number;
}

/** Lo que la API necesita del ciclo del agente. */
export interface MotorAgente {
  /** Ejecuta un turno completo; `emitir` recibe cada paso para el stream. Nunca lanza: los errores vuelven en `reply`. */
  turno(sessionId: string, mensaje: string, emitir?: (evento: EventoAgente) => void): Promise<ResultadoTurno>;
  /** Historial de una sesión, o `null` si no existe. */
  sesion(sessionId: string): SesionPublica | null;
  /** Olvida todas las sesiones (el reinicio de `out/` lo hace la API). */
  reiniciar(): void;
}
