# CLAUDE.md — Micasa Restaurante WhatsApp Agent

Complete reference for AI agents working on this codebase. Read this before touching any file.

---

## 1. PROJECT OVERVIEW

### What it is
A WhatsApp sales agent for **Micasa Restaurante** (Quito, Ecuador). Customers send messages via WhatsApp; the bot (posing as "Fabian", a sales agent) answers questions, takes food orders, calculates delivery costs, and hands off to a human operator when payment confirmation or special handling is needed.

### Tech stack
| Layer | Technology |
|---|---|
| Runtime | Node.js (CommonJS), Express |
| Hosting | Railway (auto-deploys on push to `main`) |
| AI | Anthropic Claude API (`claude-sonnet-4-5`), prompt caching enabled |
| WhatsApp gateway | WATI (webhooks + session message API) |
| Database | Supabase (PostgreSQL) |
| CRM | Zoho CRM — `Planificacion_de_Entregas` custom module |
| Geocoding | Google Maps Geocoding API (text address + reverse geocoding) |

### End-to-end flow
1. Customer sends WhatsApp message → WATI fires POST to `/webhook`
2. `index.js` filters duplicates, echoes, stale webhooks, operator messages
3. If media (image) → payment flow: ack customer, notify admin, create Zoho record
4. If location pin → reverse-geocode, inject zone into message, pass to Claude
5. If text → detect campaign codes, apply rate limiting, call `processMessage()`
6. `coordinator.js` fetches all DB data in parallel, builds dynamic system prompt, calls Claude
7. Claude's reply is parsed for `<ORDEN>` JSON (order snapshot), `HANDOFF`/`HANDOFF_PAYMENT` tokens
8. Reply is sent to customer via WATI API
9. On `HANDOFF_PAYMENT`: create Zoho delivery record, pause bot, notify admin
10. On `HANDOFF`: pause bot, notify admin (human takes over)
11. When operator sends "Orden Confirmada" → close session, resume bot

---

## 2. ARCHITECTURE

### File tree
```
src/
  index.js                  Express server + webhook handler (entry point)
  agent.js                  Thin re-export shim → coordinator.js
  memory.js                 All Supabase reads/writes
  zoho.js                   Zoho CRM OAuth + record creation
  menu.js                   Legacy helper: reads menu from config table (rarely used)
  orchestrator/
    coordinator.js          Core message processing: prompt building, Claude call, handoff logic
  tools/
    geo.js                  GEOCODING_TOOLS schema + executeGeoTool() — called by coordinator tool loop
    order.js                Order type detection, quantity extraction, data extraction for Zoho
  prompts/
    core.md                 Claude identity + absolute rules (static markdown)
    schedule.js             Business hours section of system prompt (dynamic JS)
    delivery.js             Delivery zones/pricing section of system prompt (dynamic JS)
    orders.js               Order flow rules + payment section of system prompt (dynamic JS)
sql/
  almuerzo_delivery_tiers.sql  Table + seed data for almuerzo delivery pricing
  bot_flags.sql               Table definition (table still exists in Supabase but is no longer written to)
```

### Data flow: WATI webhook → Claude API → Zoho
```
WATI POST /webhook
  → index.js: dedup, stale-filter, echo-filter, owner-filter, bot-pause check
  → (media) → ack + notifyHandoff + triggerZohoOnPayment()
  → (location) → getDeliveryZoneByCoordinates() → enrich message → processMessage()
  → (text) → campaign code detection → processMessage()
      → coordinator.js processMessage()
          → upsertCustomer()
          → Fanesca campaign override (fast-path, no Claude)
          → getOrCreateSession()
          → parallel DB fetch: config, products, zones, tiers, almuerzos, payments, hours, history, storedGeo
          → buildSystemPrompt() → [core.md + schedule.js + delivery.js + orders.js]
          → inject stored address context hint into enrichedMessage (no zone lookup)
          → in-person order check (deterministic bypass)
          → confirmation check (deterministic bypass)
          → client.messages.create() with GEOCODING_TOOLS → Claude API
          → tool-calling loop: if stop_reason=tool_use → executeGeoTool() → feed result back → repeat
          → parse <ORDEN> JSON → savePendingOrder()
          → detect HANDOFF / HANDOFF_PAYMENT
          → (HANDOFF_PAYMENT) → createZohoDeliveryRecord() → clearPendingOrder()
          → return { reply, needsHandoff, needsPaymentHandoff }
  → sendWatiMessage() → WATI API → customer
  → (needsPaymentHandoff) → notifyHandoff() + pauseBot()
  → (needsHandoff) → notifyHandoff() + pauseBot()
```

