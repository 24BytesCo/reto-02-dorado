import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { empaquetarHerramientas } from "../scripts/generar-modulo.ts";
import { proyectoTemporal } from "./ayudas.ts";

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const leer = (rel: string): string => fs.readFileSync(path.join(raiz, rel), "utf8");

/** Separa el frontmatter YAML (entre `---`) del cuerpo; el cuerpo empieza tras la línea en blanco. */
function partir(texto: string): { frontmatter: string; cuerpo: string } {
  const m = /^---\n([\s\S]*?)\n---\n\n([\s\S]*)$/.exec(texto);
  assert.ok(m, "el archivo debe empezar con frontmatter YAML delimitado por ---");
  return { frontmatter: m[1], cuerpo: m[2] };
}

/** Forma de herramienta (PRD §6.2): `{ description, args, execute }`. */
function esHerramienta(v: unknown): boolean {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return typeof o.description === "string" && typeof o.args === "object" && o.args !== null && typeof o.execute === "function";
}

const nombresDeHerramientas = (mod: Record<string, unknown>): string[] =>
  Object.keys(mod).filter((k) => esHerramienta(mod[k])).sort();

test("modulo/agent.md: cuerpo idéntico a agent/prompt.md", () => {
  assert.equal(partir(leer("modulo/agent.md")).cuerpo, leer("agent/prompt.md"), "ejecuta `npm run modulo`");
});

test("modulo/agent.md: frontmatter con description, mode primary y permisos denegados", () => {
  const fm = partir(leer("modulo/agent.md")).frontmatter;
  assert.match(fm, /^description: \S.+$/m);
  assert.match(fm, /^mode: primary$/m);
  assert.match(fm, /^permission:\n {2}edit: deny\n {2}bash: deny$/m);
});

test("SKILL.md: cuerpo idéntico a src/knowledge/registro-contratos.md", () => {
  const skill = partir(leer("modulo/skill/registro-contratos/SKILL.md"));
  assert.equal(skill.cuerpo, leer("src/knowledge/registro-contratos.md"), "ejecuta `npm run modulo`");
});

test("SKILL.md: frontmatter con name y description", () => {
  const fm = partir(leer("modulo/skill/registro-contratos/SKILL.md")).frontmatter;
  assert.match(fm, /^name: registro-contratos$/m);
  assert.match(fm, /^description: \S.+$/m);
});

test("modulo/tools/contratos.ts exporta las mismas herramientas que src/tools/contratos.ts", async () => {
  const app = (await import("../src/tools/contratos.ts")) as Record<string, unknown>;
  const modulo = (await import("../modulo/tools/contratos.ts")) as Record<string, unknown>;
  const esperadas = nombresDeHerramientas(app);
  assert.ok(esperadas.length > 0, "la app debe exportar al menos una herramienta");
  assert.deepEqual(nombresDeHerramientas(modulo), esperadas);
  for (const k of esperadas) assert.equal(modulo[k], app[k], `${k} debe ser la misma referencia, no una copia`);
});

test("modulo/tools/contratos.js: igual al empaquetado actual de src/tools (si falla, ejecuta `npm run modulo`)", async () => {
  assert.equal(leer("modulo/tools/contratos.js"), await empaquetarHerramientas());
});

test("modulo/tools/contratos.js: encabezado de archivo generado con su fuente", () => {
  const cabecera = leer("modulo/tools/contratos.js").split("\n").slice(0, 3).join("\n");
  assert.match(cabecera, /GENERADO por `npm run modulo`/);
  assert.match(cabecera, /Fuente: src\/tools\/contratos\.ts/);
});

test("modulo/tools/contratos.js: exporta las mismas herramientas con la misma forma y ejecuta leer_buzon", async () => {
  const app = (await import("../src/tools/contratos.ts")) as Record<string, unknown>;
  const empaquetado = (await import(pathToFileURL(path.join(raiz, "modulo/tools/contratos.js")).href)) as Record<string, unknown>;
  const esperadas = nombresDeHerramientas(app);
  assert.deepEqual(nombresDeHerramientas(empaquetado), esperadas);
  for (const k of esperadas) {
    const a = app[k] as Record<string, unknown>;
    const e = empaquetado[k] as Record<string, unknown>;
    assert.equal(e.description, a.description, `${k}.description`);
    assert.deepEqual(Object.keys(e.args as object), Object.keys(a.args as object), `${k}.args`);
  }
  const buzon = empaquetado.leer_buzon as { execute(args: object, ctx: unknown): Promise<string> };
  const respuesta = JSON.parse(await buzon.execute({}, proyectoTemporal())) as { ok: boolean; data: { mensajes: unknown[] } };
  assert.equal(respuesta.ok, true);
  assert.ok(respuesta.data.mensajes.length > 0, "el buzón de fixtures trae mensajes");
});
