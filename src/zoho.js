const axios = require('axios')
const path = require('path')
require('dotenv').config({ path: path.resolve(__dirname, '../.env'), override: true })

// ─── In-memory token cache ────────────────────────────────────────────────────
let cachedAccessToken = null
let tokenExpiresAt = 0

/**
 * Get a valid Zoho OAuth2 access token, refreshing automatically when expired.
 * Uses the offline/refresh-token flow — generate your refresh token once via
 * Zoho Self-Client (https://api-console.zoho.com/) with scope:
 *   ZohoCRM.modules.ALL,ZohoCRM.settings.READ
 */
async function getZohoAccessToken() {
  // Return cached token if still valid (with 60 s safety buffer)
  if (cachedAccessToken && Date.now() < tokenExpiresAt - 60_000) {
    return cachedAccessToken
  }

  const clientId     = process.env.ZOHO_CLIENT_ID
  const clientSecret = process.env.ZOHO_CLIENT_SECRET
  const refreshToken = process.env.ZOHO_REFRESH_TOKEN
  const accountsUrl  = process.env.ZOHO_ACCOUNTS_URL || 'https://accounts.zoho.com'

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error('Zoho credentials not set — add ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_REFRESH_TOKEN to .env')
  }

  const response = await axios.post(
    `${accountsUrl}/oauth/v2/token`,
    null,
    {
      params: {
        grant_type:    'refresh_token',
        client_id:     clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken
      },
      timeout: 8000
    }
  )

  const { access_token, expires_in, error } = response.data
  if (!access_token) {
    throw new Error(`Zoho token refresh failed: ${error || JSON.stringify(response.data)}`)
  }

  cachedAccessToken = access_token
  tokenExpiresAt    = Date.now() + ((expires_in || 3600) * 1000)
  console.log('Zoho: access token refreshed, expires in', expires_in, 's')
  return cachedAccessToken
}

// ─── Contact lookup ────────────────────────────────────────────────────────────

/**
 * Look up a Zoho Contact by phone number.
 * Returns { id, name } or null if not found.
 */
async function lookupZohoContact(phone) {
  try {
    const token     = await getZohoAccessToken()
    const apiDomain = process.env.ZOHO_API_DOMAIN || 'https://www.zohoapis.com'

    // Normalize: strip non-digits for search
    const cleanPhone = phone.replace(/\D/g, '')

    const response = await axios.get(
      `${apiDomain}/crm/v2/Contacts/search`,
      {
        headers: { Authorization: `Zoho-oauthtoken ${token}` },
        params:  { phone: cleanPhone },
        timeout: 8000
      }
    )

    const records = response.data?.data
    if (records && records.length > 0) {
      console.log(`Zoho: contact found — ${records[0].Full_Name} (${records[0].id})`)
      return { id: records[0].id, name: records[0].Full_Name }
    }

    console.log(`Zoho: no contact found for phone ${cleanPhone}`)
    return null
  } catch (err) {
    // 404 from Zoho search = "no results" — not a real error
    if (err.response?.status === 404) return null
    console.warn('Zoho contact lookup error:', err.response?.data || err.message)
    return null
  }
}

// ─── Contact creation ──────────────────────────────────────────────────────────

/**
 * Create a new Zoho Contact and return its id.
 */
async function createZohoContact(phone, name) {
  const token     = await getZohoAccessToken()
  const apiDomain = process.env.ZOHO_API_DOMAIN || 'https://www.zohoapis.com'

  // Zoho requires First_Name + Last_Name separately
  const parts     = (name || phone).trim().split(/\s+/)
  const firstName = parts[0]
  const lastName  = parts.slice(1).join(' ') || '-'

  const response = await axios.post(
    `${apiDomain}/crm/v2/Contacts`,
    {
      data: [{
        First_Name:  firstName,
        Last_Name:   lastName,
        Mobile:      phone,
        Phone:       phone,
        Lead_Source: 'WhatsApp Bot'
      }]
    },
    {
      headers: {
        Authorization:  `Zoho-oauthtoken ${token}`,
        'Content-Type': 'application/json'
      },
      timeout: 8000
    }
  )

  const result = response.data?.data?.[0]
  if (result?.code === 'SUCCESS') {
    const newId = result.details?.id
    console.log(`Zoho: contact created — ${name} (${newId})`)
    return newId
  }

  throw new Error(`Zoho contact creation failed: ${JSON.stringify(result)}`)
}