### Multi-agent orchestration
There is no multi-agent framework. The "orchestration" is a single coordinator with:
- **Deterministic bypasses** before calling Claude (in-person close, confirmation fast-path, Fanesca campaign, weekend almuerzo)
- **Claude** for all other conversations, with **tool calling** for geocoding (`geocode_address`, `resolve_maps_url`)
- **Post-processing** that parses Claude's structured output (`<ORDEN>`, `HANDOFF_PAYMENT`, `HANDOFF`)

`src/agent.js` exists only as a re-export shim (`module.exports = require('./orchestrator/coordinator')`). It was originally the main file; all logic was moved to `coordinator.js`.

---

## 3. KEY FUNCTIONS

### `src/index.js`

| Function | What it does |
|---|---|
| `POST /webhook` handler | Main entry point. Filters duplicates, echoes, stale webhooks, paused bots. Routes media, location, and text messages. |
| `sendWatiMessage(phone, message)` | POSTs to WATI session message API. Registers outgoing message ID in `botSentMsgIds` to block echo. |
| `notifyHandoff(phone, name, type, lastMsg)` | Sends admin WhatsApp notification for `PAYMENT` or `GENERAL` handoff. |

**In-memory state** (lost on restart):
- `processedMsgIds` (Set, max 500) — dedup by `whatsappMessageId`
- `botSentMsgIds` (Set, max 500) — blocks WATI echo of our own messages
- `processingPhones` (Set) — rate-limit: one active message per phone
- `lastProcessed` (Map) — timestamp of last processed message per phone (500ms cooldown)

**Payment split**: if reply contains `"Una vez realices la transferencia"` (or similar), it splits into 2 messages with a 1s pause.

**Meta campaign codes**: `/ci`, `/wrq`, `/la`, `/wri` detected at end of message, saved to DB, stripped before Claude.

### `src/orchestrator/coordinator.js`

| Function | What it does | Returns |
|---|---|---|
| `processMessage(phone, message, name)` | Main processing function. Fetches all data, builds prompt, calls Claude, processes response. | `{ reply, needsHandoff, needsPaymentHandoff }` |
| `triggerZohoOnPayment(phone, name)` | Called when customer sends a payment image. Reads `pending_order` from DB and fires Zoho record creation. Non-blocking. | `void` |
| `closeOrderSession(phone)` | Called when operator sends "Orden Confirmada". Ends session. | `void` |
| `hasPendingOrder(phone)` | Exported to `index.js`; returns `true` if `pending_order` is non-null. | `Promise<boolean>` |
| `executeGeoTool(toolName, input, context)` | Re-exported from `src/tools/geo.js`. Executes a geocoding tool call from Claude. Calls Google Maps API, saves result to DB, returns structured JSON for tool_result. | `Promise<object>` |
| `buildSystemPrompt(...)` | Assembles full system prompt from core.md + 3 dynamic blocks. | `string` |

**`GEOCODING_TOOLS` + `executeGeoTool`** live in `src/tools/geo.js` and are imported by coordinator. Two tools:
- `geocode_address` — geocodes a text address, returns `{ zone, deliveryCost, isZone4, instruction }` or `{ lowConfidence }`
- `resolve_maps_url` — resolves a Google Maps URL to coords, returns same shape plus `locationUrl`

Claude calls these tools autonomously when a customer provides an address or Maps link. The coordinator loops (`while stop_reason === 'tool_use'`) until Claude produces a final text response.
| `nowInEcuador()` | Returns `Date` object in Ecuador time (UTC-5, fixed offset). | `Date` |
| `checkIsOpen(hoursData, now)` | Returns true if restaurant is currently open. Falls back to Mon-Fri 08:00-15:30. | `boolean` |
| `formatProducts(products)` | Formats product list grouped by category for system prompt. | `string` |
| `formatDeliveryZones(zones, tiers)` | Formats carta delivery zones and tiers for system prompt. | `string` |
| `formatWeekAlmuerzos(weekAlmuerzos, config)` | Formats current week's almuerzo menu for system prompt. | `string` |
| `formatPaymentMethods(methods)` | Formats bank account list for system prompt and payment bypass. | `string` |
| `formatAlmuerzoDeliveryTiers(tiers)` | Formats almuerzo delivery pricing table for system prompt. | `string` |

### `src/memory.js`

