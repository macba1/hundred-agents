# Playbook — onboarding de un cliente de WhatsApp

Proceso para dar de alta un negocio nuevo en la recepción digital de WhatsApp.
Destilado del primer cliente real, **Sanmi Café**.

> **La fuente canónica es la skill `hundred-front-desk`**
> (`~/.claude/skills/hundred-front-desk/`). Este archivo es el índice para quien
> navega el repo. Si algo se contradice, manda la skill.
>
> En una sesión de Claude, di *"cliente nuevo de WhatsApp"* o *"dar de alta a
> &lt;negocio&gt;"* y la skill se carga sola con las 8 fases, la batería de QA y las
> trampas de Meta.

## Las 8 fases

| # | Fase | Salida | Gate |
|---|---|---|---|
| 1 | **Discovery del negocio** | carta, horarios, dirección, teléfonos, domicilio y costo, pagos, quién recibe escalamientos | nada de código todavía |
| 2 | **Modelar el catálogo** | `catalogo.json` con datos del negocio en el nivel superior | horarios sin ambigüedad, sinónimos puestos |
| 3 | **Escribir el prompt** | `prompt.md` — conducta, **sin datos** | ningún platillo ni precio en el prompt |
| 4 | **Configurar el cliente** | `config.json` con `modo_demo: true` | `phone_number_id` único entre clientes activos |
| 5 | **Alta en Meta** | número, lista *To*, webhook | `/api/wa/health` ve al cliente |
| 6 | **QA** | batería de 10 puntos en producción con números de prueba | los 10 en PASS |
| 7 | **Pruebas con el staff** | 1-2 semanas en `modo_demo` | panel revisado a diario |
| 8 | **Lanzamiento** | cobro → número real → `modo_demo: false` | **dos conversaciones sin asistencia** |

La fase 8 no termina con el deploy. Termina cuando el staff completa dos
conversaciones reales sin intervención técnica — el estado 7 de `brain`.

## Reglas de oro

1. **Los datos viven en el catálogo, nunca en el prompt.** Un nombre de platillo
   escrito en el prompt acabará citado con un precio inventado.
2. **Canal del cliente y canal interno, separados.** Y el tráfico de prueba
   separado de los dos, con prefijo reservado.
3. **`modo_demo` es el único interruptor de lanzamiento.** Un booleano, no una
   reescritura del prompt.
4. **Migrar al número real solo tras cobrar.** Es un campo: `phone_number_id`.
5. **Nunca prometer lo que no se hizo.** Si el agente dice "lo consulto con el
   equipo", hay guardarraíles en código que fuerzan el escalamiento real.

## Arquitectura

Vercel + Redis, multi-tenant, en este repo. Sin servicios nuevos — ver
[`INFRA.md`](../INFRA.md).

```
api/wa/{webhook,leads,health,admin}.js
lib/wa/clients/<clave>/{config.json, prompt.md, catalogo.json}
lib/wa/{clients,catalog,agent,store,whatsapp,inbound,panel,testmode}.js
```

Enrutado por `phone_number_id`. Estado íntegro en Redis, con namespace por
cliente. Regresión: `node scripts/wa-smoke.js` (comprueba el *exit code*).

## Precios

**Pendientes de definir.** Ver `references/pricing.md` en la skill: están los
costes reales medidos (OpenAI ~$0,03–0,05 por turno, infraestructura $0
marginal), pero **ninguna cifra comercial**. No cotices sin preguntar.

## Referencias de la skill

`meta-setup.md` · `catalog-schema.md` · `prompt-checklist.md` · `guardrails.md` ·
`architecture.md` · `qa-battery.md` · `pricing.md`
