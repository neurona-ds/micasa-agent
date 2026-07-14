---
paths:
  - "src/orchestrator/**"
  - "src/agent.js"
---

# Coordinator — src/orchestrator/coordinator.js

Core message processing: prompt building, Claude API calls, tool loop, handoff logic.

`src/agent.js` is a thin re-export shim: `module.exports = require('./orchestrator/coordinator')`.

## Functions

| Function | Returns | What it does |
|---|---|---|
| `processMessage(phone, message, name)` | `{ reply, needsHandoff, needsPaymentHandoff }` | Main processing function. Fetches all data, builds prompt, calls Claude, processes response. |
| `triggerZohoOnPayment(phone, name)` | `void` | Called when customer sends payment image. Reads `pending_order` from DB, fires Zoho record creation. Non-blocking. |
| `closeOrderSession(phone)` | `void` | Called when operator sends "Orden Confirmada". Ends session. |
| `hasPendingOrder(phone)` | `Promise<boolean>` | Exported to `index.js`; returns `true` if `pending_order` is non-null. |
| `buildSystemPrompt(...)` | `string` | Assembles full system prompt from core.md + 3 dynamic blocks. |

### Helper Functions

| Function | Returns | What it does |
|---|---|---|
| `nowInEcuador()` | `Date` | Returns Date object in Ecuador time (UTC-5, timezone-independent). |
| `checkIsOpen(hoursData, now)` | `boolean` | Returns true if restaurant is currently open. Falls back to Mon-Fri 08:00-15:30. |
| `formatProducts(products)` | `string` | Formats product list grouped by category for system prompt. |
| `formatDeliveryZones(zones, tiers)` | `string` | Formats carta delivery zones and tiers for system prompt. |
| `formatWeekAlmuerzos(weekAlmuerzos, config)` | `string` | Formats current week's almuerzo menu for system prompt. |
| `formatPaymentMethods(methods)` | `string` | Formats bank account list for system prompt. |
| `formatAlmuerzoDeliveryTiers(tiers)` | `string` | Formats almuerzo delivery pricing table for system prompt. |

## Data Flow

```
processMessage(phone, message, name)
  → upsertCustomer()
  → Fanesca campaign override? (fast-path, no Claude)
  → (weekend almuerzo is prompt-driven — no code gate; see business-logic.md)
  → getOrCreateSession()

  → Parallel DB fetch:
      config, products, zones, tiers, almuerzos,
      payments, hours, history, storedGeo

  → buildSystemPrompt()
      → core.md + schedule.js + delivery.js + orders.js

  → Inject stored address context hint (conditional)
  → In-person order check (deterministic bypass)
  → Confirmation check (deterministic bypass)

  → client.messages.create() with GEOCODING_TOOLS

  → Tool-calling loop:
      while (stop_reason === 'tool_use')
        → executeGeoTool(toolName, input, context)
        → feed tool_result back
        → repeat

  → Parse <ORDEN> JSON → savePendingOrder()
  → Detect HANDOFF / HANDOFF_PAYMENT tokens

  → IF HANDOFF_PAYMENT:
      createZohoDeliveryRecord()
      clearPendingOrder()

  → return { reply, needsHandoff, needsPaymentHandoff }
```

## Tool-Calling Loop

Two geocoding tools defined in `src/tools/geo.js`:

| Tool | When Claude calls it |
|---|---|
| `geocode_address` | Customer provides text address |
| `resolve_maps_url` | Customer sends Google Maps link |

The coordinator loops until Claude produces a final text response:
```javascript
while (response.stop_reason === 'tool_use') {
  const toolResult = await executeGeoTool(toolName, input, context);
  // Feed result back to Claude
  response = await client.messages.create({
    messages: [..., { role: 'user', content: [{ type: 'tool_result', ... }] }]
  });
}
```

## Multi-Agent Orchestration

There is NO multi-agent framework. The "orchestration" is a single coordinator with:

1. **Deterministic bypasses** before calling Claude:
   - In-person close
   - Confirmation fast-path
   - Fanesca campaign
   (Weekend almuerzo is NOT a code bypass — it is handled inside the prompt; see business-logic.md)

2. **Claude** for all other conversations with tool calling

3. **Post-processing** that parses Claude's structured output:
   - `<ORDEN>` JSON block
   - `HANDOFF_PAYMENT` token
   - `HANDOFF` token

## The `<ORDEN>` JSON Block

When Claude shows order summary ("Confirmas tu pedido?"), it must append:

```
<ORDEN>{"total":19.00,"itemsText":"2 Fanescas — $9.50 c/u","orderType":"carta","cantidad":null,"turno":null,"scheduledDate":null,"horarioEntrega":"Inmediato","address":"Dirección","deliveryCost":1.50}</ORDEN>
```

Processing:
- **Stripped** from reply before sending to customer
- **Stripped** before saving to conversation history
- **Parsed** immediately after Claude responds
- **Merged** with fresh DB data (customerName, locationPin, locationUrl, campana)
- **Saved** as `customers.pending_order`

### Retry Logic

If Claude emits "Confirmas tu pedido?" without `<ORDEN>`:
- `pending_order` remains null
- Confirmation bypass detects null
- Falls through to Claude with explicit retry instruction
- Forces Claude to regenerate summary with `<ORDEN>` block

## HANDOFF and HANDOFF_PAYMENT Tokens

Claude emits these in reply text. Coordinator strips them before sending to customer.

| Token | Triggers |
|---|---|
| `HANDOFF` | `notifyHandoff(phone, name, 'GENERAL')` + `pauseBot()` |
| `HANDOFF_PAYMENT` | `notifyHandoff(PAYMENT)` + `createZohoDeliveryRecord()` + `clearPendingOrder()` + `pauseBot()` |

## Prompt Caching

System prompt uses Claude's prompt caching:
```javascript
{
  role: 'system',
  content: systemPrompt,
  cache_control: { type: 'ephemeral' }
}
```

Cache hit/miss is logged per request. Reduces token costs when system prompt is identical across consecutive requests.

## Timezone Handling

`nowInEcuador()` uses timezone-independent computation:
```javascript
function nowInEcuador() {
  const now = new Date();
  const utcMs = now.getTime() + now.getTimezoneOffset() * 60000;
  return new Date(utcMs - 5 * 60 * 60 * 1000); // UTC-5
}
```

This guarantees correct Ecuador wall-clock time regardless of server timezone.