| Function | What it does |
|---|---|
| `saveMessage(phone, role, message, sessionId)` | Inserts message into `conversations` table, optionally scoped to session. |
| `getHistory(phone, sessionId)` | Returns last 20 messages for phone, session-scoped if sessionId provided. Reversed to chronological. |
| `upsertCustomer(phone, name)` | Insert or update row in `customers` table. |
| `getSystemPrompt()` | Reads `system_prompt` key from `config` table (legacy, not used in main flow). |
| `getConfig(key)` | Reads a single key from `config` table. |
| `getAllConfig()` | Returns all config rows as `{ key: value }` object. |
| `getProducts()` | Returns available products ordered by category + sort_order. |
| `getDeliveryZones()` | Returns available delivery zones with neighborhood info. |
| `getDeliveryTiers()` | Returns carta delivery tiers (order-value-based pricing per zone). |
| `getAlmuerzoDeliveryTiers()` | Returns almuerzo delivery tiers (quantity-based pricing per zone). |
| `getCurrentCycle()` | Returns current almuerzo menu cycle number. Auto-advances Monday; logs to `almuerzo_cycle_log`. |
| `getWeekAlmuerzos(cycle)` | Returns Mon-Fri almuerzo menu for given cycle. |
| `getPaymentMethods()` | Returns active bank accounts. |
| `getDeliveryZoneByAddress(address)` | Geocodes text address, calculates Haversine distance from restaurant, returns `{ zone, distanceKm, formattedAddress, locationType }`. |
| `resolveGoogleMapsUrl(url)` | Follows Google Maps short URL redirect, extracts lat/lng. No API key needed. |
| `getDeliveryZoneByCoordinates(lat, lng)` | Reverse-geocodes coordinates, calculates zone. Used for WhatsApp location pins. |
| `saveDeliveryAddress(phone, address, zone, distanceKm)` | Saves geocoded address + zone + distance to `customers`. |
| `saveRawAddress(phone, rawAddress)` | Saves customer-typed address without zone (geocode failed or low confidence). |
| `saveLocationPin(phone, lat, lng)` | Saves `last_location_pin: {lat, lng}` and `last_location_url` (clean Maps URL) to `customers`. |
| `saveDeliveryZoneOnly(phone, zone, distanceKm)` | Saves zone + distance without overwriting text address. Used for location pins. |
| `getCustomerAddress(phone)` | Returns `{ customerName, address, zone, distanceKm, locationPin, locationUrl, campana }`. |
| `saveCampanaMeta(phone, campana)` | Saves Meta ad campaign attribution to `customers.campana_meta`. |
| `lookupDeliveryCost(zone, orderType, total, cantidad)` | Queries DB tiers for authoritative delivery cost. Returns `number` or `null`. |
| `savePendingOrder(phone, orderData)` | Saves order snapshot JSONB to `customers.pending_order`. |
| `getPendingOrder(phone)` | Returns `pending_order` JSONB or `null`. |
| `clearPendingOrder(phone)` | Sets `pending_order = null`. Called after Zoho record is created. |
| `getOrCreateSession(phone)` | Returns current session UUID or creates a new one. Expires after 6h of inactivity. |
| `endSession(phone)` | Nulls out `current_session_id` and `session_last_activity_at`. |
| `getBusinessHours()` | Returns weekly schedule from `business_hours` table. |
| `isBotPaused(phone)` | Returns `customers.bot_paused` boolean. |
| `pauseBot(phone)` | Sets `bot_paused = true`. |
| `resumeBot(phone)` | Sets `bot_paused = false`. |

### `src/zoho.js`

| Function | What it does |
|---|---|
| `getZohoAccessToken()` | Returns valid OAuth2 token. Caches in-memory, refreshes via refresh_token when expired. |
| `lookupZohoContact(phone)` | Searches Contacts by phone number. Returns `{ id, name }` or `null`. |
| `createZohoContact(phone, name)` | Creates Zoho Contact. Returns new contact `id`. |
| `mapTurnoToPickList(turno)` | Maps raw turno string to Zoho pick-list value: `"12:30 a 1:30"`, `"1:30 a 2:30"`, `"2:30 a 3:30"`, `"Inmediato"`. |
| `createZohoDeliveryRecord(orderData)` | Main entry: looks up/creates Contact, then creates record in `Planificacion_de_Entregas`. Returns record ID. |

### `src/tools/geo.js`

| Export | What it does |
|---|---|
| `GEOCODING_TOOLS` | Tool schema array passed to every Claude API call. Defines `geocode_address` and `resolve_maps_url`. |
| `executeGeoTool(toolName, input, context)` | Executes whichever tool Claude called. Geocodes via Google Maps, checks confidence, saves to DB, returns structured result for `tool_result`. |

