---
paths:
  - "package.json"
  - ".env*"
---

# Deployment — Setup, Environment, Railway

## Local Setup

```bash
# 1. Install dependencies
npm install

# 2. Create .env file with all required vars
cp .env.example .env   # or create manually

# 3. Start with hot reload
npm run dev

# 4. Expose localhost to WATI
ngrok http 3000
# Set ngrok URL as WATI webhook URL
```

## Start Command

```bash
npm start
# or directly:
node src/index.js
```

## Railway Deployment

- Connected to GitHub: `git@github.com:neurona-ds/micasa-agent.git`
- Auto-deploys on push to `main`
- All env vars set in Railway project settings
- Railway provides `PORT` automatically

```bash
# Deploy: just push to main
git push origin main
```

## Environment Variables

### Required

| Variable | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` | Claude API key |
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_KEY` | Supabase service role key |
| `WATI_API_KEY` | WATI Bearer token for sending messages |
| `GOOGLE_MAPS_API_KEY` | Google Maps Geocoding API key |
| `ADMIN_PHONE` | WhatsApp phone for handoff notifications |
| `ZOHO_CLIENT_ID` | Zoho OAuth2 client ID |
| `ZOHO_CLIENT_SECRET` | Zoho OAuth2 client secret |
| `ZOHO_REFRESH_TOKEN` | Zoho OAuth2 refresh token (offline flow) |

### Optional

| Variable | Default | Purpose |
|---|---|---|
| `ZOHO_ACCOUNTS_URL` | `https://accounts.zoho.com` | Zoho auth URL |
| `ZOHO_API_DOMAIN` | `https://www.zohoapis.com` | Zoho API domain |
| `ZOHO_MODULE_API_NAME` | `Planificacion_de_Entregas` | Custom module API name |
| `WATI_BOT_EMAIL` | — | Bot's email in WATI (echo detection) |
| `WATI_HUMAN_EMAIL` | — | Human operator email (legacy) |
| `WATI_BOT_ASSIGNED_ID` | — | Bot's assignedId (preferred for echo detection) |
| `PORT` | `3000` | HTTP server port |
| `MICASA_ENVIOS_API_KEY` | — | Auth key for external delivery pricing API |

## Health Check

```
GET /
→ { "status": "Micasa Restaurante Agent is running!" }
```

## Required Supabase Migrations

Run once in Supabase SQL editor:

```sql
-- bot_flags table (deprecated but exists)
CREATE TABLE IF NOT EXISTS bot_flags (
  phone text primary key,
  geocode_clarification_pending boolean default false,
  house_number_pending boolean default false,
  updated_at timestamptz default now()
);
CREATE INDEX IF NOT EXISTS bot_flags_updated_at_idx ON bot_flags(updated_at);

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

See `sql/almuerzo_delivery_tiers.sql` for full table + seed data.

## Almuerzo Cycle Correction

Update both rows atomically (updating only one causes incorrect auto-advance):

```sql
UPDATE config SET value = '3' WHERE key = 'current_cycle';
UPDATE config SET value = '2026-04-21' WHERE key = 'cycle_last_updated';
-- value must be the Monday of the current week in YYYY-MM-DD format
```

## External Delivery Pricing API

Local development requires the micasa-delivery API running:

| Setting | Value |
|---|---|
| Port | `3002` |
| URL | `http://localhost:3002/api/v1/quote` |
| Auth | `X-API-Key: micasa-secret-auth-key-2026` |

Test connectivity:
```bash
node test-micasa-envios.js
```
