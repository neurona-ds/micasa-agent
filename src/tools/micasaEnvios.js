'use strict'
const axios = require('axios')

// --- System alert: pricing API auth/config failure ------------------------
// The pricing API is a hard dependency. If it rejects auth, EVERY delivery
// order is silently force-handed-off to a human — invisible unless we page
// someone. Railway runs a single long-lived process, so an in-memory throttle
// is enough to avoid alerting the admin on every affected customer message.
let lastAuthAlertAt = 0
const AUTH_ALERT_COOLDOWN_MS = 30 * 60 * 1000 // 30 min

async function alertAdminPricingDown(detail) {
  const adminPhone = process.env.ADMIN_PHONE
  const watiKey = process.env.WATI_API_KEY
  if (!adminPhone || !watiKey) return

  const now = Date.now()
  if (now - lastAuthAlertAt < AUTH_ALERT_COOLDOWN_MS) return // throttled
  lastAuthAlertAt = now

  const text =
    '🛠️ *FALLA DEL SISTEMA — API de envíos*\n' +
    `La API de precios de envío está rechazando las solicitudes (${detail}).\n` +
    'Mientras tanto, los pedidos con envío se derivan a un asesor.\n' +
    'Revisar la variable *API_KEY* en Vercel (proyecto micasa-delivery) y redeploy.'

  try {
    await axios.post(
      `https://live-mt-server.wati.io/470858/api/v1/sendSessionMessage/${adminPhone}`,
      null,
      { params: { messageText: text }, headers: { Authorization: watiKey, 'Content-Type': 'application/json' } }
    )
    console.error(`[micasa-envios] ADMIN ALERT sent — pricing API failing (${detail})`)
  } catch (e) {
    console.error('[micasa-envios] Failed to send admin alert:', e.response?.data || e.message)
  }
}

/**
 * Call the Micasa Delivery App API to calculate delivery pricing and zone info.
 * 
 * @param {Object} params
 * @param {string} params.address - Raw text address, Google Maps URL, or "lat,lng" string
 * @param {string} params.orderType - 'almuerzo' | 'carta' | 'mixto'
 * @param {number} [params.almuerzoQty] - Number of almuerzos (for quantity tiers)
 * @param {number} [params.subtotal] - Order subtotal value (for value tiers)
 * @returns {Promise<Object|null>} - Returns the quote response or null on failure
 */
async function getDeliveryQuote({ address, orderType, almuerzoQty, subtotal }) {
  try {
    const apiUrl = process.env.MICASA_ENVIOS_API_URL
    const apiKey = process.env.MICASA_ENVIOS_API_KEY

    if (!apiUrl) {
      console.warn('[micasa-envios] MICASA_ENVIOS_API_URL is not configured')
      return null
    }

    const payload = {
      order_type: orderType || 'carta',
      address,
      almuerzo_qty: almuerzoQty || 0,
      subtotal: subtotal || 0
    }

    console.log('[micasa-envios] Request payload:', JSON.stringify(payload))

    const response = await axios.post(apiUrl, payload, {
      headers: {
        'X-API-Key': apiKey,
        'Content-Type': 'application/json'
      },
      timeout: 9000
    })

    return response.data
  } catch (error) {
    const data = error.response?.data
    console.error('[micasa-envios] API error:', data || error.message)
    // Page the admin when the failure is our own misconfiguration (bad/missing
    // key), not a normal business error like BELOW_MIN_ORDER or ZONE_4_HANDOFF.
    if (data && data.ok === false && (data.error === 'UNAUTHORIZED' || data.error === 'SERVER_MISCONFIGURED')) {
      alertAdminPricingDown(data.error).catch(() => {})
    }
    if (data) {
      return data
    }
    return null
  }
}

module.exports = { getDeliveryQuote }