### `src/tools/order.js`

| Function | What it does |
|---|---|
| `detectOrderTypeFromHistory(history)` | Returns `'almuerzo'`, `'carta'`, or `'mixed'` based on user messages + bot summary lines. |
| `detectAlmuerzoQty(history)` | Returns integer count of almuerzos from user messages and bot summaries. Defaults to 1. |
| `parseScheduledDate(dateStr)` | Parses Spanish date string (`"lunes 2 de marzo"`) → `YYYY-MM-DD`. Returns `null` on failure. |
| `extractAddressFromHistory(history)` | Scans history for user reply after bot asked "dirección completa 📍". |
| `extractTurnoFromHistory(history)` | Scans recent history for turno/hora mention. |
| `extractOrderDataForZoho(summaryMsg, history, phone, name, ...)` | Parses order summary message into structured `orderData` for Zoho. Used only by legacy path; main path uses `<ORDEN>` JSON. |

---

## 4. SUPABASE TABLES

### `customers`
One row per phone number.

| Column | Type | Purpose |
|---|---|---|
| `phone` | text PK | WhatsApp phone number |
| `name` | text | Customer name from WATI |
| `bot_paused` | boolean | True when human operator has taken over |
| `last_delivery_address` | text | Geocoded or raw-text address (typed by customer) |
| `last_delivery_zone` | integer | Delivery zone (1-4) from most recent geocode |
| `last_delivery_distance_km` | numeric | Haversine distance from restaurant |
| `last_location_pin` | jsonb | `{ lat, lng }` from WhatsApp location pin |
| `last_location_url` | text | Clean `https://www.google.com/maps?q=lat,lng` URL |
| `pending_order` | jsonb | Order snapshot (see shape below). Null when no active order. |
| `current_session_id` | uuid | Active session ID (null = no active session) |
| `session_last_activity_at` | timestamptz | Last message time; session expires after 6h |
| `campana_meta` | text | Meta ad campaign attribution (e.g. `'Lookalike 1% - 2%'`) |

**`pending_order` JSONB shape** (frozen at order summary time):
```json
{
  "phone": "593...",
  "customerName": "...",
  "total": 19.00,
  "deliveryCost": 1.50,
  "address": "Dirección exacta del cliente",
  "turno": "13:30",
  "itemsText": "2 Fanescas — $9.50 c/u | 1 Jugo Natural — $2.50",
  "scheduledDate": "2026-04-25",
  "cantidad": null,
  "orderType": "carta",
  "horarioEntrega": "Inmediato",
  "fechaEnvio": "2026-04-25",
  "locationPin": { "lat": -0.19, "lng": -78.48 },
  "locationUrl": "https://www.google.com/maps?q=-0.19,-78.48",
  "campana": "Lookalike 1% - 2%"
}
```

### `conversations`
One row per message.

| Column | Type | Purpose |
|---|---|---|
| `id` | serial PK | |
| `customer_phone` | text | FK to customers |
| `role` | text | `'user'` or `'assistant'` |
| `message` | text | Message text |
| `session_id` | uuid | Links to `customers.current_session_id` |
| `timestamp` | timestamptz | Auto |

### `config`
Key-value store for all restaurant configuration.

| Key | Purpose |
|---|---|
| `restaurant_name` | Restaurant display name |
| `restaurant_address` | Physical address (for customer queries) |
| `restaurant_maps` | Google Maps URL |
| `restaurant_phone` | Phone number |
| `restaurant_email` | Email |
| `business_hours` | Legacy text (display only; logic uses `business_hours` table) |
| `almuerzo_price_delivery` | Almuerzo price for delivery/takeout orders |
| `almuerzo_price_instore` | Almuerzo price for in-restaurant consumption |
| `almuerzo_includes` | What almuerzo includes (e.g., "Sopa, Plato Fuerte, Jugo Natural y Postre") |
| `almuerzo_cycle_count` | Total number of almuerzo menu cycles (e.g., 5) |
| `current_cycle` | Current active cycle number |
| `cycle_last_updated` | `YYYY-MM-DD` of the Monday this cycle started |
| `almuerzo_cycle_log` | JSON array of cycle advances (audit trail) |
| `payment_instructions` | Extra payment instructions shown to customers |

### `products`
One row per carta menu item.

| Column | Type | Purpose |
|---|---|---|
| `name` | text | Product name |
| `description` | text | Ingredients/description (used by Claude for product queries) |
| `price` | numeric | Price in USD |
| `category` | text | Menu category (groups items in prompt) |
| `available` | boolean | Only `true` rows are fetched |
| `sort_order` | integer | Display order within category |

