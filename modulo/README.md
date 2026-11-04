# Módulo reutilizable (PRD §9.4)

El agente empaquetado para otras plataformas, sin depender del servidor.

| Pieza | Qué es | Origen |
|---|---|---|
| `agent.md` | Frontmatter (`description`, `mode: primary`, `permission` con `edit` y `bash` en `deny`) + system prompt | **Generado** desde `agent/prompt.md` |
| `skill/registro-contratos/SKILL.md` | Frontmatter (`name`, `description`) + conocimiento del proceso | **Generado** desde `src/knowledge/registro-contratos.md` |
| `tools/contratos.js` | Las herramientas `contratos_*` en **un solo archivo** autónomo (solo requiere `zod`) | **Generado** con esbuild desde `src/tools/contratos.ts` y su árbol |
| `tools/contratos.ts` | Punto de entrada TypeScript para quien use este repo | **Reexporta** `src/tools/contratos.ts` |

No se editan a mano. Para regenerar tras cambiar el prompt o el conocimiento:

```
npm run modulo
```

`tests/modulo.test.ts` falla si `agent.md`, `SKILL.md` o `contratos.js` se desincronizan de su fuente (regenera el paquete en memoria y lo compara), e importa el `.js` para verificar que exporta las mismas herramientas y ejecuta `leer_buzon`.

## Por qué `contratos.js` y además `contratos.ts`

El PRD §9.4 pide el agente «sin depender de tu servidor», con las mismas piezas que la app. Un reexport (`contratos.ts`) cumple lo segundo pero no lo primero: solo funciona dentro de este repo, porque apunta a `src/`. Por eso `contratos.js` es el artefacto portable: se empaqueta con esbuild el mismo código de la app (no una copia escrita a mano), con formato ESM, plataforma Node y `zod` como dependencia externa. Llevarlo a otra plataforma exige copiar ese archivo y tener `zod` instalado; nada más.

`contratos.ts` se conserva como punto de entrada tipado dentro del repo (y porque el PRD lista ese nombre); el `.js` no lo reemplaza para quien trabaja aquí.
