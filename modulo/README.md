# Módulo reutilizable (PRD §9.4)

El agente empaquetado para otras plataformas, sin depender del servidor.

| Pieza | Qué es | Origen |
|---|---|---|
| `agent.md` | Frontmatter (`description`, `mode: primary`, `permission` con `edit` y `bash` en `deny`) + system prompt | **Generado** desde `agent/prompt.md` |
| `skill/registro-contratos/SKILL.md` | Frontmatter (`name`, `description`) + conocimiento del proceso | **Generado** desde `src/knowledge/registro-contratos.md` |
| `tools/contratos.ts` | Las herramientas `contratos_*`, importables sin servidor | **Reexporta** `src/tools/contratos.ts` |

No se editan a mano. Para regenerar tras cambiar el prompt o el conocimiento:

```
npm run modulo
```

`tests/modulo.test.ts` falla si `agent.md` o `SKILL.md` se desincronizan de su fuente.