### `delivery_zones`
| Column | Purpose |
|---|---|
| `zone_number` | 1-4 |
| `label` | Internal label |
| `price` | Base delivery price (overridden by tiers) |
| `min_order` | Minimum order value for delivery |
| `neighborhoods` | Comma-separated list shown in system prompt |
| `requires_approval` | If true, always HANDOFF (Zone 4) |
| `available` / `sort_order` | Filter/order |

### `delivery_tiers`
Order-value-based delivery pricing for carta orders.

| Column | Purpose |
|---|---|
| `zone_number` | 1-4 |
| `order_min` | Minimum order value for this tier |
| `order_max` | Maximum order value (null = open-ended) |
| `delivery_price` | Delivery cost for this range |
| `sort_order` | |

### `almuerzo_delivery_tiers`
Quantity-based delivery pricing for almuerzo-only orders.

| Column | Purpose |
|---|---|
| `zone_number` | 1-4 |
| `min_qty` | Minimum number of almuerzos |
| `max_qty` | Maximum (null = open-ended) |
| `delivery_price` | Delivery cost |
| `is_free` | If true, delivery is free |
| `requires_approval` | If true, HANDOFF (Zone 4) |

Current data:
- Zone 1: 1 almuerzo = $0.50, 2+ = FREE
- Zone 2: 1 almuerzo = $1.50, 2+ = $1.00
- Zone 3: 1 almuerzo = $2.50, 2+ = $2.00
- Zone 4: always supervisor (HANDOFF)

### `almuerzos`
Weekly almuerzo menu by cycle.

| Column | Purpose |
|---|---|
| `cycle` | Cycle number (1 to almuerzo_cycle_count) |
| `day_of_week` | 1=Mon ... 5=Fri |
| `soup` | Soup name |
| `main` | Main course name |
| `available` | Filter |

### `payment_methods`
| Column | Purpose |
|---|---|
| `bank` | Bank name |
| `account_type` | Checking/savings |
| `account_number` | Account number |
| `account_holder` | Name on account |
| `cedula` | National ID (Ecuador) |
| `available` / `sort_order` | Filter/order |

### `business_hours`
| Column | Purpose |
|---|---|
| `day_of_week` | 0=Sun ... 6=Sat |
| `day_name` | Spanish day name |
| `open_time` | TIME (`HH:MM:SS`) or null = closed |
| `close_time` | TIME (`HH:MM:SS`) or null = closed |

### `bot_flags`
Geocoding state flags (Supabase-persisted so they survive server restarts).

| Column | Purpose |
|---|---|
| `phone` | PK |
| `geocode_clarification_pending` | True when bot asked for address clarification after low-confidence geocode |
| `house_number_pending` | True when bot needs house number / building supplement |
| `updated_at` | Timestamp |

---

## 5. ENVIRONMENT VARIABLES

| Variable | Required | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | Yes | Claude API key |
| `SUPABASE_URL` | Yes | Supabase project URL |
| `SUPABASE_KEY` | Yes | Supabase service role key |
| `WATI_API_KEY` | Yes | WATI Bearer token for sending messages |
| `GOOGLE_MAPS_API_KEY` | Yes | Google Maps Geocoding API key |
| `ADMIN_PHONE` | Yes | WhatsApp phone for handoff notifications |
| `ZOHO_CLIENT_ID` | Yes (for Zoho) | Zoho OAuth2 client ID |
| `ZOHO_CLIENT_SECRET` | Yes (for Zoho) | Zoho OAuth2 client secret |
| `ZOHO_REFRESH_TOKEN` | Yes (for Zoho) | Zoho OAuth2 refresh token (offline flow) |
| `ZOHO_ACCOUNTS_URL` | No | Zoho auth URL (default: `https://accounts.zoho.com`) |
| `ZOHO_API_DOMAIN` | No | Zoho API domain (default: `https://www.zohoapis.com`) |
| `ZOHO_MODULE_API_NAME` | No | Custom module API name (default: `Planificacion_de_Entregas`) |
| `WATI_BOT_EMAIL` | No | Bot's email in WATI (used to filter echo messages) |
| `WATI_HUMAN_EMAIL` | No | Human operator email (legacy; any non-bot email now triggers operator logic) |
| `WATI_BOT_ASSIGNED_ID` | No | Bot's assignedId in WATI (preferred over email for echo detection) |
| `PORT` | No | HTTP server port (default: 3000) |

---

## 6. BUSINESS LOGIC

