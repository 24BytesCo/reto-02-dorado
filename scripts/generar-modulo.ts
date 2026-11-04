import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Genera `modulo/` (PRD §9.4) desde las mismas fuentes que usa la aplicación:
 * `agent/prompt.md` y `src/knowledge/registro-contratos.md`. El cuerpo se copia
 * byte a byte; solo se antepone el frontmatter. Uso: `npm run modulo`.
 */

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const FRONTMATTER_AGENTE = `---
description: Punto único de recepción de contratos de Periferia que lee el buzón, extrae datos con confianza por campo, detecta duplicados y alimenta el maestro con confirmación humana.
mode: primary
permission:
  edit: deny
  bash: deny
---`;

const FRONTMATTER_SKILL = `---
name: registro-contratos
description: Úsalo para registrar contratos vigentes, validar sus campos, detectar duplicados o actualizaciones y generar alertas de vencimiento y pólizas pendientes.
---`;

/** Une un frontmatter y un cuerpo con una línea en blanco de separación. */
export function conFrontmatter(frontmatter: string, cuerpo: string): string {
  return `${frontmatter}\n\n${cuerpo}`;
}

/** Escribe un destino de `modulo/` creando sus carpetas si faltan. */
function escribir(ruta: string, contenido: string): void {
  fs.mkdirSync(path.dirname(ruta), { recursive: true });
  fs.writeFileSync(ruta, contenido);
}

/** Regenera `modulo/agent.md` y `modulo/skill/registro-contratos/SKILL.md` desde sus fuentes. */
export function generarModulo(): void {
  const prompt = fs.readFileSync(path.join(raiz, "agent/prompt.md"), "utf8");
  const conocimiento = fs.readFileSync(path.join(raiz, "src/knowledge/registro-contratos.md"), "utf8");
  escribir(path.join(raiz, "modulo/agent.md"), conFrontmatter(FRONTMATTER_AGENTE, prompt));
  escribir(path.join(raiz, "modulo/skill/registro-contratos/SKILL.md"), conFrontmatter(FRONTMATTER_SKILL, conocimiento));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  generarModulo();
  console.log("modulo/ regenerado desde agent/prompt.md y src/knowledge/registro-contratos.md");
}