// ─── Turno → Horario_de_Entrega pick-list mapper ─────────────────────────────

/**
 * Convert the raw turno string extracted from conversation history into the
 * exact pick-list value that exists in your Zoho module:
 *   "Inmediato" | "12:30 a 1:30" | "1:30 a 2:30" | "2:30 a 3:30"
 */
function mapTurnoToPickList(turno) {
  if (!turno) return 'Inmediato'
  const t = turno.toString().trim()
  // Almuerzo turno slots
  if (/12[:\s]?30/.test(t))            return '12:30 a 1:30'
  if (/1[:\s]?30|13[:\s]?30/.test(t))  return '1:30 a 2:30'
  if (/2[:\s]?30|14[:\s]?30/.test(t))  return '2:30 a 3:30'
  // Morning scheduled deliveries (carta orders or early scheduled):
  // Zoho pick-list has no morning slots, so "Inmediato" is the closest available
  // value. The actual requested time is visible in the record Name and Notas_de_Cocina.
  if (/^(8|9|10|11)[:\s]?\d{0,2}\s*(am|AM)?/.test(t)) return 'Inmediato'
  return 'Inmediato'   // fallback for any unrecognised format
}

// ─── Delivery record creation ──────────────────────────────────────────────────

/**
 * Main entry point — called after customer sends payment screenshot (HANDOFF_PAYMENT).
 *
 * Flow:
 *   1. Look up Zoho Contact by phone
 *   2. If not found → auto-create Contact
 *   3. Create record in Planificación de Entregas, linked to contact
 *
 * @param {Object} orderData
 *   phone, customerName, itemsText, total, deliveryCost, address, turno
 */