### Delivery zones (4 zones)
Zones are calculated by Haversine straight-line distance from the restaurant (América y Juan José de Villalengua, Quito: `-0.1723433, -78.4910016`):

| Zone | Distance | Carta delivery | Notes |
|---|---|---|---|
| 1 | 0–2 km | Tiered by order value | Almuerzo: $0.50 / 2+ FREE |
| 2 | 2–4 km | Tiered by order value | Almuerzo: $1.50 / 2+ $1.00 |
| 3 | 4–6 km | Tiered by order value | Almuerzo: $2.50 / 2+ $2.00 |
| 4 | 6+ km | ALWAYS HANDOFF | Supervisor must quote manually |

Zone numbers are **never shown to customers**. Claude is instructed to never mention zone numbers.

### Order flow steps
```
PASO 1: Greeting (brief, no menu spam)
PASO 2: Answer query (menu link, prices, hours, delivery cost)
PASO 3: Order flow
  a) Build item list (accumulative, never delete items)
  b) Ask: delivery or in-person?
  c) In-person → close conversation (no payment via bot)
  d) Delivery → ask address (if not stored)
  e) Show summary: items + subtotal + delivery + TOTAL
     + emit <ORDEN>{...}</ORDEN> JSON block (stripped before sending to customer)
  f) Ask: "Confirmas tu pedido?" (MANDATORY — never skip)
PASO 4: Payment
  - Send bank accounts + amount
  - Ask for payment screenshot
  - On receipt → HANDOFF_PAYMENT
PASO 5: Handoff triggers (escalation, complaints, order status)
```

### Geocoding logic
Geocoding is handled via **Claude tool calling**. Two tools are defined in `GEOCODING_TOOLS` (coordinator.js) and executed by `executeGeoTool()`:

- **`geocode_address`** — Claude calls this when the customer provides a text address. Geocodes via Google Maps, checks confidence, saves to DB, returns `{ zone, deliveryCost, isZone4, instruction }` or `{ lowConfidence: true }`.
- **`resolve_maps_url`** — Claude calls this when the customer sends a Google Maps link. Follows redirect to extract coords, reverse-geocodes, saves pin + zone, returns same shape.

The coordinator loops `while (response.stop_reason === 'tool_use')` feeding tool results back until Claude produces a final text response.

**Exception**: native WhatsApp location pins (`messageType === 'location'` in `index.js`) are still handled deterministically before `processMessage()` — they are reverse-geocoded and the zone is injected into the message text passed to Claude.

Low-confidence geocodes (`GEOMETRIC_CENTER` or `APPROXIMATE`) return `lowConfidence: true` — Claude naturally asks for a more specific reference.

Zone 4 results return `isZone4: true` with an exact scripted response + `HANDOFF` instruction that Claude must follow verbatim.

**`bot_flags` table** (`geocode_clarification_pending`, `house_number_pending`) is no longer written to. The table still exists in Supabase but is unused.

### Session management
- Sessions are UUIDs stored in `customers.current_session_id`
- A session expires after **6 hours** of inactivity (`SESSION_EXPIRY_MS`)
- `getOrCreateSession()` returns the existing session or creates a new one
- All `saveMessage()` and `getHistory()` calls are scoped to the session ID
- This prevents old completed orders from leaking into Claude's context
- Sessions end via `endSession()` called from `closeOrderSession()` — only when operator sends "Orden Confirmada"
- Automatic expiry handles customers who return the next day

### Bot pause / resume (human handoff)
- `pauseBot(phone)` sets `customers.bot_paused = true`
- `resumeBot(phone)` sets `bot_paused = false`
- Automatic pause triggers: `HANDOFF`, `HANDOFF_PAYMENT`, human operator message in WATI
- Automatic resume triggers: WATI conversation assigned to bot account, `#resume` command, operator provides delivery cost/zone (auto-resume), operator sends "Orden Confirmada"
- While paused, customer text messages are still saved to conversation history so Claude has full context when resumed

### HANDOFF and HANDOFF_PAYMENT tokens
Claude emits these tokens in its reply text. The coordinator strips them from the reply sent to the customer.

- `HANDOFF`: general escalation. Triggers `notifyHandoff(phone, name, 'GENERAL')` + `pauseBot()`
- `HANDOFF_PAYMENT`: customer confirmed they sent payment. Triggers:
  1. `notifyHandoff(phone, name, 'PAYMENT')`
  2. `createZohoDeliveryRecord(orderData)` (non-blocking)
  3. `clearPendingOrder(phone)`
  4. `pauseBot()`

