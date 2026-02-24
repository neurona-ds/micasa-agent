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
 * Returns the contact { id, Full_Name } or null if not found.
 */
async function lookupZohoContact(phone) {
  try {
    const token     = await getZohoAccessToken()
    const apiDomain = process.env.ZOHO_API_DOMAIN || 'https://www.zohoapis.com'

    // Normalize phone: strip leading + and any non-digit characters for search
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
    // 404 from Zoho search API just means "no results" — not a real error
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

  // Split name into First / Last (Zoho requires them separately)
  const parts     = (name || phone).trim().split(/\s+/)
  const firstName = parts[0]
  const lastName  = parts.slice(1).join(' ') || '-'

  const response = await axios.post(
    `${apiDomain}/crm/v2/Contacts`,
    {
      data: [{
        First_Name: firstName,
        Last_Name:  lastName,
        Mobile:     phone,
        Phone:      phone,
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

// ─── Delivery record creation ──────────────────────────────────────────────────

/**
 * Main entry point called after customer sends payment screenshot.
 *
 * Flow:
 *   1. Look up Zoho Contact by phone
 *   2. If not found → create Contact
 *   3. Create record in Planificación de Entregas module, linked to contact
 *
 * @param {Object} orderData
 *   phone, customerName, itemsText, total, deliveryCost, address, turno
 */
async function createZohoDeliveryRecord(orderData) {
  const token      = await getZohoAccessToken()
  const apiDomain  = process.env.ZOHO_API_DOMAIN || 'https://www.zohoapis.com'
  // IMPORTANT: verify this API name in Zoho → Settings → Developer Space → APIs → Modules
  const moduleName = process.env.ZOHO_MODULE_API_NAME || 'Planificacion_de_Entregas'

  // ── Step 1: look up or create the contact ──────────────────────────────────
  let contact = await lookupZohoContact(orderData.phone)

  if (!contact) {
    const newId = await createZohoContact(orderData.phone, orderData.customerName)
    contact = { id: newId, name: orderData.customerName }
  }

  // ── Step 2: build the delivery record ──────────────────────────────────────
  // Field API names below must match your Zoho module exactly.
  // To find them: Zoho CRM → Settings → Modules and Fields → click your module → each field shows its API name.
  const record = {
    // Standard / linked fields
    Name:           `Pedido ${orderData.phone} ${new Date().toLocaleDateString('es-EC')}`,
    Contact_Name:   { id: contact.id },

    // Order details
    // ⚠️  Adjust these API field names to match your module:
    Descripcion_Pedido: orderData.itemsText  || '',
    Direccion_Entrega:  orderData.address    || '',
    Turno:              orderData.turno      || '',
    Total_Pedido:       orderData.total      || 0,
    Costo_Envio:        orderData.deliveryCost ?? 0,

    // Payment status — set to Pending; human updates to Paid on receipt of screenshot
    Estado_Pago:    'Pendiente',
    Fecha_Pedido:   new Date().toISOString().split('T')[0],   // YYYY-MM-DD

    // Phone for quick reference without opening the contact
    Telefono_Cliente: orderData.phone
  }

  // ── Step 3: POST the record ────────────────────────────────────────────────
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
