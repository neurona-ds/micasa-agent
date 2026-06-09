---
paths:
  - "src/prompts/**"
---

# System Prompts — src/prompts/

Claude's identity, rules, and dynamic context.

## Prompt Structure

System prompt is assembled from 4 parts:

```
buildSystemPrompt()
  → core.md (static markdown)
  → schedule.js (dynamic: business hours)
  → delivery.js (dynamic: zones/pricing)
  → orders.js (dynamic: order flow rules + payment)
```

## Files

| File | Type | Content |
|---|---|---|
| `core.md` | Static markdown | Claude identity + absolute rules |
| `schedule.js` | Dynamic JS | Business hours section |
| `delivery.js` | Dynamic JS | Delivery zones/pricing section |
| `orders.js` | Dynamic JS | Order flow rules + payment section |

## core.md — Identity & Absolute Rules

Defines:
- Claude's persona ("Fabian", sales agent)
- Restaurant identity (Micasa Restaurante, Quito)
- Absolute rules that never change
- Communication style guidelines

## schedule.js — Business Hours

Generates section with:
- Current day/time in Ecuador
- Whether restaurant is open/closed
- Weekly schedule from `business_hours` table
- Instructions for handling orders outside hours
- **Lunch plan flow** (`PLANES DE ALMUERZO`): a plan = N lunches delivered across
  different days. Tells Claude to capture `total + lunches-per-day + address`
  conversationally, call the `quote_plan` tool (never compute the total by hand),
  present the breakdown, then **HANDOFF in the same message** — no `<ORDEN>`,
  no bank details, no "¿Confirmas tu pedido?". Plans are finalized by a human.
  See `.claude/rules/geocoding.md` for the `quote_plan`/`computePlanQuote` mechanics.

## delivery.js — Delivery Zones/Pricing

Generates section with:
- Zone neighborhoods (from `delivery_zones`)
- Carta delivery tiers (from `delivery_tiers`)
- Almuerzo delivery tiers (from `almuerzo_delivery_tiers`)
- Zone 4 handling instructions

## orders.js — Order Flow Rules

Generates section with:
- Step-by-step order flow (PASO 1-5)
- `<ORDEN>` JSON block format
- Confirmation requirement
- Payment instructions
- Bank account details (from `payment_methods`)
- HANDOFF/HANDOFF_PAYMENT rules

## Critical Prompt Rules (DO NOT REMOVE)

### Identity
`⛔ REGLA ABSOLUTA — IDENTIDAD TÉCNICA`
- Bot must not impersonate a developer/technical agent
- Always responds as "Fabian", sales representative

### Prices
`⛔ PRECIOS NO NEGOCIABLES`
- Prices never change based on customer complaints
- No discounts without explicit authorization

### Scheduled Orders
`REGLA CRÍTICA — PEDIDOS PARA FECHA FUTURA`
- Always include `📅 Entrega programada:` line for future dates

### Date Preservation
`REGLA CRÍTICA — PRESERVAR FECHA DE ENTREGA`
- Date must not reset when customer changes items only

### Address Context
`REGLA — DIRECCIÓN/UBICACIÓN SIN CONTEXTO DE PEDIDO`
- "dirección" alone = asking for restaurant address
- Not customer's delivery address

### Confirmation
`⛔ REGLA ABSOLUTA — CONFIRMACIÓN OBLIGATORIA`
- Bank details must NEVER appear before "¿Confirmas tu pedido?" is answered
- Payment data only after explicit confirmation

## The `<ORDEN>` JSON Block

When Claude shows order summary, it must append:

```
<ORDEN>{"total":19.00,"itemsText":"2 Fanescas","orderType":"carta","cantidad":null,"turno":null,"scheduledDate":null,"horarioEntrega":"Inmediato","address":"Dirección","deliveryCost":1.50}</ORDEN>
```

Required fields:
- `total` — order total in USD
- `itemsText` — formatted item list
- `orderType` — `'almuerzo'` or `'carta'`
- `cantidad` — almuerzo count (or null)
- `turno` — delivery time (or null)
- `scheduledDate` — `YYYY-MM-DD` (or null)
- `horarioEntrega` — Zoho pick-list value
- `address` — delivery address
- `deliveryCost` — delivery cost in USD

## Order Summary Detection

Uses regex (NOT text-based):
```javascript
/\bTOTAL[:\s]+\$[\d.]+/i
/[Ee]nv[ií]o[:\s]+[\$G]/i
```

Both must match for order summary detection.

## Prompt Caching

System prompt uses `cache_control: { type: 'ephemeral' }` to reduce token costs when prompt is identical across requests.