async function createZohoDeliveryRecord(orderData) {
  const token      = await getZohoAccessToken()
  const apiDomain  = process.env.ZOHO_API_DOMAIN || 'https://www.zohoapis.com'
  const moduleName = process.env.ZOHO_MODULE_API_NAME || 'Planificacion_de_Entregas'

  // ── Step 1: look up or create the contact ─────────────────────────────────
  let contact = await lookupZohoContact(orderData.phone)
  if (!contact) {
    const newId = await createZohoContact(orderData.phone, orderData.customerName)
    contact = { id: newId, name: orderData.customerName }
  }

  // ── Step 2: build the record using verified field API names ───────────────
  // Primary source: pre-computed fields frozen in pending_order at order summary time.
  // Fallbacks: compute on the fly for legacy orders that predate these fields.
  // Get Ecuador local date (UTC-5) timezone-independently
  const utcMs = Date.now();
  const ecuadorOffsetMs = -5 * 60 * 60 * 1000;
  const ecuadorTimeMs = utcMs + ecuadorOffsetMs;
  const tempDate = new Date(ecuadorTimeMs);
  const localOffsetMs = tempDate.getTimezoneOffset() * 60 * 1000;
  const nowEc = new Date(ecuadorTimeMs + localOffsetMs);
  const yyyy = nowEc.getFullYear();
  const mm = String(nowEc.getMonth() + 1).padStart(2, '0');
  const dd = String(nowEc.getDate()).padStart(2, '0');
  const today = `${yyyy}-${mm}-${dd}`;

  // fechaEnvio is frozen in pending_order at order time → correct even if payment
  // arrives after midnight. Fall back to scheduledDate → today for older orders.
  const deliveryDate = orderData.fechaEnvio
    || orderData.scheduledDate
    || today

  // horarioEntrega is frozen in pending_order at order time → no re-computation needed.
  // Legacy fallback: re-derive from orderType + turno using local logic.
  const horarioEntrega = orderData.horarioEntrega
    || ((orderData.orderType === 'almuerzo')
        ? mapTurnoToPickList(orderData.turno)
        : (orderData.turno || 'Inmediato'))

  const record = {
    // Record display name — uses delivery date so it's meaningful at a glance
    Name:               `Pedido - ${contact.name} - ${deliveryDate}`,

    // Contact lookup — field API name: "Cliente"
    Cliente:            { id: contact.id },

    // Phone (stored directly on the record for quick access)
    Telefono:           orderData.phone,

    // Order items — kitchen-facing notes
    Notas_de_Cocina:    orderData.itemsText || '',

    // Delivery address (typed text) — Scenario 1
    Direccion:          orderData.address   || '',

    // Clean Google Maps URL — always built from real coords, stored in last_location_url.
    // Fallback: reconstruct from locationPin coords for older pending_order records that
    // predate the last_location_url column (locationUrl was null, locationPin has lat/lng).
    Ubicacion:          orderData.locationUrl ||
                        (orderData.locationPin?.lat != null
                          ? `https://www.google.com/maps?q=${orderData.locationPin.lat},${orderData.locationPin.lng}`
                          : ''),

    // Pre-computed at order time — slot for almuerzo, raw time or 'Inmediato' for carta
    Horario_de_Entrega: horarioEntrega,

    // Financial fields
    Valor_Venta:        orderData.total        || 0,
    Envio_Cobrado:      orderData.deliveryCost ?? 0,

    // Status — always "Pendiente de Pago" on creation; human updates to "Pago Confirmado"
    Estado:             'Pendiente de Pago',

    // Delivery type — triggers kitchen printer workflow
    Tipo_de_Entrega:    'Individual',

    // Record origin — used by Zoho workflow to gate human-approval step:
    // bot-created records stay at 'Pendiente de Pago' until operator confirms
    // payment and switches Estado → 'Pago Confirmado', which fires the second workflow.
    Fuente:             'WhatsAppBot',

    // Quantity — almuerzo orders only (null/absent for carta orders)
    ...(orderData.cantidad != null && { Cantidad: orderData.cantidad }),

    // Pre-computed delivery date — frozen at order time, not at payment time
    Fecha_de_Envio:     deliveryDate,

    // Meta ad campaign attribution — only set when customer arrived via a tracked ad
    ...(orderData.campana && { Campana_Meta: orderData.campana })
  }

  // ── Step 3: POST the record ───────────────────────────────────────────────
  const response = await axios.post(
    `${apiDomain}/crm/v2/${moduleName}`,
    // "trigger" tells Zoho to fire Workflow Rules on this API-created record —
    // by default API calls are silent and skip all automation.
    { data: [record], trigger: ['workflow'] },
    {
      headers: {
        Authorization:  `Zoho-oauthtoken ${token}`,
        'Content-Type': 'application/json'
      },
      timeout: 10_000
    }
  )

  const result = response.data?.data?.[0]
  if (result?.code === 'SUCCESS') {
    const recordId = result.details?.id
    console.log(`Zoho: delivery record created — ${record.Name} (${recordId})`)
    return recordId
  }

  throw new Error(`Zoho delivery record creation failed: ${JSON.stringify(result)}`)
}

// ─── Plan turno → Deals Horario_de_Entrega pick-list ─────────────────────────
// The Deals module ONLY has the 3 almuerzo slots (no "Inmediato"). Return a valid
// slot or null (so the field is omitted rather than rejected).
function mapTurnoToDealSlot(turno) {
  if (!turno) return null
  const t = turno.toString().trim()
  if (/12[:\s]?30/.test(t))            return '12:30 a 1:30'
  if (/1[:\s]?30|13[:\s]?30/.test(t))  return '1:30 a 2:30'
  if (/2[:\s]?30|14[:\s]?30/.test(t))  return '2:30 a 3:30'
  return null
}

// ─── Deal creation (prepaid lunch PLANS) ─────────────────────────────────────

/**
 * Create a Zoho **Deal** for a prepaid lunch plan (NOT a Planificacion_de_Entregas
 * record — that's for single same-day orders). Fired on payment, same trigger point
 * as createZohoDeliveryRecord, but routed here when orderData.orderType === 'plan'.
 *
 * Field mapping (see .claude/rules/zoho.md):
 *   total (grandTotal, incl. shipping) → Amount
 *   cantidad (totalLunches)            → Almuerzos_Comprados + Almuerzos_Restantes
 *   address                            → Direccion_de_Envio
 *   locationUrl/locationPin            → Ubicacion
 *   turno                              → Horario_de_Entrega (valid slot or omitted)
 *   itemsText (plan breakdown)         → Notas_de_Entrega
 *   Stage = 'Pendiente de Pago' (human flips to 'Pago Confirmado' after verifying).
 *   No automation/workflow is triggered. A human creates the daily PE records manually.
 *
 * @param {Object} orderData  pending_order snapshot with orderType:'plan'
 */
