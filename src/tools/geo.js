'use strict'
const {
  getDeliveryZoneByAddress,
  getDeliveryZoneByCoordinates,
  resolveGoogleMapsUrl,
  saveDeliveryAddress,
  saveRawAddress,
  saveDeliveryZoneOnly,
  saveLocationPin,
  lookupDeliveryCost
} = require('../memory')
const { detectOrderTypeFromHistory, detectAlmuerzoQty } = require('./order')

/**
 * Tool schemas passed to every Claude API call.
 * Claude calls these autonomously when a customer provides an address or Maps link.
 */
const GEOCODING_TOOLS = [
  {
    name: 'geocode_address',
    description: 'Geocode a customer delivery address to get the delivery zone and exact cost. Call this whenever the customer provides a delivery address (street name, intersection, landmark, or any text describing their location). Also call this when the customer confirms their previously stored address.',
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
 * Execute a geocoding tool call from Claude.
 * Returns a plain object that is JSON-serialized and sent back as tool_result.
 *
 * @param {string} toolName - 'geocode_address' | 'resolve_maps_url'
 * @param {object} input    - tool input as chosen by Claude
 * @param {object} context  - { phone, history }
 */
async function executeGeoTool(toolName, input, context) {
  const { phone, history } = context

  if (toolName === 'geocode_address') {
    const address = input.address
    console.log(`[tool:geocode_address] Geocoding: "${address}"`)

    const result = await getDeliveryZoneByAddress(address).catch(() => null)

    if (!result) {
      saveRawAddress(phone, address).catch(() => {})
      return { success: false, error: 'Could not geocode this address. Ask the customer for a more specific reference (cross street, landmark, or Google Maps pin).' }
    }

    const isLowConfidence = ['GEOMETRIC_CENTER', 'APPROXIMATE'].includes(result.locationType)
    if (isLowConfidence) {
      saveRawAddress(phone, address).catch(() => {})
      return {
        success: false,
        lowConfidence: true,
        formattedAddress: result.formattedAddress,
        error: `Address "${result.formattedAddress}" is not precise enough to calculate delivery cost. Ask the customer for the house number, building name, or a Google Maps pin.`
      }
    }

    const { zone, distanceKm, formattedAddress } = result

    if (zone === 4 || zone === '4') {
      saveDeliveryAddress(phone, address, zone, distanceKm).catch(() => {})
      return {
        success: true,
        zone: 4,
        distanceKm,
        formattedAddress,
        isZone4: true,
        instruction: 'ZONA 4 — outside delivery range. Respond EXACTLY: "¡Claro! Permíteme un momento, estamos verificando el costo de envío para tu sector 🔍 En breve un asesor te confirma los detalles." then emit HANDOFF.'
      }
    }

    const orderType = detectOrderTypeFromHistory(history)
    const qty = detectAlmuerzoQty(history)
    const deliveryCost = await lookupDeliveryCost(zone, orderType, null, orderType === 'almuerzo' ? qty : null).catch(() => null)

    saveDeliveryAddress(phone, address, zone, distanceKm).catch(() => {})

    return {
      success: true,
      zone,
      distanceKm,
      formattedAddress,
      deliveryCost,
      isZone4: false,
      instruction: `Use deliveryCost $${deliveryCost != null ? deliveryCost.toFixed(2) : '(see zone tables)'} exactly. Do NOT calculate or estimate a different price. Zone number must NEVER be shown to the customer.`
    }
  }

  if (toolName === 'resolve_maps_url') {
    const url = input.url
    console.log(`[tool:resolve_maps_url] Resolving: "${url}"`)

    const coords = await resolveGoogleMapsUrl(url).catch(() => null)
    const zoneResult = coords
      ? await getDeliveryZoneByCoordinates(coords.lat, coords.lng).catch(() => null)
      : await getDeliveryZoneByAddress(url).catch(() => null)

    if (!zoneResult) {
      return { success: false, error: 'Could not determine delivery zone from this Maps URL. Ask the customer to type their address instead.' }
    }

    const { zone, distanceKm } = zoneResult

    if (coords) {
      saveLocationPin(phone, coords.lat, coords.lng).catch(() => {})
    }
    saveDeliveryZoneOnly(phone, zone, distanceKm).catch(() => {})

    if (zone === 4 || zone === '4') {
      return {
        success: true,
        zone: 4,
        distanceKm,
        isZone4: true,
        locationUrl: coords ? `https://www.google.com/maps?q=${coords.lat},${coords.lng}` : url,
        instruction: 'ZONA 4 — outside delivery range. Respond EXACTLY: "¡Claro! Permíteme un momento, estamos verificando el costo de envío para tu sector 🔍 En breve un asesor te confirma los detalles." then emit HANDOFF.'
      }
    }

    const orderType = detectOrderTypeFromHistory(history)
    const qty = detectAlmuerzoQty(history)
    const deliveryCost = await lookupDeliveryCost(zone, orderType, null, orderType === 'almuerzo' ? qty : null).catch(() => null)
    const locationUrl = coords ? `https://www.google.com/maps?q=${coords.lat},${coords.lng}` : url

    return {
      success: true,
      zone,
      distanceKm,
      deliveryCost,
      isZone4: false,
      locationUrl,
      instruction: `Use deliveryCost $${deliveryCost != null ? deliveryCost.toFixed(2) : '(see zone tables)'} exactly. In the order summary write the address as "📍 ${url}". Do NOT show zone number to customer.`
    }
  }

  return { success: false, error: `Unknown tool: ${toolName}` }
}

module.exports = { GEOCODING_TOOLS, executeGeoTool }
