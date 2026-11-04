# Propuesta: agente de registro de contratos vigentes

## Por qué
El maestro de contratos está congelado desde el 2026-05-30: lo alimentaba un aprendiz que ya no está. Solo llegan a administración los contratos que requieren póliza, no hay buzón ni responsable único y los documentos quedan en correos personales. Nadie puede responder qué contratos vencen este trimestre ni qué pólizas faltan, y el proceso murió cuando se fue una persona.

## Qué cambia
- Un **buzón único** procesado por un agente conversacional que clasifica cada correo: nuevo, actualización, duplicado o rechazado.
- **Extracción determinista** de los datos del contrato con **confianza por campo**. Lo que queda por debajo de 0,8 se convierte en una pregunta a la analista, no en un dato malo.
- **Maestro protegido**: cero duplicados; un otrosí modifica la fila existente y deja historial.
- **Archivo** en una estructura tipo SharePoint y **alertas** de vencimientos, pólizas pendientes y contratos registrados desde el corte.
- Una **regla de gobierno** para que el proceso sobreviva a la rotación de personas.

## Capacidades
| Capacidad | Contenido |
|---|---|
| `contratos` | Herramientas `leer_buzon`, `extraer`, `validar`, `registrar`, `alertas` (ver `specs/contratos/spec.md`) |
| `agente` | Ciclo con tope de iteraciones, confirmación humana, sesiones persistentes y adaptador LLM intercambiable |
| `chat` | Front que muestra cada llamada a herramienta y resalta cuando el agente pide confirmación |

## Ciclo de desarrollo (AI-DLC)
| Fase | Artefacto |
|---|---|
| Concepción: requisitos y alcance | `proposal.md`, `specs/contratos/spec.md` |
| Construcción: diseño, código y pruebas | `design.md`, `tasks.md`; un issue y un commit por tarea, con sus pruebas |
| Operación: despliegue y verificación | URL pública, `demo.ts`, `README.md`, `SOLUCION.md` |

## Fuera de alcance
Conexión real a Exchange o SharePoint, OCR, revisión jurídica, autenticación, base de datos y la reconstrucción histórica de junio a agosto (se diseña en la regla de gobierno, no se ejecuta).
