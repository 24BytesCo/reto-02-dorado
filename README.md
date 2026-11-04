# Agente de registro de contratos vigentes

Reto técnico 02 · Periferia IT Group. Agente conversacional que actúa como punto único de recepción de contratos: lee el buzón, extrae los datos con confianza por campo, detecta duplicados y actualizaciones, archiva en una estructura tipo SharePoint, alimenta el maestro y genera alertas.

**Link para probar:** _(pendiente de despliegue)_

## Levantar en local

```bash
cp .env.example .env      # y poner ANTHROPIC_API_KEY
npm install
npm run dev               # http://localhost:3000
```

## Demo sin modelo

```bash
npm run demo              # o: bun run demo.ts
```

## Pruebas

```bash
npm test && npm run typecheck
```

## Documentación

- `SOLUCION.md`: planteamiento de la solución.
- `openspec/`: plan, especificación, diseño, tareas y revisión del PRD.
