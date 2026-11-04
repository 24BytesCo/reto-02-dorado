import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Contexto } from "../src/tools/nucleo.ts";

export const RAIZ = path.resolve(import.meta.dirname, "..");

/** Proyecto temporal con los fixtures reales: las pruebas nunca escriben en el repositorio. */
export function proyectoTemporal(): Contexto {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reto-"));
  fs.cpSync(path.join(RAIZ, "fixtures"), path.join(dir, "fixtures"), { recursive: true });
  return { directory: dir, sessionId: "prueba" };
}
