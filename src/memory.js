const path = require('path')
require('dotenv').config({ path: path.resolve(__dirname, '../.env'), override: true })
const { createClient } = require('@supabase/supabase-js')
const axios = require('axios')
const { randomUUID } = require('crypto')

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
)

// Save a message to the conversation history.
// sessionId links the message to the current order session — used by getHistory()
// to scope context to the active session only (prevents old orders bleeding in).
async function saveMessage(customerPhone, role, message, sessionId = null) {
  const row = { customer_phone: customerPhone, role, message }
  if (sessionId) row.session_id = sessionId

  const { error } = await supabase
    .from('conversations')
    .insert(row)

  if (error) console.error('Error saving message:', error)
}

// Get last 20 messages for a customer (newest first, then reversed to chronological order).
// When sessionId is provided, only messages from that session are returned — this prevents
// old completed orders from leaking into Claude's context window (Option B session management).
// Falls back to full history when sessionId is null (graceful degradation).
async function getHistory(customerPhone, sessionId = null) {
  let query = supabase
    .from('conversations')
    .select('role, message')
    .eq('customer_phone', customerPhone)
    .order('timestamp', { ascending: false })
    .limit(20)

  if (sessionId) {
    query = query.eq('session_id', sessionId)
  }

  const { data, error } = await query

  if (error) {
    console.error('Error fetching history:', error)
    return []
  }

  // Reverse so messages are in chronological order (oldest → newest)
  return (data || []).reverse()
}

// Save or update customer info
async function upsertCustomer(phone, name = null) {
  const { error } = await supabase
    .from('customers')
    .upsert({ phone, name }, { onConflict: 'phone' })

  if (error) console.error('Error upserting customer:', error)
}

// Get system prompt from config table
async function getSystemPrompt() {
  const { data, error } = await supabase
    .from('config')
    .select('value')
    .eq('key', 'system_prompt')
    .single()

  if (error) {
    console.error('Error fetching system prompt:', error)
    return null
  }

  return data.value
}

// Get a single config value by key
async function getConfig(key) {
  const { data, error } = await supabase
    .from('config')
    .select('value')
    .eq('key', key)
    .single()

  if (error) {
    console.error(`Error fetching config key "${key}":`, error)
    return null
  }

  return data.value
}

// Get all config keys at once, returns a key/value object
async function getAllConfig() {
  const { data, error } = await supabase
    .from('config')
    .select('key, value')

  if (error) {
    console.error('Error fetching all config:', error)
    return {}
  }

  return data.reduce((acc, row) => {
    acc[row.key] = row.value
    return acc
  }, {})
}

// Get all available products grouped by category
async function getProducts() {
  const { data, error } = await supabase
    .from('products')
    .select('name, description, price, category')
    .eq('available', true)
    .order('category')
    .order('sort_order')

  if (error) {
    console.error('Error fetching products:', error)
    return []
  }

  return data
}

// Get all available delivery zones with neighborhood info
async function getDeliveryZones() {
  const { data, error } = await supabase
    .from('delivery_zones')
    .select('zone_number, label, price, min_order, neighborhoods, requires_approval')
    .eq('available', true)
    .order('sort_order')

  if (error) {
    console.error('Error fetching delivery zones:', error)
    return []
  }

  return data
}

// Get delivery tiers (order-value based pricing per zone)
async function getDeliveryTiers() {
  const { data, error } = await supabase
    .from('delivery_tiers')
    .select('zone_number, order_min, order_max, delivery_price')
    .order('zone_number')
    .order('sort_order')

  if (error) {
    console.error('Error fetching delivery tiers:', error)
    return []
  }

  return data
}

