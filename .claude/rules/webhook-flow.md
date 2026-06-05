---
paths:
  - "src/index.js"
---

# Webhook Flow — src/index.js

Express server + WATI webhook handler. Entry point for all WhatsApp messages.

## Functions

| Function | What it does |
|---|---|
| `POST /webhook` handler | Main entry point. Filters duplicates, echoes, stale webhooks, paused bots. Routes media, location, and text messages. |
| `sendWatiMessage(phone, message)` | POSTs to WATI session message API. Registers outgoing message ID in `botSentMsgIds` to block echo. |
| `notifyHandoff(phone, name, type, lastMsg)` | Sends admin WhatsApp notification for `PAYMENT` or `GENERAL` handoff. |

## In-Memory State

Lost on restart:

| State | Type | Purpose |
|---|---|---|
| `processedMsgIds` | Set (max 500) | Dedup by `whatsappMessageId` |
| `botSentMsgIds` | Set (max 500) | Blocks WATI echo of our own messages |
| `processingPhones` | Set | Rate-limit: one active message per phone |
| `lastProcessed` | Map | Timestamp of last processed message per phone (500ms cooldown) |

## Message Routing

```
WATI POST /webhook
  → dedup check (processedMsgIds)
  → stale webhook filter (>60s old)
  → echo filter (botSentMsgIds, assignedId)
  → owner/operator filter
  → bot-pause check (isBotPaused)

  → IF media (image):
      ack customer ("Recibido, gracias...")
      notifyHandoff(PAYMENT)
      triggerZohoOnPayment()
      pauseBot()

  → IF location pin:
      getDeliveryZoneByCoordinates(lat, lng)
      enrich message with [SISTEMA] zone tag
      processMessage()

  → IF text:
      detect campaign codes (/ci, /wrq, /la, /wri)
      saveCampanaMeta() if found
      strip code from message
      processMessage()

  → sendWatiMessage() → WATI API
  → IF needsPaymentHandoff: notifyHandoff() + pauseBot()
  → IF needsHandoff: notifyHandoff() + pauseBot()
```

## Payment Split

If reply contains `"Una vez realices la transferencia"` (or similar payment instruction phrases), the message is split into 2 parts with a 1-second pause between them. This improves readability for long payment instructions.

## Meta Campaign Codes

Detected at end of incoming message, saved to DB, stripped before Claude:
- `/ci` — Campaign Interest
- `/wrq` — WhatsApp Request
- `/la` — Lookalike Audience
- `/wri` — WhatsApp Response Interest

Saved via `saveCampanaMeta(phone, campana)` → `customers.campana_meta`.

## Bot Pause/Resume Triggers

### Automatic Pause
- `HANDOFF` token in Claude response
- `HANDOFF_PAYMENT` token in Claude response
- Human operator sends message in WATI (non-bot assignedId)
- Customer sends payment image

### Automatic Resume
- WATI conversation assigned to bot account
- `#resume` command from operator
- Operator provides delivery cost/zone info
- Operator sends "Orden Confirmada"

### While Paused
Customer text messages are still saved to conversation history via `saveMessage()` so Claude has full context when resumed.

## Echo Detection

Messages are filtered as echoes when:
1. `whatsappMessageId` is in `botSentMsgIds`
2. `assignedId` matches `WATI_BOT_ASSIGNED_ID` env var
3. `operatorEmail` matches `WATI_BOT_EMAIL` env var

## Environment Variables Used

| Variable | Purpose |
|---|---|
| `WATI_API_KEY` | Bearer token for WATI session message API |
| `WATI_BOT_EMAIL` | Bot's email in WATI (echo detection) |
| `WATI_BOT_ASSIGNED_ID` | Bot's assignedId (preferred for echo detection) |
| `ADMIN_PHONE` | WhatsApp phone for handoff notifications |
| `PORT` | HTTP server port (default: 3000) |

## Health Check

```
GET /
→ { "status": "Micasa Restaurante Agent is running!" }
```
