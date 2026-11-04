/**
 * Parámetros de negocio del proceso de registro de contratos.
 * Viven aquí, junto a las herramientas, para que cambiar una regla no toque el servidor (PRD §6.5).
 */
export const REGLAS = {
  /** RN5: un campo con confianza menor a este umbral exige revisión humana. */
  umbralConfianza: 0.8,
  /** RN2: similitud mínima de objeto para tratar dos contratos del mismo NIT como el mismo. */
  similitudObjeto: 0.9,
  /** HU-5: ventana de alerta de vencimiento, en días. */
  diasAlertaVencimiento: 60,
  /** HU-5: fecha de corte del maestro congelado. */
  fechaCorte: "2026-05-30",
  /** NIT de Periferia: aparece en todos los contratos como contratista y nunca es el cliente. */
  nitPropio: "900123456",
} as const;

/** Columnas del maestro en el orden exacto del fixture (PRD §7.2). */
export const COLUMNAS_MAESTRO = [
  "id_contrato", "cliente", "nit_cliente", "pais", "objeto", "valor", "moneda",
  "fecha_inicio", "fecha_fin", "requiere_poliza", "tipo_poliza", "estado_poliza",
  "comercial", "ruta_sharepoint", "fecha_registro", "fuente",
] as const;

/** Nombre de una columna del maestro. */
export type Columna = (typeof COLUMNAS_MAESTRO)[number];
/** Una fila del maestro, con todas las columnas como texto (PRD §7.2). */
export type FilaMaestro = Record<Columna, string>;

/** Países admitidos en el maestro (PRD §7.2). */
export const PAISES = ["CO", "EC", "PE", "PA", "HN"] as const;
/** Monedas admitidas en el maestro (PRD §7.2). */
export const MONEDAS = ["COP", "USD", "PEN", "PAB", "HNL"] as const;
/** Código de país del maestro. */
export type Pais = (typeof PAISES)[number];
/** Código de moneda del maestro. */
export type Moneda = (typeof MONEDAS)[number];

/**
 * Campos que salen del texto del contrato y entran en la regla de confianza (RN5).
 * `comercial` no está: un remitente desconocido se reporta pero no bloquea (HU-3).
 */
export const CAMPOS_CON_CONFIANZA = [
  "id_contrato", "cliente", "nit_cliente", "pais", "objeto", "valor", "moneda",
  "fecha_inicio", "fecha_fin", "requiere_poliza", "tipo_poliza",
] as const;
/** Campo del contrato sujeto a la regla de confianza (RN5). */
export type CampoConConfianza = (typeof CAMPOS_CON_CONFIANZA)[number];