// Auto-advance cycle every Monday. Cycle + last-updated date live in the DB
// (config table) so this survives deploys — nothing is in memory.
//
// ⚠️  To manually correct the cycle, update BOTH rows in the config table:
//   key='current_cycle'    → value='N'
//   key='cycle_last_updated' → value='YYYY-MM-DD' (the Monday of the current week)
// Updating only one of them will cause the next auto-advance to compute wrong.
async function getCurrentCycle() {
  try {
    const { data, error } = await supabase
      .from('config')
      .select('key, value')
      .in('key', ['current_cycle', 'cycle_last_updated', 'almuerzo_cycle_count'])

    if (error) throw error

    const cfg = data.reduce((acc, row) => { acc[row.key] = row.value; return acc }, {})

    const cycleCount  = parseInt(cfg.almuerzo_cycle_count || '5')
    const currentCycle = parseInt(cfg.current_cycle || '1')
    const lastUpdated  = cfg.cycle_last_updated ? new Date(cfg.cycle_last_updated) : null

    // Most recent Monday in Ecuador time (UTC-5, no DST)
    const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Guayaquil' }))
    const daysSinceMonday = now.getDay() === 0 ? 6 : now.getDay() - 1
    const thisMonday = new Date(now)
    thisMonday.setDate(now.getDate() - daysSinceMonday)
    thisMonday.setHours(0, 0, 0, 0)

    // Only advance if cycle_last_updated is before this Monday (fires once per week)
    if (!lastUpdated || lastUpdated < thisMonday) {
      const newCycle = (currentCycle % cycleCount) + 1
      const newDate  = thisMonday.toISOString().split('T')[0]

      await supabase.from('config').upsert([
        { key: 'current_cycle',      value: String(newCycle) },
        { key: 'cycle_last_updated', value: newDate }
      ], { onConflict: 'key' })

      console.log(`[cycle] AUTO-ADVANCED: C${currentCycle} → C${newCycle} (week of ${newDate})`)
      return newCycle
    }

    console.log(`[cycle] Current cycle: C${currentCycle}`)
    return currentCycle
  } catch (e) {
    console.error('[cycle] Error in getCurrentCycle:', e.message)
    return 1
  }
}

// Get full week almuerzo menu for current cycle (all 5 days)
async function getWeekAlmuerzos(currentCycle) {
  try {
    const { data, error } = await supabase
      .from('almuerzos')
      .select('day_of_week, soup, main')
      .eq('cycle', currentCycle)
      .eq('available', true)
      .order('day_of_week')

    if (error) {
      console.error('Error fetching week almuerzos:', error.message)
      return []
    }

    return data
  } catch (e) {
    console.error('Error in getWeekAlmuerzos:', e.message)
    return []
  }
}

// Get almuerzo delivery tiers (quantity-based flat price per zone)
async function getAlmuerzoDeliveryTiers() {
  const { data, error } = await supabase
    .from('almuerzo_delivery_tiers')
    .select('zone_number, min_qty, max_qty, delivery_price, is_free, requires_approval')
    .order('zone_number')
    .order('sort_order')

  if (error) {
    console.error('Error fetching almuerzo delivery tiers:', error)
    return []
  }

  return data
}

// Get all active payment methods
async function getPaymentMethods() {
  const { data, error } = await supabase
    .from('payment_methods')
    .select('bank, account_type, account_number, account_holder, cedula')
    .eq('available', true)
    .order('sort_order')

  if (error) {
    console.error('Error fetching payment methods:', error)
    return []
  }

  return data
}

// Restaurant coordinates (América y Juan José de Villalengua, Quito) — from Google Maps pin
const RESTAURANT_LAT = -0.1723433
const RESTAURANT_LNG = -78.4910016

