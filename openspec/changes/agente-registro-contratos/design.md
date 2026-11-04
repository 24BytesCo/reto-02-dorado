# Diseño

## Arquitectura

```
┌──────────────┐  POST /api/chat   ┌──────────────────────────────────────────┐
│ web/ (chat)  │ ────────────────▶ │ src/server.ts (API HTTP)                 │
│ historial    │ ◀──────────────── │   └─ src/agent/ ciclo del agente         │
│ tool calls   │ { reply,          │        ├─ src/llm/adapter.ts (interfaz)  │
│ confirmación │   toolCalls[],    │        │    └─ anthropic.ts              │
└──────────────┘   needsConfirm. } │        └─ src/tools/contratos.ts         │
                                   └───────────────┬──────────────────────────┘
                                                   │
                     fixtures/reto-02 (solo lectura)    out/ (escritura)
                     buzón, maestro, comerciales        sharepoint/, log.jsonl,
                                                        procesados.json, alertas.md,
                                                        sesiones/
```

- **Comportamiento**: `agent/prompt.md`. **Conocimiento**: `src/knowledge/registro-contratos.md`. **Ejecución**: `src/tools/`. Cambiar una regla de negocio no toca el servidor.
- `demo.ts` importa las mismas herramientas que el agente y las llama sin modelo.

## Contrato de herramientas (PRD §6.2)

```ts
export const extraer = {
  description: "Una frase precisa",
  args: { mensaje_id: z.string().describe("…") },
  async execute(args, ctx: { directory: string; sessionId: string }): Promise<string> {
    // siempre JSON: { ok: true, data } | { ok: false, error }
  },
}
```

El registro de herramientas recorre los exports de `contratos.ts`, expone cada uno como `contratos_<export>`, valida los argumentos con zod antes de ejecutar y anota cada llamada en `out/log.jsonl`.

## Flujo por mensaje

```
leer_buzon → extraer → validar ─┬─ nuevo / actualizacion sin revisión → registrar
                                ├─ con requiere_revision → PREGUNTA a la analista (fin del turno)
                                │      └─ «confirmo…» → validar(contrato corregido) → registrar(confirmado: true)
                                ├─ duplicado → registrar (marca procesado, no escribe)
                                └─ rechazado → registrar (marca procesado con motivo)
                                                         ↓
                                                     alertas(hoy)
```

## Decisiones

| Decisión | Alternativa descartada | Por qué |
|---|---|---|
| Extracción determinista (reglas sobre el texto) con confianza por campo | Que el modelo extraiga | Repetible, auditable y gratis; el PRD la exige como P0 y la demo debe correr sin modelo |
| Invariantes en `validar` y `registrar` | Confiar en el prompt | El código garantiza aunque el modelo se equivoque (CA2, RN5) |
| Confirmación como pregunta al final del turno (CA3) | Pausar el ciclo con botones | Es lo que pide el PRD; el front resalta el estado y ofrece atajos |
| Historial de la sesión en el backend, persistido en `out/sesiones/` | Que el navegador mande el historial | Nadie puede falsificar resultados de herramientas ni una confirmación; aguanta reinicios |
| Adaptador LLM con tipos propios, más un adaptador simulado | Usar los tipos del SDK en el ciclo | Cambiar de proveedor no toca el ciclo; el simulado prueba el ciclo y los errores sin clave |
| No compactar el historial | Resumir conversaciones largas | Cabe de sobra en el contexto; resumir reescribe valores de herramientas (CA2); el estado vive en archivos |
| CA3 también en código: `confirmado: true` solo vale si la revisión se pidió en un turno anterior | Confiar en que el modelo pregunte | El modelo podría confirmar por su cuenta en el mismo turno; el backend lo impide |
| CA2 en código: la extracción se guarda por mensaje y `registrar` rechaza valores distintos que no estaban en revisión | Registrar lo que mande el modelo | El modelo puede redondear o inferir (PRD §10); solo la persona puede cambiar un dato dudoso |
| `POST /api/chat` con stream de eventos y latido cada 15 s (y JSON si no se pide stream) | Respuesta bloqueante | El prompt del §11 tarda más que el timeout del proxy (60 s) y de Cloudflare (100 s); el stream además muestra cada herramienta en vivo |
| RN1 se evalúa antes que RN2 y compara valor y fechas | Aplicar RN2 literal («mismo id y algún campo distinto») | El reenvío de msg-004 trae el objeto redactado distinto; con RN2 literal se reescribiría una fila buena |
| Mismo NIT no basta para actualizar: exige además objeto con similitud ≥ 0,9 | Deduplicar solo por NIT (lectura apresurada del §10) | Tres contratos nuevos comparten NIT con contratos existentes |
| Fecha de firma sin día → último día del mes de firma | Inventar el día 1 o el día del correo sin decirlo | Coincide con la fecha del correo y con la fecha de fin que el PRD espera (2027-08-31); se declara como supuesto y queda en revisión |
