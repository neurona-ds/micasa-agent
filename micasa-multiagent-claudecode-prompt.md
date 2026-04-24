# Micasa Chatbot — Multi-Agent Orchestration Refactor
## Claude Code Prompt

---

## MISSION

Refactor the Micasa WhatsApp chatbot from a monolithic 3,500-line `src/agent.js` into a
proper multi-agent orchestration architecture. The goal is modularity, reliability, lower
token costs, and a bot that survives Railway server restarts without losing conversation state.

Do NOT change any business logic. Only restructure, extract, and modularize.
Execute each phase in order. Verify the app runs after each phase before continuing.

---

## CURRENT STATE (problems to fix)

- `src/agent.js` is 124,853 bytes — monolithic, unmaintainable
- System prompt is ~12,806 tokens per API call — no caching
- `geocodeClarificationPending` and `houseNumberPending` are JavaScript in-memory Maps
  → lost on every Railway server restart → bot forgets address context mid-conversation
- All geocoding logic (8 branches) is inline in `processMessage()`
- No separation between orchestration, tools, state, and prompts

---

## TARGET ARCHITECTURE

```
/src
  agent.js              ← gutted to ~200 lines (orchestrator only)
  index.js              ← DO NOT TOUCH
  memory.js             ← DO NOT TOUCH
  zoho.js               ← DO NOT TOUCH
  menu.js               ← DO NOT TOUCH
  /orchestrator
    coordinator.js      ← main processMessage() loop, slim
  /tools
    geo.js              ← ALL geocoding logic
    order.js            ← order detection + Zoho payload builder
    claude.js           ← Anthropic API wrapper with caching + logging
  /prompts
    core.md             ← static identity + absolute rules (cached)
    schedule.js         ← business hours block builder
    delivery.js         ← delivery zones block builder
    orders.js           ← order flow rules block builder
    menu-block.js       ← menu formatter
  /state
    flags.js            ← geocoding flags persisted to Supabase
/sql
  bot_flags.sql         ← new migration
```

---

## PHASE 1 — Prompt Caching (deploy immediately after this phase)

### 1.1 — Enable cache_control on the system prompt

Find the `client.messages.create()` call inside `processMessage()` in `src/agent.js`.

Change from:
```javascript
const response = await client.messages.create({
  model: 'claude-sonnet-4-5',
  max_tokens: 2048,
  system: fullSystemPrompt,
  messages
})
```

Change to:
```javascript
const response = await client.messages.create({
  model: 'claude-sonnet-4-5',
  max_tokens: 2048,
  system: [
    {
      type: 'text',
      text: fullSystemPrompt,
      cache_control: { type: 'ephemeral' }
    }
  ],
  messages,
  betas: ['prompt-caching-2024-07-31']
})
```

### 1.2 — Add token logging

Immediately after the API call, add:
```javascript
console.log(
  `[tokens] input=${response.usage.input_tokens}` +
  ` output=${response.usage.output_tokens}` +
  ` cache_read=${response.usage.cache_read_input_tokens ?? 0}` +
  ` cache_created=${response.usage.cache_creation_input_tokens ?? 0}`
)
```

### 1.3 — Verify

Run `node src/index.js` and send a test message.
Confirm logs show `[tokens]` line. Cache_read should be > 0 on the second message.

**DEPLOY after Phase 1 passes.**

---

## PHASE 2 — Persist Geocoding Flags to Supabase

### 2.1 — Create SQL migration

Create `/sql/bot_flags.sql`:
```sql
create table if not exists bot_flags (
  phone text primary key,
  geocode_clarification_pending boolean default false,
  house_number_pending boolean default false,
  updated_at timestamptz default now()
);

create index if not exists bot_flags_updated_at_idx on bot_flags(updated_at);
```

**STOP HERE — remind the user to run this SQL in their Supabase dashboard before continuing.**

### 2.2 — Create `/src/state/flags.js`

```javascript
'use strict'
const { createClient } = require('@supabase/supabase-js')

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

const DEFAULTS = {
  geocode_clarification_pending: false,
  house_number_pending: false
}

async function getFlags(phone) {
  try {
    const { data, error } = await supabase
      .from('bot_flags')
      .select('geocode_clarification_pending, house_number_pending')
      .eq('phone', phone)
      .single()
    if (error || !data) return { ...DEFAULTS }
    return data
  } catch {
    return { ...DEFAULTS }
  }
}

async function setFlag(phone, key, value) {
  try {
    await supabase.from('bot_flags').upsert(
      { phone, [key]: value, updated_at: new Date().toISOString() },
      { onConflict: 'phone' }
    )
  } catch (e) {
    console.warn(`[flags] setFlag failed (${key}=${value}):`, e.message)
  }
}

async function clearFlags(phone) {
  try {
    await supabase.from('bot_flags').upsert(
      {
        phone,
        geocode_clarification_pending: false,
        house_number_pending: false,
        updated_at: new Date().toISOString()
      },
      { onConflict: 'phone' }
    )
  } catch (e) {
    console.warn('[flags] clearFlags failed:', e.message)
  }
}

module.exports = { getFlags, setFlag, clearFlags }
```