// Calculate delivery zone from a free-text customer address using Google Maps Geocoding + Haversine
async function getDeliveryZoneByAddress(customerAddress) {
  try {
    const apiKey = process.env.GOOGLE_MAPS_API_KEY
    if (!apiKey) {
      console.warn('GOOGLE_MAPS_API_KEY not set — cannot calculate delivery zone')
      return null
    }

    // Geocode the customer address, biased to Quito Ecuador
    const geocodeResponse = await axios.get('https://maps.googleapis.com/maps/api/geocode/json', {
      params: {
        address: `${customerAddress}, Quito, Ecuador`,
        key: apiKey,
        region: 'ec',
        language: 'es'
      },
      timeout: 5000
    })

    const geocodeData = geocodeResponse.data
    if (!geocodeData || geocodeData.status !== 'OK' || !geocodeData.results?.length) {
      console.warn(`Geocoding failed for "${customerAddress}": status=${geocodeData?.status}`)
      return null
    }

    const { lat: customerLat, lng: customerLng } = geocodeData.results[0].geometry.location
    const formattedAddress = geocodeData.results[0].formatted_address
    // location_type reflects geocoding precision:
    // ROOFTOP / RANGE_INTERPOLATED = precise street-level
    // GEOMETRIC_CENTER = centroid of a region (neighbourhood, city) — imprecise
    // APPROXIMATE = very rough
    const locationType = geocodeData.results[0].geometry.location_type || 'UNKNOWN'

    // Haversine formula — straight-line distance in km
    const R = 6371
    const dLat = ((customerLat - RESTAURANT_LAT) * Math.PI) / 180
    const dLng = ((customerLng - RESTAURANT_LNG) * Math.PI) / 180
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos((RESTAURANT_LAT * Math.PI) / 180) *
      Math.cos((customerLat * Math.PI) / 180) *
      Math.sin(dLng / 2) * Math.sin(dLng / 2)
    const distanceKm = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))

    // Assign zone based on distance brackets
    let zone
    if (distanceKm <= 2) zone = 1
    else if (distanceKm <= 4) zone = 2
    else if (distanceKm <= 6) zone = 3
    else zone = 4

    console.log(`Zone calc: "${customerAddress}" → ${formattedAddress} | ${distanceKm.toFixed(2)}km → Zone ${zone} | locationType=${locationType}`)

    return { zone, distanceKm: parseFloat(distanceKm.toFixed(2)), formattedAddress, locationType }
  } catch (err) {
    console.error('Error in getDeliveryZoneByAddress:', err.message)
    return null
  }
}

/**
 * Resolve a Google Maps short URL (maps.app.goo.gl) by following its redirect.
 * Returns { lat, lng } extracted from the redirect URL, or null if not found.
 * No API key needed — just an HTTP redirect follow.
 */
async function resolveGoogleMapsUrl(url) {
  try {
    // Strip Google Maps tracking params (e.g. ?g_st=aw added by iOS share sheet)
    // before following the redirect — they can alter the redirect destination
    // and prevent coordinate extraction from the final URL.
    const cleanUrl = url.replace(/[?&]g_st=[^&]*/g, '').replace(/[?&]$/, '')
    const response = await axios.get(cleanUrl, {
      maxRedirects: 0,
      validateStatus: status => status >= 300 && status < 400,
      timeout: 5000,
      headers: { 'User-Agent': 'Mozilla/5.0' }
    })
    const redirectUrl = response.headers.location
    if (!redirectUrl) return null

    console.log(`[resolveGoogleMapsUrl] Redirect → ${redirectUrl}`)

    // Extract coordinates from common Google Maps URL patterns:
    // /maps/search/-0.176050,+-78.474001
    // /maps/place/@-0.176050,-78.474001,17z
    // /@-0.176050,-78.474001,17z
    // ?q=-0.176050,-78.474001
    const patterns = [
      /\/maps\/search\/(-?\d+\.?\d*),\+?(-?\d+\.?\d*)/,
      /\/@(-?\d+\.?\d*),(-?\d+\.?\d*)/,
      /[?&]q=(-?\d+\.?\d*),\+?(-?\d+\.?\d*)/,
      /[?&]ll=(-?\d+\.?\d*),\+?(-?\d+\.?\d*)/
    ]

    for (const pattern of patterns) {
      const match = redirectUrl.match(pattern)
      if (match) {
        const lat = parseFloat(match[1])
        const lng = parseFloat(match[2])
        console.log(`[resolveGoogleMapsUrl] Coords extracted: lat=${lat}, lng=${lng}`)
        return { lat, lng }
      }
    }

    console.warn(`[resolveGoogleMapsUrl] No coords found in redirect: ${redirectUrl}`)
    return null
  } catch (err) {
    console.error('[resolveGoogleMapsUrl] Error:', err.message)
    return null
  }
}

