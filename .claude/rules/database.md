---
paths:
  - "src/memory.js"
  - "sql/**"
---

# Database — Supabase Tables & memory.js

All Supabase reads/writes are in `src/memory.js`.

## Tables Overview

| Table | Purpose |
|---|---|
| `customers` | One row per phone number |
| `conversations` | One row per message |
| `config` | Key-value store for restaurant configuration |
| `products` | Carta menu items |
| `delivery_zones` | Zone definitions with neighborhoods |
| `delivery_tiers` | Order-value-based pricing for carta |
| `almuerzo_delivery_tiers` | Quantity-based pricing for almuerzo |
| `almuerzos` | Weekly almuerzo menu by cycle |
| `payment_methods` | Bank accounts |
| `business_hours` | Weekly schedule |
| `bot_flags` | Geocoding state flags (DEPRECATED — no longer written to) |

---

## `customers`

One row per phone number.

| Column | Type | Purpose |
|---|---|---|
| `phone` | text PK | WhatsApp phone number |
| `name` | text | Customer name from WATI |
| `bot_paused` | boolean | True when human operator has taken over |
| `last_delivery_address` | text | Geocoded or raw-text address |
| `last_delivery_zone` | integer | Delivery zone (1-4) from most recent geocode |
| `last_delivery_distance_km` | numeric | Haversine distance from restaurant |
| `last_location_pin` | jsonb | `{ lat, lng }` from WhatsApp location pin |
| `last_location_url` | text | Clean `https://www.google.com/maps?q=lat,lng` URL |
| `pending_order` | jsonb | Order snapshot. Null when no active order. |
| `current_session_id` | uuid | Active session ID (null = no active session) |
| `session_last_activity_at` | timestamptz | Last message time; session expires after 6h |
| `campana_meta` | text | Meta ad campaign attribution |

### `pending_order` JSONB Shape

Frozen at order summary time:
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

---

## `conversations`

One row per message.

| Column | Type | Purpose |
|---|---|---|
| `id` | serial PK | |
| `customer_phone` | text | FK to customers |
| `role` | text | `'user'` or `'assistant'` |
| `message` | text | Message text |
| `session_id` | uuid | Links to `customers.current_session_id` |
| `timestamp` | timestamptz | Auto |

---

## `config`

Key-value store for restaurant configuration.

| Key | Purpose |
|---|---|
| `restaurant_name` | Restaurant display name |
| `restaurant_address` | Physical address |
| `restaurant_maps` | Google Maps URL |
| `restaurant_phone` | Phone number |
| `restaurant_email` | Email |
| `business_hours` | Legacy text (display only) |
| `almuerzo_price_delivery` | Almuerzo price for delivery/takeout |
| `almuerzo_price_instore` | Almuerzo price for in-restaurant |
| `almuerzo_includes` | What almuerzo includes |
| `almuerzo_cycle_count` | Total number of menu cycles |
| `current_cycle` | Current active cycle number |
| `cycle_last_updated` | `YYYY-MM-DD` of Monday this cycle started |
| `almuerzo_cycle_log` | JSON array of cycle advances (audit) |
| `payment_instructions` | Extra payment instructions |

---

## `products`

| Column | Type | Purpose |
|---|---|---|
| `name` | text | Product name |
| `description` | text | Ingredients/description |
| `price` | numeric | Price in USD |
| `category` | text | Menu category |
| `available` | boolean | Only `true` rows fetched |
| `sort_order` | integer | Display order within category |

---

## `delivery_zones`

| Column | Purpose |
|---|---|
| `zone_number` | 1-4 |
| `label` | Internal label |
| `price` | Base delivery price (overridden by tiers) |
| `min_order` | Minimum order value |
| `neighborhoods` | Comma-separated list |
| `requires_approval` | If true, always HANDOFF (Zone 4) |
| `available` / `sort_order` | Filter/order |

---

## `delivery_tiers`

Order-value-based pricing for carta orders.

| Column | Purpose |
|---|---|
| `zone_number` | 1-4 |
| `order_min` | Minimum order value for tier |
| `order_max` | Maximum (null = open-ended) |
| `delivery_price` | Delivery cost |
| `sort_order` | |

---

## `almuerzo_delivery_tiers`

Quantity-based pricing for almuerzo-only orders.

| Column | Purpose |
|---|---|
| `zone_number` | 1-4 |
| `min_qty` | Minimum number of almuerzos |
| `max_qty` | Maximum (null = open-ended) |
| `delivery_price` | Delivery cost |
| `is_free` | If true, delivery is free |
| `requires_approval` | If true, HANDOFF (Zone 4) |

**Current data:**
- Zone 1: 1 almuerzo = $0.50, 2+ = FREE
- Zone 2: 1 almuerzo = $1.50, 2+ = $1.00
- Zone 3: 1 almuerzo = $2.50, 2+ = $2.00
- Zone 4: always supervisor (HANDOFF)

---

## `almuerzos`

| Column | Purpose |
|---|---|
| `cycle` | Cycle number (1 to almuerzo_cycle_count) |
| `day_of_week` | 1=Mon ... 5=Fri |
| `soup` | Soup name |
| `main` | Main course name |
| `available` | Filter |

