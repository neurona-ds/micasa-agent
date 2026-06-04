'use strict'
const {
  getDeliveryZoneByAddress,
  getDeliveryZoneByCoordinates,
  resolveGoogleMapsUrl,
  saveDeliveryAddress,
  saveRawAddress,
  saveDeliveryZoneOnly,
  saveLocationPin,
  lookupDeliveryCost,
  getAllConfig,
  getProducts
} = require('../memory')
const { detectOrderTypeFromHistory, detectAlmuerzoQty } = require('./order')
const { getDeliveryQuote } = require('./micasaEnvios')

/**
 * Tool schemas passed to every Claude API call.
 * Claude calls these autonomously when a customer provides an address or Maps link.
 */
const GEOCODING_TOOLS = [
  {
    name: 'geocode_address',
    description: 'Geocode a customer delivery address to get the delivery zone and exact cost. Call this whenever the customer provides a delivery address. IMPORTANT: (1) Before calling, extract only the address from the customer message — fix spelling mistakes, normalize street names, and strip any non-address text (e.g. "no tengo la ubicación", "calcula ahora", "por favor"). (2) If the result returns lowConfidence: true and the address includes a house number, call this tool again with ONLY the street intersection — for example if "Guanguiltagua N34-401 y Federico Paez" fails, retry with "Guanguiltagua y Federico Paez". Google Maps finds intersections more reliably than specific house numbers.',
    input_schema: {
      type: 'object',
      properties: {
        address: {
          type: 'string',
          description: 'The delivery address or location description provided by the customer'
        }
      },
      required: ['address']
    }
  },
  {
    name: 'resolve_maps_url',
    description: 'Resolve a Google Maps URL sent by the customer (maps.app.goo.gl, goo.gl/maps, or google.com/maps links) to get their exact delivery zone and cost.',
    input_schema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'The full Google Maps URL from the customer message'
        }
      },
      required: ['url']
    }
  }
]

/**
 * Estimate the subtotal of the current order based on the conversation history
 * so that we can pass it to the delivery quote API for minimum order checking.
 */
async function estimateSubtotal(history, orderType, qty) {
  let subtotal = 0
  const config = await getAllConfig().catch(() => ({}))
  const products = await getProducts().catch(() => [])

  if (orderType === 'almuerzo' || orderType === 'mixed') {
    const almuerzoPrice = parseFloat(config.almuerzo_price_delivery || '5.50')
    subtotal += qty * almuerzoPrice
  }

  if (orderType === 'carta' || orderType === 'mixed') {
    const recentUserMsgs = history.filter(h => h.role === 'user').slice(-10)
    const combinedText = recentUserMsgs.map(h => h.message.toLowerCase()).join(' ')
    
    for (const prod of products) {
      if (combinedText.includes(prod.name.toLowerCase())) {
        const escapedName = prod.name.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&')
        const regex = new RegExp(`(\\d+|un|una|dos|tres|cuatro|cinco)?\\s*${escapedName}`, 'i')
        const match = combinedText.match(regex)
        let prodQty = 1
        if (match && match[1]) {
          const rawQty = match[1].toLowerCase()
          if (/^\d+$/.test(rawQty)) {
            prodQty = parseInt(rawQty)
          } else if (rawQty === 'un' || rawQty === 'una') {
            prodQty = 1
          } else if (rawQty === 'dos') {
            prodQty = 2
          } else if (rawQty === 'tres') {
            prodQty = 3
          } else if (rawQty === 'cuatro') {
            prodQty = 4
          } else if (rawQty === 'cinco') {
            prodQty = 5
          }
        }
        subtotal += prodQty * parseFloat(prod.price)
      }
    }
  }

  return subtotal
}

/**
 * Execute a geocoding tool call from Claude.
 * Returns a plain object that is JSON-serialized and sent back as tool_result.
 *
 * @param {string} toolName - 'geocode_address' | 'resolve_maps_url'
 * @param {object} input    - tool input as chosen by Claude
 * @param {object} context  - { phone, history }
 */