/**
 * Same as getDeliveryZoneByAddress but starts from coordinates (WhatsApp location pin).
 * Skips forward-geocoding; uses reverse-geocoding to get a formatted address,
 * then applies the same Haversine distance + zone logic.
 */
async function getDeliveryZoneByCoordinates(lat, lng) {
  try {
    const apiKey = process.env.GOOGLE_MAPS_API_KEY
    if (!apiKey) {
      console.warn('GOOGLE_MAPS_API_KEY not set — cannot calculate delivery zone from coordinates')
      return null
    }

    // Reverse geocode to get a human-readable formatted address
    const reverseResponse = await axios.get('https://maps.googleapis.com/maps/api/geocode/json', {
      params: {
        latlng: `${lat},${lng}`,
        key: apiKey,
        language: 'es'
      },
      timeout: 5000
    })

    const data = reverseResponse.data
    if (!data || data.status !== 'OK' || !data.results?.length) {
      console.warn(`Reverse geocoding failed for (${lat},${lng}): status=${data?.status}`)
      return null
    }

    const formattedAddress = data.results[0].formatted_address
    const customerLat = parseFloat(lat)
    const customerLng = parseFloat(lng)

    // Haversine formula — same as getDeliveryZoneByAddress
    const R = 6371
    const dLat = ((customerLat - RESTAURANT_LAT) * Math.PI) / 180
    const dLng = ((customerLng - RESTAURANT_LNG) * Math.PI) / 180
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos((RESTAURANT_LAT * Math.PI) / 180) *
      Math.cos((customerLat * Math.PI) / 180) *
      Math.sin(dLng / 2) * Math.sin(dLng / 2)
    const distanceKm = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))

    let zone
    if (distanceKm <= 2) zone = 1
    else if (distanceKm <= 4) zone = 2
    else if (distanceKm <= 6) zone = 3
    else zone = 4

    console.log(`Zone calc (pin): (${lat},${lng}) → ${formattedAddress} | ${distanceKm.toFixed(2)}km → Zone ${zone}`)
    return { zone, distanceKm: parseFloat(distanceKm.toFixed(2)), formattedAddress }
  } catch (err) {
    console.error('Error in getDeliveryZoneByCoordinates:', err.message)
    return null
  }
}

// Save the geocoded delivery address + zone + distance for a customer.
// Called right after Google Maps geocoding succeeds so we always have clean,
// structured data available for Zoho — no need to parse conversation text.
async function saveDeliveryAddress(phone, formattedAddress, zone, distanceKm) {
  const { error } = await supabase
    .from('customers')
    .update({
      last_delivery_address: formattedAddress,
      last_delivery_zone: zone,
      last_delivery_distance_km: distanceKm
    })
    .eq('phone', phone)

  if (error) console.error('Error saving delivery address:', error)
}

// Save the raw customer-typed address text, independent of geocoding success.
// Used when geocoding fails or returns low confidence — we still want to capture
// the customer's address for Zoho and for Claude's stored-address context.
// Does NOT overwrite zone or distance — those are set separately by geocoding.
async function saveRawAddress(phone, rawAddress) {
  const { error } = await supabase
    .from('customers')
    .update({ last_delivery_address: rawAddress })
    .eq('phone', phone)

  if (error) console.error('[saveRawAddress] Error:', error)
  else console.log(`[saveRawAddress] Saved for ${phone}: "${rawAddress}"`)
}