---

## `payment_methods`

| Column | Purpose |
|---|---|
| `bank` | Bank name |
| `account_type` | Checking/savings |
| `account_number` | Account number |
| `account_holder` | Name on account |
| `cedula` | National ID (Ecuador) |
| `available` / `sort_order` | Filter/order |

---

## `business_hours`

| Column | Purpose |
|---|---|
| `day_of_week` | 0=Sun ... 6=Sat |
| `day_name` | Spanish day name |
| `open_time` | TIME or null = closed |
| `close_time` | TIME or null = closed |

---

## `bot_flags` (DEPRECATED)

No longer written to. Table still exists but is unused.

| Column | Purpose |
|---|---|
| `phone` | PK |
| `geocode_clarification_pending` | Was: true when bot asked for clarification |
| `house_number_pending` | Was: true when bot needs house number |
| `updated_at` | Timestamp |

---

## memory.js Functions

### Messages & History

| Function | What it does |
|---|---|
| `saveMessage(phone, role, message, sessionId)` | Inserts into `conversations`, scoped to session |
| `getHistory(phone, sessionId)` | Returns last 20 messages, session-scoped, chronological |

### Customers

| Function | What it does |
|---|---|
| `upsertCustomer(phone, name)` | Insert or update `customers` row |
| `getCustomerAddress(phone)` | Returns `{ customerName, address, zone, distanceKm, locationPin, locationUrl, campana }` |

### Config & Products

| Function | What it does |
|---|---|
| `getSystemPrompt()` | Reads `system_prompt` key (legacy, unused) |
| `getConfig(key)` | Reads single key from `config` |
| `getAllConfig()` | Returns all config as `{ key: value }` |
| `getProducts()` | Returns available products by category + sort_order |

### Delivery

| Function | What it does |
|---|---|
| `getDeliveryZones()` | Returns available zones with neighborhoods |
| `getDeliveryTiers()` | Returns carta tiers |
| `getAlmuerzoDeliveryTiers()` | Returns almuerzo tiers |
| `getDeliveryZoneByAddress(address)` | Geocodes, returns `{ zone, distanceKm, formattedAddress, locationType }` |
| `resolveGoogleMapsUrl(url)` | Follows redirect, extracts lat/lng |
| `getDeliveryZoneByCoordinates(lat, lng)` | Reverse-geocodes, calculates zone |
| `saveDeliveryAddress(phone, address, zone, distanceKm)` | Saves geocoded address + zone |
| `saveRawAddress(phone, rawAddress)` | Saves address without zone |
| `saveLocationPin(phone, lat, lng)` | Saves `last_location_pin` and `last_location_url` |
| `saveDeliveryZoneOnly(phone, zone, distanceKm)` | Saves zone without overwriting address |
| `lookupDeliveryCost(zone, orderType, total, cantidad)` | Queries tiers for authoritative cost |

### Almuerzo

| Function | What it does |
|---|---|
| `getCurrentCycle()` | Returns current cycle number. **Pure read — never writes.** pg_cron owns the advance. |
| `getWeekAlmuerzos(cycle)` | Returns Mon-Fri menu for cycle |

### Payment

| Function | What it does |
|---|---|
| `getPaymentMethods()` | Returns active bank accounts |

### Orders

| Function | What it does |
|---|---|
| `savePendingOrder(phone, orderData)` | Saves JSONB to `customers.pending_order` |
| `getPendingOrder(phone)` | Returns `pending_order` or null |
| `clearPendingOrder(phone)` | Sets `pending_order = null` |

### Sessions

| Function | What it does |
|---|---|
| `getOrCreateSession(phone)` | Returns existing or creates new UUID. Expires after 6h. |
| `endSession(phone)` | Nulls `current_session_id` and `session_last_activity_at` |
| `getBusinessHours()` | Returns weekly schedule |

### Bot State

| Function | What it does |
|---|---|
| `isBotPaused(phone)` | Returns `customers.bot_paused` |
| `pauseBot(phone)` | Sets `bot_paused = true` |
| `resumeBot(phone)` | Sets `bot_paused = false` |

### Campaign

| Function | What it does |
|---|---|
| `saveCampanaMeta(phone, campana)` | Saves to `customers.campana_meta` |

---

## Required Migrations

```sql
-- Session management columns
ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS current_session_id UUID,
  ADD COLUMN IF NOT EXISTS session_last_activity_at TIMESTAMPTZ;
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS session_id UUID;
CREATE INDEX IF NOT EXISTS idx_conversations_session_id ON conversations(session_id);

-- Location pin columns
ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS last_location_pin JSONB,
  ADD COLUMN IF NOT EXISTS last_location_url TEXT;

-- Campaign attribution
ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS campana_meta TEXT;
```

## Almuerzo Cycle Correction

Update both rows atomically:
```sql
UPDATE config SET value = '3' WHERE key = 'current_cycle';
UPDATE config SET value = '2026-04-21' WHERE key = 'cycle_last_updated';
-- value must be the Monday of the current week
```
