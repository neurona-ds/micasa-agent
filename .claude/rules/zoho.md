---
paths:
  - "src/zoho.js"
---

# Zoho CRM Integration — src/zoho.js

OAuth2 authentication and record creation for `Planificacion_de_Entregas` custom module.

## Functions

| Function | What it does |
|---|---|
| `getZohoAccessToken()` | Returns valid OAuth2 token. Caches in-memory, refreshes via refresh_token when expired. |
| `lookupZohoContact(phone)` | Searches Contacts by phone. Returns `{ id, name }` or `null`. |
| `createZohoContact(phone, name)` | Creates Zoho Contact. Returns new contact `id`. |
| `mapTurnoToPickList(turno)` | Maps raw turno to Zoho pick-list value. |
| `createZohoDeliveryRecord(orderData)` | Main entry: looks up/creates Contact, creates delivery record. Returns record ID. |

## Zoho Record Creation Flow

Triggered by `HANDOFF_PAYMENT` (text) or payment image.

1. `getPendingOrder(phone)` — read frozen snapshot
2. Enrich with fresh DB data: `customerName`, `locationPin`, `locationUrl`, `campana`, delivery cost
3. `lookupZohoContact(phone)` — search by phone
4. If not found → `createZohoContact(phone, name)`
5. Build record with all fields
6. POST to Zoho with `trigger: ['workflow']`

## Field Mapping

| Code Field | Zoho API Field | Notes |
|---|---|---|
| `total` | `Valor_Venta` | |
| `deliveryCost` | `Envio_Cobrado` | Currency field — must NOT be read-only |
| `horarioEntrega` | `Horario_de_Entrega` | Almuerzo → slot, Carta → raw time or 'Inmediato' |
| `fechaEnvio` | `Fecha_de_Envio` | |
| `itemsText` | `Notas_de_Cocina` | |
| `address` | `Direccion` | |
| `locationUrl` | `Ubicacion` | Google Maps URL |
| `cantidad` | `Cantidad` | Almuerzo orders only |
| `campana` | `Campana_Meta` | Meta ad attribution |
| — | `Cliente` | Zoho Contact lookup ID |
| — | `Telefono` | Phone number |
| `'Individual'` | `Tipo_de_Entrega` | Always 'Individual' |
| `'WhatsAppBot'` | `Fuente` | Gates workflow split |
| `'Pendiente de Pago'` | `Estado` | Human changes to 'Pago Confirmado' |

## Horario_de_Entrega Logic

### Almuerzo Orders
Maps to slot pick-list:
- `"12:30 a 1:30"`
- `"1:30 a 2:30"`
- `"2:30 a 3:30"`
- `"Inmediato"`

### Carta Orders
- Customer gave time → raw time string (e.g., `'9:30'`)
- No time given → `'Inmediato'`

`'Inmediato'` does NOT mean same-day only — it means no specific time was requested.

## Zoho Workflow Split

Controlled by `Fuente` field:

| Workflow | Trigger | Condition | Action |
|---|---|---|---|
| Workflow 1 | on CREATE | `Fuente ≠ WhatsAppBot` | Kitchen print immediately |
| Workflow 2 | on EDIT | `Fuente = WhatsAppBot` AND `Estado` changed to `Pago Confirmado` | Kitchen print |

Human operator changes `Estado` from `'Pendiente de Pago'` to `'Pago Confirmado'` in Zoho after verifying payment.

Deluge function `orden_confirmada_customer_wati` has guard: exits early if `Fuente = WhatsAppBot` AND `Estado ≠ Pago Confirmado`.

## Duplicate Records Prevention

- `triggerZohoOnPayment()` reads `pending_order` from DB, returns early if null
- After Zoho fires, `clearPendingOrder()` immediately nulls snapshot
- Subsequent images/text confirmations find `pending_order = null` and skip Zoho
- **No history-scan fallback** — removed because it produced garbage data

## pending_order JSONB Shape

```json
{
  "phone": "593...",
  "customerName": "...",
  "total": 19.00,
  "deliveryCost": 1.50,
  "address": "Dirección exacta",
  "turno": "13:30",
  "itemsText": "2 Fanescas — $9.50 c/u",
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

## Environment Variables

| Variable | Required | Purpose |
|---|---|---|
| `ZOHO_CLIENT_ID` | Yes | OAuth2 client ID |
| `ZOHO_CLIENT_SECRET` | Yes | OAuth2 client secret |
| `ZOHO_REFRESH_TOKEN` | Yes | OAuth2 refresh token (offline flow) |
| `ZOHO_ACCOUNTS_URL` | No | Auth URL (default: `https://accounts.zoho.com`) |
| `ZOHO_API_DOMAIN` | No | API domain (default: `https://www.zohoapis.com`) |
| `ZOHO_MODULE_API_NAME` | No | Module API name (default: `Planificacion_de_Entregas`) |

## Critical Rules

1. **`Fuente = 'WhatsAppBot'` must not be removed** — gates workflow split
2. **`clearPendingOrder()` runs immediately after Zoho fires** — prevents duplicates
3. **`pending_order` is single source of truth** — no history-scan fallback
4. **Legacy orders degrade gracefully** — missing new fields use fallbacks
