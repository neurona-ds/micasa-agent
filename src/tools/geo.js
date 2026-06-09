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
const { computePlanQuote, formatPlanBreakdown } = require('./plan')

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
  },
  {
    name: 'quote_plan',
    description: 'Calculate the price of a prepaid lunch PLAN — multiple lunches delivered across DIFFERENT days (not all on the same day). Call this ONLY for plans: "plan semanal", "plan mensual", "almuerzos para toda la semana", "20 almuerzos 4 por día", etc. Do NOT call this for a normal same-day order of several lunches (use geocode_address for those). Before calling you MUST know: (1) totalLunches — total lunches in the plan; (2) lunchesPerDay — how many are delivered each day (1 if one per day); (3) the delivery address. If any of these is unclear, ASK the customer first — never guess. The tool returns the exact price breakdown (food + per-delivery shipping) to present to the customer.',
    input_schema: {
      type: 'object',
      properties: {
        totalLunches: {
          type: 'integer',
          description: 'Total number of lunches in the plan (e.g. 5 = plan semanal, 20 = plan mensual, or any number the customer asks for).'
        },
        lunchesPerDay: {
          type: 'integer',
          description: 'How many lunches are delivered per day. Default 1 (one lunch per day across several days). Use a higher number ONLY if the customer explicitly asks for several per day (e.g. "4 por día").'
        },
        address: {
          type: 'string',
          description: 'The delivery address or Google Maps URL provided by the customer.'
        }
      },
      required: ['totalLunches', 'address']
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

  if (toolName === 'quote_plan') {
    const totalLunches  = parseInt(input.totalLunches)
    const lunchesPerDay = input.lunchesPerDay ? parseInt(input.lunchesPerDay) : 1
    const address       = input.address
    console.log(`[tool:quote_plan] total=${totalLunches} perDay=${lunchesPerDay} addr="${address}"`)

    const q = await computePlanQuote({ totalLunches, lunchesPerDay, address })

    if (!q.ok) {
      if (q.isZone4) {
        return {
          success: true,
          isZone4: true,
          instruction: 'ZONA 4 — fuera del rango de entrega. Responde EXACTAMENTE: "¡Claro! Permíteme un momento, estamos verificando el costo de envío para tu sector 🔍 En breve un asesor te confirma los detalles." y luego emite HANDOFF.'
        }
      }
      if (q.error === 'NON_UNIFORM' || q.error === 'PER_DAY_EXCEEDS_TOTAL' || q.error === 'INVALID_TOTAL') {
        return {
          success: false,
          needsClarification: true,
          error: q.message,
          instruction: 'Pide al cliente que aclare el plan (cuántos almuerzos en total y cuántos por día). NO muestres ningún precio todavía.'
        }
      }
      if (q.error === 'BELOW_MIN_ORDER') {
        return { success: false, error: q.message }
      }
      return { success: false, error: q.message || 'No se pudo cotizar el plan. Pide una dirección más específica o un pin de Maps.' }
    }

    // Save the geocoded address/zone so the human asesor has it on handoff.
    saveDeliveryAddress(phone, address, q.zone, q.distanceKm).catch(() => {})

    const breakdown = formatPlanBreakdown(q)
    return {
      success: true,
      isPlan: true,
      totalLunches:   q.totalLunches,
      lunchesPerDay:  q.lunchesPerDay,
      days:           q.days,
      perDayDelivery: q.perDayDelivery,
      foodTotal:      q.foodTotal,
      shippingTotal:  q.shippingTotal,
      grandTotal:     q.grandTotal,
      zone:           q.zone,
      breakdown,
      instruction:
        'Este es un PLAN — lo FINALIZA un asesor humano, NO el bot. ' +
        'Presenta el desglose de abajo EXACTAMENTE como está (puedes añadir una línea breve y cálida de introducción). ' +
        'Luego informa al cliente que un asesor se comunicará en breve para confirmar el plan y coordinar el pago, y emite HANDOFF en el MISMO mensaje. ' +
        'PROHIBIDO: preguntar "¿Confirmas tu pedido?", enviar datos bancarios, o generar el bloque <ORDEN>.\n\n' +
        'DESGLOSE:\n' + breakdown
    }
  }

  return { success: false, error: `Unknown tool: ${toolName}` }
}

module.exports = { GEOCODING_TOOLS, executeGeoTool, estimateSubtotal }
