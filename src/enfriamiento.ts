/**
 * Enfriamiento por uso fuera de propósito (PRD §8 Costo).
 * El agente solo atiende el registro de contratos; un turno en el que no usó ninguna herramienta es
 * conversación sin trabajo. Si una misma conexión encadena `umbral` turnos así, queda en pausa un
 * tiempo que crece con cada reincidencia (base, ×3, ×9…, hasta `maximoMinutos`). Un turno con trabajo
 * real reinicia el contador. No llama al modelo: no cuesta nada aplicarlo.
 */

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
   * Registra cómo terminó un turno. Devuelve los segundos de la pausa si este turno la activó; si no, 0.
   * @param conTrabajo el agente usó al menos una herramienta en el turno.
   */
  registrar(clave: string, conTrabajo: boolean): number;
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
      if (opciones.umbral <= 0) return 0;
      const e = estados.get(clave) ?? { seguidos: 0, nivel: 0, hasta: 0 };
      estados.set(clave, e);
      if (conTrabajo) {
        e.seguidos = 0;
        return 0;
      }
      e.seguidos += 1;
      if (e.seguidos < opciones.umbral) return 0;
      const minutos = Math.min(opciones.minutosBase * 3 ** e.nivel, opciones.maximoMinutos);
      e.hasta = ahora() + minutos * MINUTO_MS;
      e.nivel += 1;
      e.seguidos = 0;
      return minutos * 60;
    },
  };
}

/** Configuración desde el entorno: ENFRIAMIENTO_UMBRAL (6), ENFRIAMIENTO_MINUTOS (5), ENFRIAMIENTO_MAXIMO_MINUTOS (1440). */
export function enfriamientoDeEntorno(entorno: NodeJS.ProcessEnv = process.env): OpcionesEnfriamiento {
  const entero = (valor: string | undefined, porDefecto: number) => {
    const n = Number(valor);
    return valor !== undefined && valor.trim() !== "" && Number.isInteger(n) && n >= 0 ? n : porDefecto;
  };
  return {
    umbral: entero(entorno.ENFRIAMIENTO_UMBRAL, 6),
    minutosBase: Math.max(1, entero(entorno.ENFRIAMIENTO_MINUTOS, 5)),
    maximoMinutos: Math.max(1, entero(entorno.ENFRIAMIENTO_MAXIMO_MINUTOS, 1440)),
  };
}