// Save customer location coordinates to the DB.
// Stores:
//   last_location_pin  JSONB  → { lat, lng }   — for internal zone calculations
//   last_location_url  TEXT   → clean Google Maps URL built from coords — sent to Zoho
// Both columns are always written together so they stay in sync.
async function saveLocationPin(phone, lat, lng) {
  const locationUrl = `https://www.google.com/maps?q=${lat},${lng}`
  console.log(`[saveLocationPin] Saving pin for ${phone}: lat=${lat}, lng=${lng}, url=${locationUrl}`)
  const { data, error } = await supabase
    .from('customers')
    .update({
      last_location_pin: { lat, lng },
      last_location_url: locationUrl
    })
    .eq('phone', phone)
    .select('phone, last_location_pin, last_location_url')

  if (error) {
    console.error(`[saveLocationPin] DB error for ${phone}:`, error.message, error.details || '')
    console.error('[saveLocationPin] Hint: run this SQL in Supabase if columns are missing:')
    console.error('  ALTER TABLE customers ADD COLUMN IF NOT EXISTS last_location_pin JSONB;')
    console.error('  ALTER TABLE customers ADD COLUMN IF NOT EXISTS last_location_url TEXT;')
  } else {
    console.log(`[saveLocationPin] Saved OK →`, data)
  }
}

// Save zone + distance for a customer WITHOUT overwriting their text address.
// Used for location pins — keeps last_delivery_address clean (only set from typed addresses).
async function saveDeliveryZoneOnly(phone, zone, distanceKm) {
  console.log(`[saveDeliveryZoneOnly] zone=${zone}, dist=${distanceKm}km for ${phone}`)
  const { error } = await supabase
    .from('customers')
    .update({
      last_delivery_zone: zone,
      last_delivery_distance_km: distanceKm
    })
    .eq('phone', phone)

  if (error) console.error('[saveDeliveryZoneOnly] DB error:', error.message)
}

// ─── Authoritative delivery cost lookup ───────────────────────────────────────
// Queries the actual DB tier tables to get the definitive delivery cost for a
// given zone + order type + total/quantity. Used to override the regex-parsed
// value from Claude's reply text when saving pending_order.
async function lookupDeliveryCost(zone, orderType, total, cantidad) {
  try {
    if (!zone) return null

    if (orderType === 'almuerzo') {
      const qty = cantidad || 1
      const { data, error } = await supabase
        .from('almuerzo_delivery_tiers')
        .select('delivery_price, is_free, requires_approval')
        .eq('zone_number', zone)
        .lte('min_qty', qty)
        .order('min_qty', { ascending: false })
        .limit(10)

      if (error || !data?.length) return null

      // Find the tier whose max_qty covers qty (null max_qty = open-ended)
      const tier = data.find(t => t.max_qty == null || t.max_qty >= qty)
      if (!tier) return null
      if (tier.is_free) return 0
      if (tier.requires_approval) return null
      return parseFloat(tier.delivery_price)
    } else {
      // carta: lookup by order total value
      const orderTotal = total || 0
      const { data, error } = await supabase
        .from('delivery_tiers')
        .select('delivery_price')
        .eq('zone_number', zone)
        .lte('order_min', orderTotal)
        .order('order_min', { ascending: false })
        .limit(10)

      if (error || !data?.length) return null

      // Find the tier whose order_max covers the total (null = open-ended)
      const tier = data.find(t => t.order_max == null || t.order_max >= orderTotal)
      if (!tier) return null
      return parseFloat(tier.delivery_price)
    }
  } catch (e) {
    console.error('lookupDeliveryCost error:', e.message)
    return null
  }
}

// ─── Pending order ────────────────────────────────────────────────────────────
// Saves the fully-extracted orderData object when the bot sends an order summary.
// At payment time we read this instead of scanning conversation history.

