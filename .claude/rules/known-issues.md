---
description: Historical decisions, bug fixes, and architectural notes
---

# Known Issues & Decisions

Historical context for architectural decisions and bug fixes. Reference only — no file path trigger.

## Geocoding Refactor: Regex → Claude Tool Calling

**Before**: `src/tools/geo.js` had ~500 lines of regex + state flags. Coordinator pre-processed every message with heuristics to detect addresses, injected `[SISTEMA]` tags.

**After**: Claude decides when to call `geocode_address` or `resolve_maps_url`, executes them in a loop, uses returned cost directly.

**Result**: `bot_flags` table (`geocode_clarification_pending`, `house_number_pending`) is no longer written to.

## Why Prompt Caching Was Added

System prompt is large (menu, zones, tiers, hours, almuerzo menu) and rebuilt from DB on every request.

Claude's prompt caching (`cache_control: { type: 'ephemeral' }`) reduces token costs when system prompt is identical across consecutive requests.

Cache hit/miss is logged per request.

## Duplicate Zoho Records — Bug 2+3

**Problem**: Customer could send payment image AND "ya transferí" text in quick succession, creating 2 Zoho records with corrupt data (bot sentences as address).

**Solution**:
- `triggerZohoOnPayment()` reads `pending_order`, returns early if null
- After Zoho fires, `clearPendingOrder()` immediately nulls snapshot
- Subsequent images/text find null and skip Zoho
- **No history-scan fallback** — removed because it produced garbage

## Bug 4: Delivery Cost Change Mid-Order

**Problem**: Customer provides text address (Zone 2, $1.50), then sends GPS pin (Zone 3, $2.00). `pending_order` had wrong cost.

**Fix**: Both `index.js` and `geo.js` detect cost change, inject `costChangeWarning`, clear `pending_order` so Claude regenerates summary.

## Fanesca Campaign Override

**Status**: Temporary fast-path marked `// TODO: REMOVE after campaign ends`

Intercepts Fanesca-related messages from Meta Ads (Semana Santa 2026). Bypasses Claude, returns hardcoded pitch.

**Detection criteria**:
- Standard CTA: "Quiero información sobre la Fanesca"
- Ad copy paste (fb.me URL, "Dirección por favor", 3+ checkmarks)
- Price question mentioning "fanesca"
- Delivery question mentioning "fanesca"

## Confirmation Bypass: Only When pending_order Exists

**Problem**: Claude sent summary with "Confirmas tu pedido?" but without `<ORDEN>` block.

**Behavior**: `pending_order` is null, confirmation bypass detects null, falls through to Claude with explicit retry instruction, forces regeneration with `<ORDEN>`.

## Weekend Almuerzo — Now Prompt-Driven (was Deterministic HANDOFF)

The old hardcoded `isAlmuerzoOrderOnWeekend` HANDOFF gate in `src/index.js` was removed
(commit ca32294). Weekends no longer intercept before Claude. Instead the prompt
(`orders.js` REGLA MENÚ ALMUERZOS step 3 + `schedule.js`) tells Claude to offer next-week
pre-booking and run the normal order flow; it emits `HANDOFF` only if the customer insists
on same-day weekend delivery. See `.claude/rules/business-logic.md` for the current flow.

## Timezone Offset Bug

**Problem**: `nowInEcuador()` used `new Date(Date.now() - 5 * 60 * 60 * 1000)`. On non-UTC machines, `.getHours()` double-applied timezone offset.

**Symptom**: Bot computed 08:35 when actual Ecuador time was 12:35, forcing orders to "mañana" even during operating hours.

**Fix**: Timezone-independent computation using `getTimezoneOffset()`:
```javascript
const now = new Date();
const utcMs = now.getTime() + now.getTimezoneOffset() * 60000;
return new Date(utcMs - 5 * 60 * 60 * 1000);
```

Updated in `coordinator.js`, `order.js`, `zoho.js`.

## Maps URL Resolution Error Propagation

**Problem**: `getDeliveryQuote` threw on HTTP errors (e.g., `BELOW_MIN_ORDER`). Tool returned generic "Could not determine zone" instead of explaining business rule.

**Fix**: Return `error.response.data` if present. Added `BELOW_MIN_ORDER` handling to `resolve_maps_url` (already in `geocode_address`).

## Subtotal Estimation for API Quotes

**Problem**:
1. Chatbot didn't pass `subtotal` to API (defaulted to `0`)
2. `estimateSubtotal` only checked stored history — first-turn messages weren't saved yet
3. Location pins handled before order summary saved (`pending_order` null)
4. False `BELOW_MIN_ORDER` errors on first-turn requests

**Fix**:
1. Implemented `estimateSubtotal(history, orderType, qty)` in geo.js
2. `executeGeoTool` receives `currentMessage`, appends to history before estimation
3. Location pin webhook fetches session history, calculates dynamically

## Quantity & Delivery Auto-Detection

**Rule**: REGLA INQUEBRANTABLE

- Singular articles (`"un"`, `"una"`) → quantity `1`
- Claude prohibited from asking "¿Cuántos almuerzos?" if implied
- Address upfront → assume delivery, skip confirmation
- Stored address hints only injected if not in current session

## Daily vs. Weekly Menu Rules

- Generic request → today's menu only
- Explicit "semana"/"semanal" → full 5-day menu
- Specific day → that day's menu only
