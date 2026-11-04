/**
 * Enfriamiento por uso fuera de propósito (PRD §8 Costo).
 * El agente solo atiende el registro de contratos. Un turno cuenta como fuera de propósito solo si no usó ninguna
 * herramienta, no dejó pendientes ni pidió confirmación y el mensaje no trae vocabulario del dominio (ver
 * `turnoConProposito`): una pregunta sobre un contrato o una confirmación nunca suman. Si una misma conexión
 * encadena `umbral` turnos fuera de propósito (12 por defecto), queda en pausa un tiempo que crece con cada
 * reincidencia (base, ×3, ×9…, hasta `maximoMinutos`). Un turno con propósito reinicia el contador.
 * No llama al modelo: no cuesta nada aplicarlo.
 */

/** Palabras que delatan una pregunta del dominio aunque el agente no haya usado herramientas. */
const VOCABULARIO_DOMINIO = /contrato|buz[oó]n|maestro|alerta|p[oó]liza|registra|confirmo|msg-/i;

/** Lo que el enfriamiento necesita del resultado de un turno (subconjunto de `ResultadoTurno`). */
export interface TurnoEvaluable {
  toolCalls: readonly unknown[];
  pendientes: readonly string[];
  needsConfirmation: boolean;
}

/**
 * `true` si el turno tiene que ver con el registro de contratos (PRD §8 Costo): usó herramientas, dejó pendientes o
 * pidió confirmación (CA3), o el mensaje de la analista habla del dominio (contrato, buzón, maestro, alerta, póliza,
 * registra, confirmo, msg-…). Solo los turnos que no cumplen nada de esto acercan la pausa.
 */
export function turnoConProposito(mensaje: string, resultado: TurnoEvaluable): boolean {
  if (resultado.toolCalls.length > 0 || resultado.pendientes.length > 0 || resultado.needsConfirmation) return true;
  return VOCABULARIO_DOMINIO.test(mensaje);
}

export interface OpcionesEnfriamiento {
  /** Turnos seguidos sin herramientas que activan la pausa (0 la desactiva). */
  umbral: number;
  /** Minutos de la primera pausa; cada reincidencia la multiplica por 3. */
  minutosBase: number;
  /** Techo de la pausa, en minutos. */
  maximoMinutos: number;
}

interface Estado {
  seguidos: number;
  nivel: number;
  hasta: number;
}

/** Límite de enfriamiento en memoria por clave (la IP). Se reinicia con el proceso. */
export interface Enfriamiento {
  /** Segundos de pausa que le quedan a la clave; 0 si puede seguir. */
  bloqueo(clave: string): number;
  /**
   * Registra cómo terminó un turno.
   * @param conTrabajo el turno tuvo propósito (`turnoConProposito`): reinicia el contador.
   * @returns `pausa`: segundos de la pausa si este turno la activó (0 si no); `seguidos`: turnos seguidos sin trabajo que
   * lleva la conexión después de este; `umbral`: cuántos activan la pausa (0 si está desactivada).
   */
  registrar(clave: string, conTrabajo: boolean): { pausa: number; seguidos: number; umbral: number };
}

const MINUTO_MS = 60_000;

/**
 * Crea el enfriamiento.
 * @param ahora reloj inyectable para las pruebas.
 */
export function crearEnfriamiento(opciones: OpcionesEnfriamiento, ahora: () => number = Date.now): Enfriamiento {
  const estados = new Map<string, Estado>();
  return {
    bloqueo(clave) {
      const e = estados.get(clave);
      const t = ahora();
      return e && e.hasta > t ? Math.ceil((e.hasta - t) / 1000) : 0;
    },
    registrar(clave, conTrabajo) {
      const umbral = opciones.umbral;
      if (umbral <= 0) return { pausa: 0, seguidos: 0, umbral: 0 };
      const e = estados.get(clave) ?? { seguidos: 0, nivel: 0, hasta: 0 };
      estados.set(clave, e);
      if (conTrabajo) {
        e.seguidos = 0;
        return { pausa: 0, seguidos: 0, umbral };
      }
      e.seguidos += 1;
      if (e.seguidos < umbral) return { pausa: 0, seguidos: e.seguidos, umbral };
      const minutos = Math.min(opciones.minutosBase * 3 ** e.nivel, opciones.maximoMinutos);
      e.hasta = ahora() + minutos * MINUTO_MS;
      e.nivel += 1;
      e.seguidos = 0;
      return { pausa: minutos * 60, seguidos: umbral, umbral };
    },
  };
}

/** Umbral por defecto: holgado para que una defensa con preguntas legítimas sin herramientas no quede bloqueada. */
export const UMBRAL_POR_DEFECTO = 12;

/**
 * Configuración desde el entorno: ENFRIAMIENTO_UMBRAL (12; 0 si `LLM_PROVEEDOR=simulado`, donde el chat responde un
 * texto fijo sin herramientas y bloquearía al usuario local), ENFRIAMIENTO_MINUTOS (5) y ENFRIAMIENTO_MAXIMO_MINUTOS
 * (1440). Una variable vacía o inválida toma su valor por defecto.
 */
export function enfriamientoDeEntorno(entorno: NodeJS.ProcessEnv = process.env): OpcionesEnfriamiento {
  const entero = (valor: string | undefined, porDefecto: number) => {
    const n = Number(valor);
    return valor !== undefined && valor.trim() !== "" && Number.isInteger(n) && n >= 0 ? n : porDefecto;
  };
  const simulado = (entorno.LLM_PROVEEDOR ?? "").trim().toLowerCase() === "simulado";
  return {
    umbral: entero(entorno.ENFRIAMIENTO_UMBRAL, simulado ? 0 : UMBRAL_POR_DEFECTO),
    minutosBase: Math.max(1, entero(entorno.ENFRIAMIENTO_MINUTOS, 5)),
    maximoMinutos: Math.max(1, entero(entorno.ENFRIAMIENTO_MAXIMO_MINUTOS, 1440)),
  };
}