async function savePendingOrder(phone, orderData) {
  const { error } = await supabase
    .from('customers')
    .update({ pending_order: orderData })
    .eq('phone', phone)

  if (error) console.error('Error saving pending_order:', error)
}

async function getPendingOrder(phone) {
  const { data, error } = await supabase
    .from('customers')
    .select('pending_order')
    .eq('phone', phone)
    .single()

  if (error || !data) return null
  return data.pending_order || null
}

async function clearPendingOrder(phone) {
  const { error } = await supabase
    .from('customers')
    .update({ pending_order: null })
    .eq('phone', phone)

  if (error) console.error('Error clearing pending_order:', error)
}
// ──────────────────────────────────────────────────────────────────────────────

// Get the last delivery data stored for a customer.
// Returns { address, zone, distanceKm, locationPin, locationUrl } or null if nothing stored yet.
// address     — typed text address (null if customer only ever shared a pin)
// locationPin — { lat, lng } from WhatsApp location pin (null if only text address)
// locationUrl — clean Google Maps URL built from coords (null if only text address)
// zone + distanceKm — set from whichever source was most recent
async function getCustomerAddress(phone) {
  const { data, error } = await supabase
    .from('customers')
    .select('name, last_delivery_address, last_delivery_zone, last_delivery_distance_km, last_location_pin, last_location_url, campana_meta')
    .eq('phone', phone)
    .single()

  if (error || !data) return null

  const hasAddress = !!data.last_delivery_address
  const hasPin = !!data.last_location_pin

  if (!hasAddress && !hasPin) return null

  return {
    customerName:  data.name                       || null,
    address:       data.last_delivery_address      || null,
    zone:          data.last_delivery_zone         || null,
    distanceKm:    data.last_delivery_distance_km  || null,
    locationPin:   data.last_location_pin          || null,   // { lat, lng }
    locationUrl:   data.last_location_url          || null,   // clean Maps URL for Zoho
    campana:       data.campana_meta               || null    // Meta ad campaign source
  }
}

// Save the Meta campaign attribution for a customer.
// Called when a campaign code (e.g. /la) is detected in the customer's first message.
async function saveCampanaMeta(phone, campana) {
  const { error } = await supabase
    .from('customers')
    .update({ campana_meta: campana })
    .eq('phone', phone)

  if (error) console.error('[campana] Error saving campana_meta:', error)
  else console.log(`[campana] Saved campana_meta="${campana}" for ${phone}`)
}

// Get weekly business hours — returns array of { day_of_week, open_time, close_time }
// where day_of_week follows JS convention (0=Sun … 6=Sat).
// open_time / close_time are "HH:MM:SS" strings from Postgres TIME, or null = closed that day.
async function getBusinessHours() {
  const { data, error } = await supabase
    .from('business_hours')
    .select('day_of_week, day_name, open_time, close_time')
    .order('day_of_week')

  if (error) {
    console.error('Error fetching business hours:', error)
    return null   // caller falls back to hardcoded schedule
  }

  return data
}

// ─── Order Session Management ─────────────────────────────────────────────────
// Each customer interaction is grouped into a "session" — a UUID that links all
// messages from a single order flow.  A session starts when the customer first
// writes in (or when the previous session expired / ended) and ends when the
// order is completed (payment confirmed → clearPendingOrder called) or the
// customer picks up in-person.
//
// Sessions expire automatically after SESSION_EXPIRY_MS of inactivity.
// This means a customer who writes the next day always gets a clean slate.
//
// DB columns required (run once in Supabase SQL editor):
//   ALTER TABLE customers
//     ADD COLUMN IF NOT EXISTS current_session_id UUID,
//     ADD COLUMN IF NOT EXISTS session_last_activity_at TIMESTAMPTZ;
//   ALTER TABLE conversations
//     ADD COLUMN IF NOT EXISTS session_id UUID;
//   CREATE INDEX IF NOT EXISTS idx_conversations_session_id ON conversations(session_id);