### 2.3 — Replace in-memory Maps in `src/agent.js`

- Remove these two lines at the top of agent.js:
  ```javascript
  const geocodeClarificationPending = new Map()
  const houseNumberPending = new Map()
  ```

- Add at the top of agent.js:
  ```javascript
  const { getFlags, setFlag, clearFlags } = require('./state/flags')
  ```

- At the START of `processMessage()`, after `upsertCustomer`, add:
  ```javascript
  const flags = await getFlags(customerPhone)
  ```

- Replace ALL occurrences:

  | Find | Replace |
  |------|---------|
  | `geocodeClarificationPending.get(customerPhone) === true` | `flags.geocode_clarification_pending === true` |
  | `geocodeClarificationPending.set(customerPhone, true)` | `await setFlag(customerPhone, 'geocode_clarification_pending', true)` |
  | `geocodeClarificationPending.delete(customerPhone)` | `await setFlag(customerPhone, 'geocode_clarification_pending', false)` |
  | `houseNumberPending.get(customerPhone) === true` | `flags.house_number_pending === true` |
  | `houseNumberPending.set(customerPhone, true)` | `await setFlag(customerPhone, 'house_number_pending', true)` |
  | `houseNumberPending.delete(customerPhone)` | `await setFlag(customerPhone, 'house_number_pending', false)` |

- In `closeOrderSession()` and the in-person order close block, replace the two
  separate `.delete()` calls with: `await clearFlags(phone)` or `await clearFlags(customerPhone)`

### 2.4 — Verify

Run `node src/index.js`. Send a test message.
Check Supabase `bot_flags` table — a row should appear for the test phone number.

**DEPLOY after Phase 2 passes.**

---

## PHASE 3 — Extract Geocoding into `/src/tools/geo.js`

### 3.1 — Create `/src/tools/geo.js`

This file receives the customer message and context, runs all geocoding branches,
and returns an enriched message string. Move ALL of the following logic blocks
out of `processMessage()` in agent.js into this file:

- `isMapsUrl` detection and full Maps URL handling block
- `lastBotAskedAddress && looksLikeAddress` block
- `lastBotAskedClarification` block
- `lastBotAskedHouseNumber && storedAddressNoZone` block
- `proactiveAddressMatch` block
- `looksLikeAddressSupplement` block
- All helper variables computed before those blocks:
  `isMapsUrl`, `lastBotAskedAddress`, `lastBotAskedClarification`,
  `lastBotAskedHouseNumber`, `looksLikeAddress`, `isSimpleConversation`,
  `storedAddressNoZone`, `looksLikeAddressSupplement`, `proactiveAddressMatch`

File structure:
```javascript
'use strict'
const {
  getDeliveryZoneByAddress,
  getDeliveryZoneByCoordinates,
  resolveGoogleMapsUrl,
  saveDeliveryAddress,
  saveRawAddress,
  saveDeliveryZoneOnly,
  saveLocationPin,
  lookupDeliveryCost,
  getPendingOrder,
  clearPendingOrder
} = require('../memory')
const { setFlag } = require('../state/flags')

/**
 * Resolves delivery zone from customer message.
 * Handles Maps URLs, text addresses, clarifications, house-number supplements,
 * proactive address detection, and address supplements.
 *
 * @param {string} customerMessage - raw message from customer
 * @param {Object} context - { customerPhone, storedGeo, lastBotMsg, history,
 *                            flags, buildOrderTypeNote, detectOrderTypeFromHistory,
 *                            detectAlmuerzoQty }
 * @returns {{ enrichedMessage: string }}
 */
async function resolveDeliveryZone(customerMessage, context) {
  const {
    customerPhone,
    storedGeo,
    lastBotMsg,
    history,
    flags,
    buildOrderTypeNote,
    detectOrderTypeFromHistory,
    detectAlmuerzoQty
  } = context

  let enrichedMessage = customerMessage

  // --- move all detection variables and geocoding branches here ---
  // Keep exact same logic — only the location changes

  return { enrichedMessage }
}

module.exports = { resolveDeliveryZone }
```

### 3.2 — Replace in `src/agent.js`

Add at the top:
```javascript
const { resolveDeliveryZone } = require('./tools/geo')
```

Replace the entire geocoding section in `processMessage()` (from `const isMapsUrl = ...`
down to the end of `looksLikeAddressSupplement` block) with:

```javascript
const { enrichedMessage } = await resolveDeliveryZone(customerMessage, {
  customerPhone,
  storedGeo,
  lastBotMsg,
  history,
  flags,
  buildOrderTypeNote,
  detectOrderTypeFromHistory,
  detectAlmuerzoQty
})
```

### 3.3 — Verify

Run `node src/index.js`. Send a message with a test address.
Confirm zone injection still appears in Railway logs.

**DEPLOY after Phase 3 passes.**

---

## PHASE 4 — Extract Order Detection into `/src/tools/order.js`

### 4.1 — Create `/src/tools/order.js`

Move these functions verbatim from `src/agent.js`:
- `detectOrderTypeFromHistory(history)`
- `detectAlmuerzoQty(history)`
- `parseScheduledDate(dateStr)`
- `extractAddressFromHistory(history)`
- `extractTurnoFromHistory(history)`
- `extractOrderDataForZoho(summaryMsg, history, phone, name, storedAddress, storedLocationPin)`

Export all of them:
```javascript
module.exports = {
  detectOrderTypeFromHistory,
  detectAlmuerzoQty,
  parseScheduledDate,
  extractAddressFromHistory,
  extractTurnoFromHistory,
  extractOrderDataForZoho
}
```

### 4.2 — Update `src/agent.js`

Add at the top:
```javascript
const {
  detectOrderTypeFromHistory,
  detectAlmuerzoQty,
  extractOrderDataForZoho,
  parseScheduledDate
} = require('./tools/order')
```

Remove the moved functions from agent.js.

### 4.3 — Verify

Run `node src/index.js`. Place a test order through the full flow.
Confirm order type detection and Zoho payload still work correctly.

**DEPLOY after Phase 4 passes.**

---

## PHASE 5 — Split the System Prompt

### 5.1 — Create `/src/prompts/core.md`

Extract ONLY these sections from `buildSystemPrompt()` into this static markdown file:
- `IDENTIDAD` block (Fabian persona, tone rules)
- `⛔ REGLA ABSOLUTA — IDENTIDAD TÉCNICA` block
- Emoji rules (no 😊, allowed emojis list)
- The "si el cliente pregunta si eres IA" rule

This file must be under 600 tokens. It never changes per request — Claude will cache it.
Do NOT include menu, delivery zones, hours, or order rules here.

### 5.2 — Create `/src/prompts/schedule.js`

```javascript
'use strict'

function buildScheduleBlock(businessHours, config, now, BH_DAYS_ES, MON_FIRST,
                             formatScheduleStr, openDaysLabel, getTodaySchedule, checkIsOpen) {
  // Move these sections from buildSystemPrompt():
  // - FECHA Y HORA ACTUAL block
  // - INFORMACIÓN DEL RESTAURANTE block
  // - HORARIO COMPLETO block
  // - HORARIO DE HOY block
  // - REGLA — HORARIO DE OPERACIÓN block
  // - REGLA CRÍTICA — PEDIDOS PARA FECHA FUTURA block
  // - REGLA CRÍTICA — PRESERVAR FECHA DE ENTREGA block
  // - NOTA ALMUERZOS FIN DE SEMANA block
  // - HORARIOS Y TURNOS DE ALMUERZO block
  // - PLANES SEMANALES Y MENSUALES block
  return `...assembled string...`
}

module.exports = { buildScheduleBlock }
```

### 5.3 — Create `/src/prompts/delivery.js`

```javascript
'use strict'

function buildDeliveryBlock(deliveryZones, deliveryTiers, almuerzoDeliveryTiers,
                             formatDeliveryZones, formatAlmuerzoDeliveryTiers) {
  // Move these sections from buildSystemPrompt():
  // - ZONAS Y PRECIOS DE DELIVERY — CARTA block
  // - TARIFAS DE ENVÍO — ALMUERZOS block
  // - REGLAS ABSOLUTAS DE DELIVERY block
  // - CÁLCULO INTERNO DE ENVÍO block
  // - PEDIDO MÍNIMO block
  return `...assembled string...`
}

module.exports = { buildDeliveryBlock }
```

### 5.4 — Create `/src/prompts/orders.js`

```javascript
'use strict'

function buildOrderRules(config, paymentMethods, formatPaymentMethods) {
  // Move these sections from buildSystemPrompt():
  // - CUENTAS BANCARIAS PARA PAGO block
  // - INSTRUCCIONES DE PAGO block
  // - REGLA ABSOLUTA — MÉTODO DE PAGO block
  // - FLUJO DE CONVERSACIÓN (PASO 1 through PASO 5) — all steps
  // - REGLAS IMPORTANTES block
  // - UPSELL — JUGOS Y BATIDOS block
  // - REGLA CRÍTICA — DETECCIÓN DE CONTEXTO block
  // - REGLA — MENSAJES DEL OPERADOR block
  return `...assembled string...`
}

module.exports = { buildOrderRules }
```