Zone 4 also triggers HANDOFF immediately when address is identified — no order summary is shown.

### The `<ORDEN>` JSON block
When Claude shows the order summary ("Confirmas tu pedido?"), it must append a hidden JSON block:

```
<ORDEN>{"total":19.00,"itemsText":"2 Fanescas — $9.50 c/u","orderType":"carta","cantidad":null,"turno":null,"scheduledDate":null,"horarioEntrega":"Inmediato","address":"Dirección del cliente","deliveryCost":1.50}</ORDEN>
```

- **Stripped** from the reply before sending to customer and before saving to history
- **Parsed** by `coordinator.js` immediately after Claude responds
- **Merged** with fresh DB data (customerName, locationPin, locationUrl, campana) → saved as `customers.pending_order`
- If Claude emits "Confirmas tu pedido?" without `<ORDEN>`, a **retry** is fired with an explicit instruction
- `pending_order` becomes the single source of truth for Zoho record creation

### Zoho record creation flow
Triggered by `HANDOFF_PAYMENT` (text confirmation) or image receipt (payment screenshot).

1. `getPendingOrder(phone)` — read frozen snapshot
2. Enrich with fresh DB data: `customerName`, `locationPin`, `locationUrl`, `campana`, delivery cost if needed
3. `lookupZohoContact(phone)` — search by phone
4. If not found → `createZohoContact(phone, name)`
5. Build record: `Name`, `Cliente`, `Telefono`, `Notas_de_Cocina`, `Direccion`, `Ubicacion`, `Horario_de_Entrega`, `Valor_Venta`, `Envio_Cobrado`, `Estado = 'Pendiente de Pago'`, `Tipo_de_Entrega = 'Individual'`, `Fuente = 'WhatsAppBot'`, `Fecha_de_Envio`, optionally `Cantidad`, `Campana_Meta`
6. POST to Zoho with `trigger: ['workflow']`

**Zoho workflow split** (controlled by `Fuente` field):
- Workflow 1 (on CREATE, `Fuente != WhatsAppBot`): fires kitchen print immediately — human-created records
- Workflow 2 (on EDIT, `Fuente = WhatsAppBot`, Estado changed to `Pago Confirmado`): fires kitchen print — bot records after human approval

The human operator changes `Estado` from `'Pendiente de Pago'` to `'Pago Confirmado'` in Zoho after verifying the payment transfer.

---

## 7. KNOWN ISSUES AND DECISIONS

### Geocoding refactor: regex pre-processing → Claude tool calling
`src/tools/geo.js` (~500 lines of regex + state flags) was replaced with Claude tool calling. Previously the coordinator pre-processed every message with heuristics to detect addresses, then injected `[SISTEMA]` tags. Now Claude decides when to call `geocode_address` or `resolve_maps_url`, executes them in a loop, and uses the returned cost directly. The `bot_flags` Supabase table (`geocode_clarification_pending`, `house_number_pending`) is no longer written to.

### Why prompt caching was added
The system prompt is large (all menu data, delivery zones, tiers, business hours, almuerzo menu) and is rebuilt from DB data on every request. Claude's prompt caching (`cache_control: { type: 'ephemeral' }` on the system block) was added to reduce token costs when the system prompt content is identical across consecutive requests. Cache hit/miss is logged per request.

### Duplicate Zoho records — prevention strategy
Bug 2+3: customer could send a payment image AND a "ya transferí" text message in quick succession, creating 2 Zoho records with corrupt data (bot sentences as address). Solution:
- `triggerZohoOnPayment()` reads `pending_order` from DB and returns early if null
- After Zoho fires, `clearPendingOrder()` immediately nulls the snapshot
- Subsequent images or text confirmations find `pending_order = null` and skip Zoho
- There is intentionally NO history-scan fallback — it was removed because it produced garbage data

### Bug 4: delivery cost change when zone changes mid-order
When a customer provided a text address (Zone 2, $1.50 delivery), then sent a GPS pin resolving to Zone 3 ($2.00 delivery), the existing `pending_order` had the wrong delivery cost. Fix: both `index.js` (location handler) and `geo.js` (Maps URL handler) detect this cost change, inject a `costChangeWarning` into the `[SISTEMA]` tag, and clear `pending_order` so Claude regenerates the summary.

