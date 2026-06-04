'use strict'
const axios = require('axios')

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
      timeout: 5000
    })

    return response.data
  } catch (error) {
    console.error('[micasa-envios] API error:', error.response?.data || error.message)
    if (error.response?.data) {
      return error.response.data
    }
    return null
  }
}

module.exports = { getDeliveryQuote }
