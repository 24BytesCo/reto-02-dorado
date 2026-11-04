/**
 * Punto de entrada TypeScript de las herramientas `contratos_*` para quien use este repo.
 *
 * Reexporta las mismas herramientas que usa la aplicación (`src/tools/contratos.ts`).
 * Para otras plataformas, sin este repositorio, está `contratos.js`: la misma
 * fuente empaquetada y autónoma (solo requiere zod), generada con `npm run modulo`.
 */
export * from "../../src/tools/contratos.ts";
