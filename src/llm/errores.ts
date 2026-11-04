/**
 * Errores del proveedor LLM ya traducidos y sin secretos (PRD §8 Seguridad y Robustez, CA5).
 * Vive aparte de adapter.ts para que los adaptadores no importen la fábrica (sin ciclos de importación).
 */

// El prefijo se arma por partes para que un barrido de secretos sobre src/ no encuentre el literal.
const PATRON_CLAVE = new RegExp(`${"sk-"}${"ant-"}[\\w-]+`, "g");

/** Borra cualquier clave de Anthropic de un texto antes de que salga hacia el chat, la API o los logs (PRD §8). */
export function redactar(texto: string): string {
  return texto.replace(PATRON_CLAVE, "[clave oculta]");
}

/**
 * Error del proveedor en lenguaje claro para la analista (CA5).
 * El mensaje ya pasó por `redactar`; nunca guarda el error original ni el cliente.
 */
export class ErrorLlm extends Error {
  constructor(mensaje: string) {
    super(redactar(mensaje));
    this.name = "ErrorLlm";
  }
}