async function executeGeoTool(toolName, input, context) {
  const { phone, history, currentMessage } = context

  const fullHistory = [...history]
  if (currentMessage) {
    fullHistory.push({ role: 'user', message: currentMessage })
  }

  const orderType = detectOrderTypeFromHistory(fullHistory)
  const qty = detectAlmuerzoQty(fullHistory)
  const subtotal = await estimateSubtotal(fullHistory, orderType, qty)

  if (toolName === 'geocode_address') {
    const address = input.address
    console.log(`[tool:geocode_address] Geocoding via API: "${address}" (subtotal: $${subtotal})`)

    const quote = await getDeliveryQuote({
      address,
      orderType,
      almuerzoQty: qty,
      subtotal
    })

    if (!quote) {
      saveRawAddress(phone, address).catch(() => {})
      return { success: false, error: 'Could not geocode this address. Ask the customer for a more specific reference (cross street, landmark, or Google Maps pin).' }
    }

    console.log(`[tool:geocode_address] API result: ok=${quote.ok} zone=${quote.zone} dist=${quote.distance_km}km`)

    if (quote.ok === false) {
      if (quote.error === 'ZONE_4_HANDOFF' || quote.zone === 4) {
        saveDeliveryAddress(phone, address, 4, quote.distance_km).catch(() => {})
        return {
          success: true,
          zone: 4,
          distanceKm: quote.distance_km,
          formattedAddress: address,
          isZone4: true,
          instruction: 'ZONA 4 — outside delivery range. Respond EXACTLY: "¡Claro! Permíteme un momento, estamos verificando el costo de envío para tu sector 🔍 En breve un asesor te confirma los detalles." then emit HANDOFF.'
        }
      }

      if (quote.error === 'BELOW_MIN_ORDER') {
        saveRawAddress(phone, address).catch(() => {})
        return {
          success: false,
          error: `El pedido mínimo para este sector es de $${quote.min_order}. Tu subtotal actual es menor. Por favor agrega más productos.`
        }
      }

      saveRawAddress(phone, address).catch(() => {})
      return {
        success: false,
        error: 'Address is not precise enough or invalid. Ask the customer for a more specific reference (cross street, landmark, or Google Maps pin).'
      }
    }

    saveDeliveryAddress(phone, address, quote.zone, quote.distance_km).catch(() => {})

    return {
      success: true,
      zone: quote.zone,
      distanceKm: quote.distance_km,
      formattedAddress: address,
      deliveryCost: quote.delivery_gross,
      isZone4: false,
      instruction: `Use deliveryCost $${quote.delivery_gross != null ? quote.delivery_gross.toFixed(2) : '0.00'} exactly. Do NOT calculate or estimate a different price. Zone number must NEVER be shown to the customer.`
    }
  }

  if (toolName === 'resolve_maps_url') {
    const url = input.url
    console.log(`[tool:resolve_maps_url] Resolving via API: "${url}" (subtotal: $${subtotal})`)

    const quote = await getDeliveryQuote({
      address: url,
      orderType,
      almuerzoQty: qty,
      subtotal
    })

    if (!quote) {
      return { success: false, error: 'Could not determine delivery zone from this Maps URL. Ask the customer to type their address instead.' }
    }

    if (quote.coords) {
      saveLocationPin(phone, quote.coords.lat, quote.coords.lng).catch(() => {})
    }

    if (quote.ok === false) {
      if (quote.error === 'ZONE_4_HANDOFF' || quote.zone === 4) {
        saveDeliveryZoneOnly(phone, 4, quote.distance_km).catch(() => {})
        return {
          success: true,
          zone: 4,
          distanceKm: quote.distance_km,
          isZone4: true,
          locationUrl: quote.coords ? `https://www.google.com/maps?q=${quote.coords.lat},${quote.coords.lng}` : url,
          instruction: 'ZONA 4 — outside delivery range. Respond EXACTLY: "¡Claro! Permíteme un momento, estamos verificando el costo de envío para tu sector 🔍 En breve un asesor te confirma los detalles." then emit HANDOFF.'
        }
      }

      if (quote.error === 'BELOW_MIN_ORDER') {
        return {
          success: false,
          error: `El pedido mínimo para este sector es de $${quote.min_order}. Tu subtotal actual es menor. Por favor agrega más productos.`
        }
      }

      return { success: false, error: 'Could not determine delivery zone from this Maps URL. Ask the customer to type their address instead.' }
    }

    saveDeliveryZoneOnly(phone, quote.zone, quote.distance_km).catch(() => {})
    const locationUrl = quote.coords ? `https://www.google.com/maps?q=${quote.coords.lat},${quote.coords.lng}` : url

    return {
      success: true,
      zone: quote.zone,
      distanceKm: quote.distance_km,
      deliveryCost: quote.delivery_gross,
      isZone4: false,
      locationUrl,
      instruction: `Use deliveryCost $${quote.delivery_gross != null ? quote.delivery_gross.toFixed(2) : '0.00'} exactly. In the order summary write the address as "📍 ${url}". Do NOT show zone number to customer.`
    }
  }

  return { success: false, error: `Unknown tool: ${toolName}` }
}

module.exports = { GEOCODING_TOOLS, executeGeoTool, estimateSubtotal }
