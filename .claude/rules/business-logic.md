---
paths:
  - "src/tools/order.js"
---

# Business Logic — Order Flow, Sessions, Handoffs

Core business rules for the WhatsApp sales agent.

## Delivery Zones & Pricing

**Pricing is authoritative from the external Micasa Delivery API** — never hardcoded.
The bot sends the address + order context (`order_type`, `almuerzo_qty`, `subtotal`) to
`getDeliveryQuote()` and uses the returned `delivery_gross` and `zone` verbatim. Do NOT
maintain a per-zone fee table anywhere in code or docs — it drifts from the API and causes
mis-quotes. See `.claude/rules/geocoding.md`.

Facts that still hold (not pricing):
- The API returns a zone number (1–4) based on distance from the restaurant
  (**América y Juan José de Villalengua, Quito: `-0.1723433, -78.4910016`**).
- **Zone 4 → ALWAYS HANDOFF** (supervisor quotes manually; no order summary shown).
- **Zone numbers are NEVER shown to customers.** Always injected as `[SISTEMA]` tags.

## Single Order vs. Lunch Plan (delivery charging)

Two different things that both involve "multiple almuerzos":

| | Same-day order (N lunches today) | Plan (N lunches across days) |
|---|---|---|
| Trips | **1** delivery | **N ÷ per-day** deliveries |
| Tool | `geocode_address` | `quote_plan` |
| Multi-lunch discount | Applies (N in one drop) | Applies only to each day's drop |
| Delivery charged | Once | **Per delivery day** |
| Flow | Confirmation → bank → comprobante | Same: confirmation → bank → comprobante |
| Zoho on payment | `Planificacion_de_Entregas` (`createZohoDeliveryRecord`) | **Deals** (`createZohoDealRecord`) |

Both flows are identical to the customer; only the final Zoho write branches, keyed on
`pending_order.orderType === 'plan'`. Plan math lives in `src/tools/plan.js` (`computePlanQuote`);
the `quote_plan` handler builds the `<ORDEN>` block. See `.claude/rules/geocoding.md` and `zoho.md`.

## Order Flow Steps

```
PASO 1: Greeting (brief, no menu spam)

PASO 2: Answer query (menu link, prices, hours, delivery cost)

PASO 3: Order flow
  a) Build item list (accumulative, never delete items)
  b) Ask: delivery or in-person?
  c) In-person → close conversation (no payment via bot)
  d) Delivery → ask address (if not stored)
  e) Show summary: items + subtotal + delivery + TOTAL
     + emit <ORDEN>{...}</ORDEN> JSON block
  f) Ask: "Confirmas tu pedido?" (MANDATORY — never skip)

PASO 4: Payment
  - Send bank accounts + amount
  - Ask for payment screenshot
  - On receipt → HANDOFF_PAYMENT

PASO 5: Handoff triggers (escalation, complaints, order status)
```

## Session Management

- Sessions are UUIDs stored in `customers.current_session_id`
- **Expires after 6 hours** of inactivity (`SESSION_EXPIRY_MS`)
- `getOrCreateSession()` returns existing session or creates new one
- All `saveMessage()` and `getHistory()` calls are scoped to session ID
- Prevents old completed orders from leaking into Claude's context
- Sessions end via `endSession()` only when operator sends "Orden Confirmada"
- Automatic expiry handles customers who return the next day

## Bot Pause/Resume

### Automatic Pause Triggers
- `HANDOFF` token in Claude response
- `HANDOFF_PAYMENT` token in Claude response
- Human operator sends message in WATI
- Customer sends payment image

### Automatic Resume Triggers
- WATI conversation assigned to bot account
- `#resume` command from operator
- Operator provides delivery cost/zone info
- Operator sends "Orden Confirmada"

### While Paused
Customer text messages are still saved to conversation history so Claude has full context when resumed.

## HANDOFF and HANDOFF_PAYMENT

Claude emits these tokens in reply text. Coordinator strips them before sending to customer.

| Token | What it triggers |
|---|---|
| `HANDOFF` | `notifyHandoff(GENERAL)` + `pauseBot()` |
| `HANDOFF_PAYMENT` | `notifyHandoff(PAYMENT)` + `createZohoDeliveryRecord()` + `clearPendingOrder()` + `pauseBot()` |

Zone 4 triggers HANDOFF immediately when address is identified — no order summary shown.

## Weekend Almuerzo — Next-Week Pre-Booking (prompt-driven)

There is **no code-level weekend interception** — Claude is always called on weekends.
Behavior is driven entirely by the prompt (`src/prompts/orders.js` REGLA MENÚ ALMUERZOS
step 3, and `src/prompts/schedule.js`):
- On Sat/Sun, Claude shares **next week's** almuerzo menu and explains the restaurant is
  closed on weekends (no Sat/Sun delivery).
- Claude actively offers to **schedule the order for the next business day** (Mon–Fri),
  running the normal order flow (day → items → turno → address → summary → confirmation →
  payment). This is a real order that fires Zoho on payment like any other.
- Claude emits `HANDOFF` **only** if the customer insists on same-day weekend delivery,
  or has a special request/complaint needing a human.

> Historical note: an earlier version had a hardcoded `isAlmuerzoOrderOnWeekend`
> interception in `src/index.js` that fired HANDOFF before calling Claude. It was removed
> (commit ca32294). The weekend flow is now intentionally prompt-only to allow next-week
> pre-booking — no deterministic code gate exists.

## src/tools/order.js Functions

| Function | What it does |
|---|---|
| `detectOrderTypeFromHistory(history)` | Returns `'almuerzo'`, `'carta'`, or `'mixed'` based on messages |
| `detectAlmuerzoQty(history)` | Returns integer count from messages. Defaults to 1. |
| `parseScheduledDate(dateStr)` | Parses Spanish date string → `YYYY-MM-DD` |
| `extractAddressFromHistory(history)` | Scans for user reply after "dirección completa" |
| `extractTurnoFromHistory(history)` | Scans recent history for turno/hora mention |
| `extractOrderDataForZoho(...)` | Parses summary into `orderData` (legacy path) |

## Quantity & Delivery Auto-Detection (REGLA INQUEBRANTABLE)

To keep checkout flow smooth:

### Quantity Auto-Detection
- Singular articles (`"un"`, `"una"`, `"uno"`) → quantity `1`
- Claude is **prohibited** from asking "¿Cuántos almuerzos necesitas?" if quantity is implied

### Delivery Choice Bypasses
- Customer provides address upfront → assume delivery
- Customer asks for delivery → skip local vs. delivery confirmation
- Go straight to geocoding

### Conditional Stored Address Injection
- Stored address hints only injected if NOT already in current session
- Prevents bot from offering to confirm an address just typed

## Daily vs. Weekly Menu Rules

### Today's Menu Only
Show only current day's menu when:
- Customer asks for today's menu
- Customer initiates lunch order
- Generic request ("¿Cuál es el menú?", "quiero un almuerzo")

### Weekly Menu Only
Show full 5-day menu ONLY when explicitly requested:
- `"semana"`, `"semanal"`, `"weekly"`, `"toda la semana"`

### Specific Day Menu
If customer requests specific day ("para el lunes", "para mañana viernes"):
- Show only that day's menu