### 5.5 — Refactor `buildSystemPrompt()` in `src/agent.js`

```javascript
const fs   = require('fs')
const path = require('path')
const { buildScheduleBlock } = require('./prompts/schedule')
const { buildDeliveryBlock }  = require('./prompts/delivery')
const { buildOrderRules }     = require('./prompts/orders')

function buildSystemPrompt(
  config, products, deliveryZones, deliveryTiers,
  weekAlmuerzos, paymentMethods, almuerzoDeliveryTiers, businessHours
) {
  const corePrompt = fs.readFileSync(
    path.join(__dirname, 'prompts/core.md'), 'utf8'
  )
  const now       = nowInEcuador()
  const isWeekend = now.getDay() === 0 || now.getDay() === 6

  const menu      = formatProducts(products)
  const almuerzo  = formatWeekAlmuerzos(weekAlmuerzos, config)

  return [
    corePrompt,
    buildScheduleBlock(businessHours, config, now, BH_DAYS_ES, MON_FIRST,
                       formatScheduleStr, openDaysLabel, getTodaySchedule, checkIsOpen),
    `MENÚ COMPLETO (Carta):\n${menu}`,
    `MENÚ DE ALMUERZOS (Lunes a Viernes):\n${almuerzo}`,
    `REGLA ABSOLUTA — ALMUERZOS (MÁXIMA PRIORIDAD):\n${buildAlmuerzoRule()}`,
    buildDeliveryBlock(deliveryZones, deliveryTiers, almuerzoDeliveryTiers,
                       formatDeliveryZones, formatAlmuerzoDeliveryTiers),
    buildOrderRules(config, paymentMethods, formatPaymentMethods)
  ].join('\n\n')
}
```

### 5.6 — Verify

Run `node src/index.js`.
Send test messages covering: menu query, address, order confirmation, payment.
Confirm full flow still works and token count is lower in logs.

**DEPLOY after Phase 5 passes.**

---

## PHASE 6 — Create Slim Orchestrator

### 6.1 — Create `/src/orchestrator/coordinator.js`

Move `processMessage()`, `triggerZohoOnPayment()`, and `closeOrderSession()` from
`agent.js` into this file. Update all require paths accordingly.

```javascript
'use strict'
// All requires from agent.js for these functions — update paths to ../memory, ../zoho, etc.

async function processMessage(customerPhone, customerMessage, customerName = null) {
  // exact same function body — only moved here
}

async function triggerZohoOnPayment(customerPhone, customerName) {
  // exact same function body
}

async function closeOrderSession(phone) {
  // exact same function body
}

module.exports = { processMessage, triggerZohoOnPayment, closeOrderSession }
```

### 6.2 — Slim down `src/agent.js` to a thin re-export

```javascript
'use strict'
// agent.js is now a thin compatibility shim
// All logic has moved to orchestrator/coordinator.js and tools/

const { processMessage, triggerZohoOnPayment, closeOrderSession } = require('./orchestrator/coordinator')
const { getPendingOrder } = require('./memory')

module.exports = {
  processMessage,
  triggerZohoOnPayment,
  closeOrderSession,
  hasPendingOrder: (phone) => getPendingOrder(phone).then(Boolean).catch(() => false)
}
```

This preserves the exact same exports that `index.js` uses — no changes needed in index.js.

### 6.3 — Verify final structure

Run `node src/index.js`.
Run through a complete order flow end to end:
1. Greeting
2. Menu query
3. Order an item
4. Provide delivery address
5. Confirm order
6. Send payment confirmation

All steps must work. Check Railway logs for `[tokens]` — input tokens should be
significantly lower than the original 12,806.

**FINAL DEPLOY.**

---

## ABSOLUTE RULES — DO NOT VIOLATE

1. Do NOT modify `src/index.js`, `src/memory.js`, or `src/zoho.js`
2. Do NOT change any business logic — only move and restructure code
3. Do NOT rename any exported functions
4. Do NOT skip phases — execute in order 1 → 2 → 3 → 4 → 5 → 6
5. After EACH phase: run `node src/index.js` and verify before continuing
6. If any phase fails: STOP and report the error. Do not continue.
7. After Phase 2: remind the user to run `/sql/bot_flags.sql` in Supabase
8. Preserve all console.log and console.warn statements exactly as-is
9. All new files use `'use strict'` at the top
10. All require paths must be relative and correct for the new file locations

---

## SUCCESS CRITERIA

After all phases complete:
- `src/agent.js` is under 50 lines (just re-exports)
- `[tokens]` log shows `cache_read > 0` on repeated messages
- Bot survives a Railway restart without losing address context
- Full order flow works end to end
- Zoho records are created correctly on payment
- Railway logs show no new errors compared to before the refactor
