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
  if (/12[:\s]?30/.test(t))          return '12:30 a 1:30'
  if (/1[:\s]?30|13[:\s]?30/.test(t)) return '1:30 a 2:30'
  if (/2[:\s]?30|14[:\s]?30/.test(t)) return '2:30 a 3:30'
  return 'Inmediato'   // carta orders or unrecognised turno → immediate
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
  const today = new Date().toISOString().split('T')[0]  // YYYY-MM-DD

  const record = {
    // Record display name
    Name:               `Pedido - ${contact.name} - ${today}`,

    // Contact lookup — field API name: "Cliente"
    Cliente:            { id: contact.id },

    // Phone (stored directly on the record for quick access)
    Telefono:           orderData.phone,

    // Order items — "Notas de Cocina" is the kitchen-facing notes field
    Notas_de_Cocina:    orderData.itemsText || '',

    // Delivery address
    Direccion:          orderData.address   || '',

    // Turno mapped to exact pick-list value: "Inmediato" | "12:30 a 1:30" | "1:30 a 2:30" | "2:30 a 3:30"
    Horario_de_Entrega: mapTurnoToPickList(orderData.turno),

    // Financial fields
    Valor_Venta:        orderData.total        || 0,
    Costo_de_Envio:     orderData.deliveryCost ?? 0,

    // Status — always "Pendiente de Pago" on creation; human updates to "Pago Confirmado"
    Estado:             'Pendiente de Pago',

    // Delivery date — defaulting to today; human can adjust if needed
    Fecha_de_Envio:     today
  }

  // ── Step 3: POST the record ───────────────────────────────────────────────
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
    console.log(`Zoho: delivery record created — ${record.Name} (${recordId})`)
    return recordId
  }

  throw new Error(`Zoho delivery record creation failed: ${JSON.stringify(result)}`)
}

module.exports = { createZohoDeliveryRecord }