async function createZohoDealRecord(orderData) {
  const token      = await getZohoAccessToken()
  const apiDomain  = process.env.ZOHO_API_DOMAIN || 'https://www.zohoapis.com'
  const moduleName = process.env.ZOHO_DEALS_MODULE_API_NAME || 'Deals'

  // Step 1: look up or create the contact (reuse the same helpers as deliveries)
  let contact = await lookupZohoContact(orderData.phone)
  if (!contact) {
    const newId = await createZohoContact(orderData.phone, orderData.customerName)
    contact = { id: newId, name: orderData.customerName }
  }

  // Ecuador local date/time (UTC-5), timezone-independent
  const utcMs = Date.now()
  const nowEc = new Date(utcMs + (-5 * 60 * 60 * 1000) + (new Date(utcMs - 5 * 60 * 60 * 1000).getTimezoneOffset() * 60 * 1000))
  const yyyy = nowEc.getFullYear()
  const mm = String(nowEc.getMonth() + 1).padStart(2, '0')
  const dd = String(nowEc.getDate()).padStart(2, '0')
  const HH = String(nowEc.getHours()).padStart(2, '0')
  const MI = String(nowEc.getMinutes()).padStart(2, '0')
  const today    = `${yyyy}-${mm}-${dd}`
  const nowIso   = `${today}T${HH}:${MI}:00-05:00`

  const lunches  = orderData.cantidad != null ? Number(orderData.cantidad) : null
  // Tipo_de_Plan picklist only has these two values; omit for custom totals.
  const tipoDePlan = lunches === 5 ? 'Plan Semanal 5'
                   : lunches === 20 ? 'Plan Mensual 20'
                   : null
  const tipoLabel  = lunches === 5 ? 'Semanal' : lunches === 20 ? 'Mensual' : 'Personalizado'
  const slot       = mapTurnoToDealSlot(orderData.turno || orderData.horarioEntrega)

  const ubicacion = orderData.locationUrl
    || (orderData.locationPin?.lat != null
        ? `https://www.google.com/maps?q=${orderData.locationPin.lat},${orderData.locationPin.lng}`
        : '')

  const record = {
    Deal_Name:           `Plan ${tipoLabel} - ${contact.name} - ${today}`,
    Stage:               'Pendiente de Pago',
    Amount:              orderData.total ?? 0,            // grandTotal, shipping included
    Contact_Name:        { id: contact.id },
    Telefono:            orderData.phone,
    Estado_del_Plan:     'Activo',
    Fecha_de_Activaci_n: nowIso,
    Direccion_de_Envio:  orderData.address || '',
    Ubicacion:           ubicacion,
    Notas_de_Entrega:    orderData.itemsText || '',
    // No Fuente field on Deals — mark bot origin in the internal notes for the operator.
    Notas_Internas:      `Origen: WhatsAppBot (plan cotizado por el bot). Envío incluido en el total.`,
    ...(lunches != null && { Almuerzos_Comprados: lunches, Almuerzos_Restantes: lunches }),
    ...(tipoDePlan && { Tipo_de_Plan: tipoDePlan }),
    ...(slot && { Horario_de_Entrega: slot }),
    ...(orderData.campana && { Campana_Meta: orderData.campana })
  }

  // POST WITHOUT trigger → no workflow/automation fires (per spec).
  const response = await axios.post(
    `${apiDomain}/crm/v2/${moduleName}`,
    { data: [record] },
    {
      headers: {
        Authorization:  `Zoho-oauthtoken ${token}`,
        'Content-Type': 'application/json'
      },
      timeout: 10_000
    }
  )

  const result = response.data?.data?.[0]
  if (result?.code === 'SUCCESS') {
    const recordId = result.details?.id
    console.log(`Zoho: DEAL created — ${record.Deal_Name} (${recordId})`)
    return recordId
  }

  throw new Error(`Zoho deal creation failed: ${JSON.stringify(result)}`)
}

module.exports = { createZohoDeliveryRecord, createZohoDealRecord }