const SESSION_EXPIRY_MS = 6 * 60 * 60 * 1000 // 6 hours

/**
 * Return the current active session ID for this customer, creating a new one
 * if none exists or the previous one has expired (> 6 h of inactivity).
 * Also refreshes session_last_activity_at so the clock resets on every turn.
 */
async function getOrCreateSession(phone) {
  try {
    const { data, error } = await supabase
      .from('customers')
      .select('current_session_id, session_last_activity_at')
      .eq('phone', phone)
      .single()

    if (error || !data) {
      console.warn(`[session] Could not read session for ${phone}:`, error?.message)
      return null
    }

    const now = Date.now()
    const lastActivity = data.session_last_activity_at
      ? new Date(data.session_last_activity_at).getTime()
      : 0
    const isExpired = (now - lastActivity) >= SESSION_EXPIRY_MS

    if (data.current_session_id && !isExpired) {
      // Active session — refresh the activity timestamp and return existing ID
      await supabase
        .from('customers')
        .update({ session_last_activity_at: new Date().toISOString() })
        .eq('phone', phone)
      return data.current_session_id
    }

    // No session or it expired — create a fresh one
    const newSessionId = randomUUID()
    await supabase
      .from('customers')
      .update({
        current_session_id: newSessionId,
        session_last_activity_at: new Date().toISOString()
      })
      .eq('phone', phone)

    console.log(`[session] New session for ${phone}: ${newSessionId}${data.current_session_id ? ' (previous expired)' : ''}`)
    return newSessionId
  } catch (e) {
    console.error('[session] getOrCreateSession error:', e.message)
    return null
  }
}

/**
 * End the current session for a customer.
 * Called when an order completes (Zoho record created + clearPendingOrder) or
 * the customer chooses in-person pickup (no payment needed).
 * The next message from this customer will get a brand-new session, giving
 * Claude a clean history with no remnants from the completed order.
 */
async function endSession(phone) {
  try {
    await supabase
      .from('customers')
      .update({
        current_session_id: null,
        session_last_activity_at: null
      })
      .eq('phone', phone)
    console.log(`[session] Session ended for ${phone}`)
  } catch (e) {
    console.error('[session] endSession error:', e.message)
  }
}

// Check if bot is paused for a customer
async function isBotPaused(phone) {
  const { data, error } = await supabase
    .from('customers')
    .select('bot_paused')
    .eq('phone', phone)
    .single()

  if (error || !data) return false
  return data.bot_paused === true
}

// Pause bot for a customer (human takeover)
async function pauseBot(phone) {
  const { error } = await supabase
    .from('customers')
    .update({ bot_paused: true })
    .eq('phone', phone)

  if (error) console.error('Error pausing bot:', error)
}

// Resume bot for a customer
async function resumeBot(phone) {
  const { error } = await supabase
    .from('customers')
    .update({ bot_paused: false })
    .eq('phone', phone)

  if (error) console.error('Error resuming bot:', error)
}

module.exports = {
  saveMessage,
  getHistory,
  upsertCustomer,
  getSystemPrompt,
  getConfig,
  getAllConfig,
  getProducts,
  getDeliveryZones,
  getDeliveryTiers,
  getAlmuerzoDeliveryTiers,
  getDeliveryZoneByAddress,
  resolveGoogleMapsUrl,
  getDeliveryZoneByCoordinates,
  getCurrentCycle,
  getWeekAlmuerzos,
  getPaymentMethods,
  isBotPaused,
  pauseBot,
  resumeBot,
  saveDeliveryAddress,
  saveRawAddress,
  saveLocationPin,
  saveDeliveryZoneOnly,
  getCustomerAddress,
  saveCampanaMeta,
  getBusinessHours,
  lookupDeliveryCost,
  savePendingOrder,
  getPendingOrder,
  clearPendingOrder,
  getOrCreateSession,
  endSession
}