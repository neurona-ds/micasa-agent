---
paths:
  - "src/tools/geo.js"
  - "src/tools/micasaEnvios.js"
---

# Geocoding — src/tools/geo.js & micasaEnvios.js

Claude tool calling for address geocoding and delivery zone calculation.

## Architecture

Geocoding uses **Claude tool calling** (not regex pre-processing). Claude decides when to call geocoding tools, executes them in a loop, and uses the returned cost directly.

```
Customer provides address
  → Claude calls geocode_address or resolve_maps_url
  → executeGeoTool() calls external micasa-envios API
  → Returns { zone, deliveryCost, isZone4, instruction }
  → Claude uses result in response
```

## GEOCODING_TOOLS Schema

Two tools passed to every Claude API call:

### `geocode_address`
Called when customer provides a text address.
- Input: `{ address: string }`
- Returns: `{ zone, deliveryCost, isZone4, instruction }` or `{ lowConfidence: true }`

### `resolve_maps_url`
Called when customer sends a Google Maps link.
- Input: `{ url: string }`
- Returns: Same shape plus `locationUrl`

## executeGeoTool(toolName, input, context)

Executes whichever tool Claude called:
1. Calls `getDeliveryQuote()` from micasaEnvios.js
2. Checks confidence level
3. Saves result to DB
4. Returns structured result for `tool_result`

## External Micasa Delivery Pricing API

All geocoding, distance calculations, and pricing lookups are delegated to the external Next.js delivery pricing API.

| Setting | Value |
|---|---|
| Active Port | `3002` (local) |
| Endpoint | `POST /api/v1/quote` |
| Auth Header | `X-API-Key: micasa-secret-auth-key-2026` |
| Env Var | `MICASA_ENVIOS_API_KEY` |

### Files
- `src/tools/micasaEnvios.js` — `getDeliveryQuote(params)` API client
- `src/tools/geo.js` — Wraps tool calls to delegate to API
- `test-micasa-envios.js` — Test script for API connectivity

## Low-Confidence Geocode Handling

Returns `{ lowConfidence: true }` when geocode is imprecise. Claude naturally asks for a more specific reference.

| Location Type | Confidence |
|---|---|
| `ROOFTOP` | High |
| `RANGE_INTERPOLATED` | High |
| `GEOMETRIC_CENTER` | Low, UNLESS address contains intersection markers |
| `APPROXIMATE` | Always low |

**Intersection exception**: `GEOMETRIC_CENTER` is high-confidence if address or `formattedAddress` contains ` y `, `&`, or `and` — Google places these at exact cross-street points.

## Zone 4 Handling

Zone 4 (6+ km) always triggers HANDOFF:
- Returns `{ isZone4: true, instruction: "..." }`
- `instruction` contains exact scripted response Claude must follow verbatim
- No order summary is shown — human must quote manually

## WhatsApp Location Pins

Native location pins (`messageType === 'location'`) are handled **deterministically** in `index.js` before `processMessage()`:
1. `getDeliveryZoneByCoordinates(lat, lng)`
2. Zone injected into message as `[SISTEMA]` tag
3. `processMessage()` called with enriched message

## estimateSubtotal(history, orderType, qty)

Estimates order subtotal from conversation history for API calls. Exported from geo.js.

Used to prevent false `BELOW_MIN_ORDER` errors on first-turn messages and location pins.

## Critical Rules

1. **Zone numbers never shown to customers** — injected as `[SISTEMA]` tags only
2. **bot_flags table is deprecated** — no longer written to
3. **Tool loop runs until text response** — `while (stop_reason === 'tool_use')`

## Bug Fixes Applied

### Delivery Cost Change Mid-Order
When customer provides text address (Zone 2, $1.50) then sends GPS pin (Zone 3, $2.00):
- Detect cost change
- Inject `costChangeWarning` into `[SISTEMA]` tag
- Clear `pending_order` so Claude regenerates summary

### Maps URL Error Propagation
`getDeliveryQuote` returns structured error payload `error.response.data` if present. `BELOW_MIN_ORDER` errors are handled with specific Spanish explanations.

### Subtotal Estimation
- `executeGeoTool` receives `currentMessage` parameter
- Appends current message to history before estimation
- Location pin webhook fetches session history for dynamic calculation