### Fanesca campaign override
A temporary fast-path in `coordinator.js` intercepts Fanesca-related messages from a Meta Ads campaign (Semana Santa 2026). It bypasses Claude and returns a hardcoded pitch/price/order-intake message. Marked `// TODO: REMOVE after campaign ends`. Detection criteria:
- Standard CTA text: "Quiero información sobre la Fanesca"
- Ad copy paste (contains fb.me URL, "Dirección por favor", or 3+ checkmarks)
- Price question mentioning "fanesca"
- Delivery question mentioning "fanesca"

### Confirmation bypass: only fires when `pending_order` exists
If Claude sent a summary with "Confirmas tu pedido?" but without the `<ORDEN>` block (model refused or was cut off), `pending_order` is null. The confirmation bypass checks for null and falls through to Claude with an explicit retry instruction, forcing Claude to regenerate the summary with the `<ORDEN>` block.

### Weekend almuerzo — deterministic HANDOFF
Before any Claude call, if the current day is Saturday or Sunday AND the message mentions "almuerzo", a hardcoded HANDOFF is fired. Claude is never called. The weekend menu is not programmed — a human must confirm availability.

---

## 8. HOW TO RUN AND DEPLOY

### Local setup
```bash
# 1. Install dependencies
npm install

# 2. Create .env file in project root with all env vars (see section 5)
cp .env.example .env   # if example exists, otherwise create manually

# 3. Start with hot reload
npm run dev

# 4. Expose localhost to WATI (use ngrok or similar)
ngrok http 3000
# Set the ngrok URL as WATI webhook URL
```

### Start command
```bash
npm start
# or directly:
node src/index.js
```

### Railway deployment
- Railway is connected to the GitHub repository (`git@github.com:neurona-ds/micasa-agent.git`)
- Every push to `main` triggers an automatic redeploy
- All env vars are set in Railway project settings
- Railway provides `PORT` automatically; the app reads it from `process.env.PORT || 3000`

```bash
# Deploy: just push to main
git push origin main
```

### Required Supabase migrations
Run these SQL statements once in the Supabase SQL editor if the tables don't exist:

```sql
-- From sql/bot_flags.sql
CREATE TABLE IF NOT EXISTS bot_flags (
  phone text primary key,
  geocode_clarification_pending boolean default false,
  house_number_pending boolean default false,
  updated_at timestamptz default now()
);
CREATE INDEX IF NOT EXISTS bot_flags_updated_at_idx ON bot_flags(updated_at);

-- From sql/almuerzo_delivery_tiers.sql
-- (see full file for complete CREATE TABLE + seed data)

-- Session management columns (run manually if missing)
ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS current_session_id UUID,
  ADD COLUMN IF NOT EXISTS session_last_activity_at TIMESTAMPTZ;
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS session_id UUID;
CREATE INDEX IF NOT EXISTS idx_conversations_session_id ON conversations(session_id);

-- Location pin columns (run manually if missing)
ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS last_location_pin JSONB,
  ADD COLUMN IF NOT EXISTS last_location_url TEXT;

-- Campaign attribution
ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS campana_meta TEXT;
```

### Manually correcting the almuerzo cycle
Update both rows atomically in Supabase — updating only one causes incorrect auto-advance:
```sql
UPDATE config SET value = '3' WHERE key = 'current_cycle';
UPDATE config SET value = '2026-04-21' WHERE key = 'cycle_last_updated';
-- value must be the Monday of the current week in YYYY-MM-DD format
```

### Health check
```
GET /
→ { "status": "Micasa Restaurante Agent is running!" }
```

---

## 9. CRITICAL RULES (DO NOT CHANGE)

These rules exist in `src/prompts/` and `src/orchestrator/coordinator.js`. Breaking them causes business or data integrity failures.

1. **Order summary detection regex** (`/\bTOTAL[:\s]+\$[\d.]+/i` AND `/[Ee]nv[ií]o[:\s]+[\$G]/i`) — do not change to text-based detection.
2. **`<ORDEN>` block** — Claude must emit this after every "Confirmas tu pedido?". The block is machine-readable; customers never see it. The retry logic depends on its presence.
3. **`pending_order`** is the single source of truth for Zoho — no history-scan fallback.
4. **`clearPendingOrder()` runs immediately after Zoho fires** — prevents duplicate records.
5. **Session ends only when operator sends "Orden Confirmada"** — not on image receipt, not on HANDOFF_PAYMENT text.
6. **Zone numbers are never mentioned to customers** — always injected as `[SISTEMA]` tags.
7. **`Fuente = 'WhatsAppBot'`** gates Zoho workflow — do not remove this field.
8. **`⛔ REGLA ABSOLUTA — CONFIRMACIÓN OBLIGATORIA`** in `orders.js` — payment data must never appear before "Confirmas tu pedido?" is answered.
