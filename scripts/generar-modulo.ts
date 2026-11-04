import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

/**
 * Genera `modulo/` (PRD §9.4) desde las mismas fuentes que usa la aplicación:
 * `agent/prompt.md` y `src/knowledge/registro-contratos.md`. El cuerpo se copia
 * byte a byte; solo se antepone el frontmatter. Además empaqueta con esbuild
 * `src/tools/contratos.ts` (y su árbol) en un único `modulo/tools/contratos.js`
 * autónomo, con `zod` como única dependencia. Uso: `npm run modulo`.
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

const FUENTE_HERRAMIENTAS = "src/tools/contratos.ts";

const ENCABEZADO_HERRAMIENTAS = `// GENERADO por \`npm run modulo\` (scripts/generar-modulo.ts). No editar a mano.
// Fuente: ${FUENTE_HERRAMIENTAS} y las piezas de src/tools/ que importa, empaquetadas con esbuild.
// Autónomo: la única dependencia externa es zod.
`;

/** Empaqueta las herramientas de la app en un solo módulo ESM (zod queda como dependencia externa) y devuelve su texto. */
export async function empaquetarHerramientas(): Promise<string> {
  const resultado = await build({
    entryPoints: [FUENTE_HERRAMIENTAS],
    absWorkingDir: raiz,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node20",
    external: ["zod"],
    legalComments: "none",
    write: false,
  });
  const salida = resultado.outputFiles[0];
  if (!salida) throw new Error("esbuild no produjo salida");
  return ENCABEZADO_HERRAMIENTAS + salida.text;
}

/** Escribe un destino de `modulo/` creando sus carpetas si faltan. */
function escribir(ruta: string, contenido: string): void {
  fs.mkdirSync(path.dirname(ruta), { recursive: true });
  fs.writeFileSync(ruta, contenido);
}

/** Regenera `agent.md`, `SKILL.md` y `tools/contratos.js` de `modulo/` desde sus fuentes. */
export async function generarModulo(): Promise<void> {
  const prompt = fs.readFileSync(path.join(raiz, "agent/prompt.md"), "utf8");
  const conocimiento = fs.readFileSync(path.join(raiz, "src/knowledge/registro-contratos.md"), "utf8");
  escribir(path.join(raiz, "modulo/agent.md"), conFrontmatter(FRONTMATTER_AGENTE, prompt));
  escribir(path.join(raiz, "modulo/skill/registro-contratos/SKILL.md"), conFrontmatter(FRONTMATTER_SKILL, conocimiento));
  escribir(path.join(raiz, "modulo/tools/contratos.js"), await empaquetarHerramientas());
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await generarModulo();
  console.log("modulo/ regenerado desde agent/prompt.md, src/knowledge/registro-contratos.md y src/tools/contratos.ts");
}
