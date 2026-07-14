# Micasa Restaurante — WhatsApp Agent

WhatsApp sales bot for Micasa Restaurante (Quito, Ecuador). Stack: Node.js (CommonJS) · Express · Claude API (`claude-sonnet-4-5`) · Supabase (PostgreSQL) · WATI (WhatsApp gateway) · Zoho CRM · Google Maps Geocoding. Railway auto-deploys on push to `main`.

## Directory Layout
- `src/index.js` — Express server + webhook handler (entry point)
- `src/orchestrator/coordinator.js` — Core message processing, prompt building, Claude calls, handoff logic
- `src/memory.js` — All Supabase reads/writes
- `src/zoho.js` — Zoho CRM OAuth + record creation
- `src/tools/geo.js` — Geocoding tools (Claude tool calling): `geocode_address`, `resolve_maps_url`, `quote_plan`
- `src/tools/plan.js` — Lunch-plan pricing (`computePlanQuote`): delivery charged per delivery day
- `src/tools/order.js` — Order type detection, quantity extraction
- `src/prompts/` — System prompt: `core.md` + `schedule.js` + `delivery.js` + `orders.js`
- `sql/` — Supabase migration scripts

## End-to-End Flow
```
WATI POST /webhook → index.js (dedup, filter, route)
  → media: ack + notifyHandoff + triggerZohoOnPayment()
  → location: reverse-geocode → enrich message → processMessage()
  → text: campaign code detection → processMessage()
      → coordinator.js: build prompt → Claude API (with geocoding tools)
      → tool loop: geocode_address / resolve_maps_url → feed result → repeat
      → parse <ORDEN> JSON → savePendingOrder()
      → detect HANDOFF / HANDOFF_PAYMENT tokens
      → (HANDOFF_PAYMENT) → createZohoDeliveryRecord() → clearPendingOrder()
  → sendWatiMessage() → WATI API → customer
  → (handoff) → notifyHandoff() + pauseBot()
```

## Core Invariants
1. **`pending_order` is single source of truth** — No history-scan fallback for Zoho records
2. **`clearPendingOrder()` runs immediately after Zoho fires** — Prevents duplicate records
3. **Session ends only on "Orden Confirmada"** — Not on image receipt, not on HANDOFF_PAYMENT
4. **Zone numbers never shown to customers** — Always injected as `[SISTEMA]` tags
5. **`Fuente = 'WhatsAppBot'` gates Zoho workflow** — Do not remove this field

## Sacred Rules
- **Order summary regex**: `/\bTOTAL[:\s]+\$[\d.]+/i` AND `/[Ee]nv[ií]o[:\s]+[\$G]/i` — never change to text-based
- **`<ORDEN>` block required**: Claude must emit after every "Confirmas tu pedido?" — retry logic depends on it
- **Confirmation before payment**: Bank details must NEVER appear before "Confirmas tu pedido?" is answered
- **Almuerzo cycle is read-only**: `getCurrentCycle()` never writes — pg_cron owns the weekly advance
- **Two handoff tokens**: `HANDOFF` (general escalation) and `HANDOFF_PAYMENT` (payment confirmed)
- **Geocoding bounds biasing**: Forward geocoding requests are biased to a 15 km bounding box around restaurant coordinates (`RESTAURANT_LAT`/`RESTAURANT_LNG`) to prevent duplicate street errors (like Pusuquí vs Rumipamba).

## Doc Ownership
| When you change... | Read rule file... |
|---|---|
| `src/index.js`, WATI routing, webhooks | `.claude/rules/webhook-flow.md` |
| `src/orchestrator/**`, `src/agent.js` | `.claude/rules/coordinator.md` |
| `src/memory.js`, `sql/**`, Supabase tables | `.claude/rules/database.md` |
| `src/tools/geo.js`, `src/tools/micasaEnvios.js` | `.claude/rules/geocoding.md` |
| `src/zoho.js`, CRM integration | `.claude/rules/zoho.md` |
| `src/tools/order.js`, order flow, sessions | `.claude/rules/business-logic.md` |
| `src/prompts/**`, system prompt structure | `.claude/rules/prompts.md` |
| `package.json`, `.env*`, deployment | `.claude/rules/deployment.md` |
| Historical decisions, bug context | `.claude/rules/known-issues.md` |
