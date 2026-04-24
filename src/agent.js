const Anthropic = require('@anthropic-ai/sdk')
const { getHistory, saveMessage, upsertCustomer, getAllConfig, getProducts, getDeliveryZones, getDeliveryTiers, getAlmuerzoDeliveryTiers, getDeliveryZoneByAddress, getDeliveryZoneByCoordinates, resolveGoogleMapsUrl, getCurrentCycle, getWeekAlmuerzos, getPaymentMethods, saveDeliveryAddress, saveRawAddress, saveDeliveryZoneOnly, saveLocationPin, getCustomerAddress, getBusinessHours, lookupDeliveryCost, savePendingOrder, getPendingOrder, clearPendingOrder, getOrCreateSession, endSession } = require('./memory')
const { createZohoDeliveryRecord } = require('./zoho')
const { getFlags, setFlag, clearFlags } = require('./state/flags')
const { resolveDeliveryZone } = require('./tools/geo')
const { detectOrderTypeFromHistory, detectAlmuerzoQty, extractOrderDataForZoho, parseScheduledDate } = require('./tools/order')
const fs   = require('fs')
const path = require('path')
require('dotenv').config({ path: path.resolve(__dirname, '../.env'), override: true })
const { buildScheduleBlock } = require('./prompts/schedule')
const { buildDeliveryBlock }  = require('./prompts/delivery')
const { buildOrderRules }     = require('./prompts/orders')

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
})

// Return a Date object representing the current moment in Ecuador time (UTC-5).
// Ecuador does not observe DST so this offset is always fixed.
// We use this everywhere we need "today" — using raw new Date() returns UTC
// which is 5 hours ahead and causes wrong day-of-week after 7pm Ecuador time.
function nowInEcuador() {
  // Ecuador is UTC-5 with no DST. Use fixed offset arithmetic instead of
  // toLocaleString(), which is unreliable on Railway's minimal Node.js builds
  // and returns UTC time when ICU timezone data is unavailable.
  return new Date(Date.now() - 5 * 60 * 60 * 1000)
}

// ─── Business-hours helpers ────────────────────────────────────────────────────
// All helpers accept the rows returned by getBusinessHours() and fall back to
// the hardcoded Mon–Fri 08:00–15:30 schedule when the DB data is unavailable.

const BH_DAYS_ES = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado']

/**
 * Returns true if the restaurant is currently open according to DB hours.
 * Falls back to hardcoded Mon–Fri 08:00–15:30 if hoursData is null/empty.
 */
function checkIsOpen(hoursData, now) {
  const dow  = now.getDay()
  const hour = now.getHours()
  const min  = now.getMinutes()

  if (!hoursData || hoursData.length === 0) {
    const isWeekend = dow === 0 || dow === 6
    const inHours   = hour >= 8 && (hour < 15 || (hour === 15 && min <= 30))
    return !isWeekend && inHours
  }

  const today = hoursData.find(h => h.day_of_week === dow)
  if (!today || !today.open_time || !today.close_time) return false

  const [openH, openM]   = today.open_time.split(':').map(Number)
  const [closeH, closeM] = today.close_time.split(':').map(Number)
  const nowMins   = hour * 60 + min
  const openMins  = openH * 60 + openM
  const closeMins = closeH * 60 + closeM
  return nowMins >= openMins && nowMins <= closeMins
}

/**
 * Returns today's { openTime, closeTime } as "HH:MM" strings, or null if closed today.
 */
function getTodaySchedule(hoursData, now) {
  if (!hoursData || hoursData.length === 0) return { openTime: '08:00', closeTime: '15:30' }
  const today = hoursData.find(h => h.day_of_week === now.getDay())
  if (!today || !today.open_time || !today.close_time) return null
  return {
    openTime:  today.open_time.substring(0, 5),
    closeTime: today.close_time.substring(0, 5)
  }
}

/**
 * Full weekly schedule for the system prompt.
 * e.g. "Lunes: 08:00–15:30 | Martes: 08:00–15:30 | ... | Sábado: Cerrado | Domingo: Cerrado"
 */
// Ecuador cultural week order: Monday first, Sunday last
const MON_FIRST = [1, 2, 3, 4, 5, 6, 0]

function formatScheduleStr(hoursData) {
  if (!hoursData || hoursData.length === 0) return 'Lunes–Viernes: 08:00–15:30 | Sábado: Cerrado | Domingo: Cerrado'
  const sorted = [...hoursData].sort((a, b) => MON_FIRST.indexOf(a.day_of_week) - MON_FIRST.indexOf(b.day_of_week))
  return sorted.map(h => {
    const day = h.day_name || BH_DAYS_ES[h.day_of_week] || `Día ${h.day_of_week}`
    if (!h.open_time || !h.close_time) return `${day}: Cerrado`
    return `${day}: ${h.open_time.substring(0, 5)}–${h.close_time.substring(0, 5)}`
  }).join(' | ')
}

/**
 * Short inline label for prompt rules.
 * e.g. "lunes a viernes de 08:00 a 15:30"
 */
function openDaysLabel(hoursData) {
  if (!hoursData || hoursData.length === 0) return 'lunes a viernes de 08:00 a 15:30'
  const openRows = [...hoursData]
    .filter(h => h.open_time && h.close_time)
    .sort((a, b) => MON_FIRST.indexOf(a.day_of_week) - MON_FIRST.indexOf(b.day_of_week))
  if (openRows.length === 0) return '(sin horario configurado)'
  const dayNames = openRows.map(r => (r.day_name || BH_DAYS_ES[r.day_of_week] || `día ${r.day_of_week}`).toLowerCase())
  const daysStr = dayNames.length === 1
    ? dayNames[0]
    : `${dayNames[0]} a ${dayNames[dayNames.length - 1]}`
  const openT  = openRows[0].open_time.substring(0, 5)
  const closeT = openRows[0].close_time.substring(0, 5)
  return `${daysStr} de ${openT} a ${closeT}`
}
// ──────────────────────────────────────────────────────────────────────────────

function formatProducts(products) {
  if (!products || products.length === 0) return '(Menú no disponible)'

  const grouped = {}
  for (const p of products) {
    if (!grouped[p.category]) grouped[p.category] = []
    grouped[p.category].push(p)
  }

  return Object.entries(grouped).map(([category, items]) => {
    const lines = items.map(p => {
      const desc = p.description ? ` — ${p.description}` : ''
      return `  - ${p.name}: $${Number(p.price).toFixed(2)}${desc}`
    }).join('\n')
    return `${category.toUpperCase()}\n${lines}`
  }).join('\n\n')
}

function formatDeliveryZones(zones, tiers) {
  if (!zones || zones.length === 0) return '(Consultar costo de delivery con el cliente)'

  return zones.map(z => {
    if (z.requires_approval) {
      return `ZONA ${z.zone_number} (6+ km)
  Barrios: ${z.neighborhoods}
  Pedido mínimo: $${Number(z.min_order).toFixed(2)}
  ⚠️ Responder EXACTAMENTE y SOLO esto: "¡Claro! Permíteme un momento, estamos verificando el costo de envío para tu sector 🔍 En breve un asesor te confirma los detalles." + HANDOFF. NO añadir ninguna frase propia. NO pedir confirmación.`
    }

    const zoneTiers = tiers
      ? tiers.filter(t => t.zone_number === z.zone_number)
      : []

    const tierLines = zoneTiers.map(t => {
      const max = t.order_max ? `$${Number(t.order_max).toFixed(2)}` : 'en adelante'
      return `    • Pedido $${Number(t.order_min).toFixed(2)} – ${max}: envío $${Number(t.delivery_price).toFixed(2)}`
    }).join('\n')

    return `ZONA ${z.zone_number} — Pedido mínimo: $${Number(z.min_order).toFixed(2)}
  Barrios: ${z.neighborhoods}
  Tarifas de envío según valor del pedido:
${tierLines}`
  }).join('\n\n')
}

const DAY_NAMES = {
  1: 'Lunes',
  2: 'Martes',
  3: 'Miércoles',
  4: 'Jueves',
  5: 'Viernes'
}

function formatWeekAlmuerzos(weekAlmuerzos, config) {
  const todayDow = nowInEcuador().getDay() // 0=Sun, 1=Mon...
  const isWeekend = todayDow === 0 || todayDow === 6
  const includes = config.almuerzo_includes || 'Sopa, Plato Fuerte, Jugo Natural y Postre'
  const priceDelivery = config.almuerzo_price_delivery
  const priceInstore = config.almuerzo_price_instore

  const header = `Incluye: ${includes} | Precio en local: $${priceInstore} | Precio con retiro/delivery: $${priceDelivery} (+ costo de envío según zona)`

  if (!weekAlmuerzos || weekAlmuerzos.length === 0) {
    return `${header}\n(Menú de almuerzos no disponible)`
  }

  const weekLabel = isWeekend
    ? '(Menú de la PRÓXIMA semana — Lunes a Viernes)'
    : '(Semana actual — Lunes a Viernes)'

  const days = weekAlmuerzos.map(a => {
    const dayName = DAY_NAMES[a.day_of_week] || `Día ${a.day_of_week}`
    const isToday = a.day_of_week === todayDow
    const label = isToday ? `${dayName} (HOY)` : dayName
    return `  ${label}: Sopa: ${a.soup} | Plato: ${a.main}`
  }).join('\n')

  return `${header}\n${weekLabel}\n${days}`
}

function formatPaymentMethods(methods) {
  if (!methods || methods.length === 0) return '(No hay métodos de pago disponibles)'
  return methods.map(m =>
    `*${m.bank}*\nTipo: ${m.account_type}\nCuenta: ${m.account_number}\nTitular: ${m.account_holder}${m.cedula ? `\nCédula: ${m.cedula}` : ''}`
  ).join('\n\n')
}

function formatAlmuerzoDeliveryTiers(tiers) {
  if (!tiers || tiers.length === 0) return '(Tarifas de almuerzo no disponibles)'

  const byZone = {}
  for (const t of tiers) {
    if (!byZone[t.zone_number]) byZone[t.zone_number] = []
    byZone[t.zone_number].push(t)
  }

  return Object.entries(byZone).map(([zone, zoneTiers]) => {
    if (zoneTiers.some(t => t.requires_approval)) {
      return `ZONA ${zone} (6+ km) — ⚠️ Responder EXACTAMENTE y SOLO esto: "¡Claro! Permíteme un momento, estamos verificando el costo de envío para tu sector 🔍 En breve un asesor te confirma los detalles." + HANDOFF. NO añadir ninguna frase propia. NO pedir confirmación.`
    }
    const lines = zoneTiers.map(t => {
      const qtyLabel = t.max_qty == null
        ? `${t.min_qty}+ almuerzos`
        : `${t.min_qty} almuerzo${parseInt(t.min_qty) !== 1 ? 's' : ''}`
      const priceLabel = t.is_free ? 'GRATIS 🎉' : `$${Number(t.delivery_price).toFixed(2)}`
      return `    • ${qtyLabel}: envío ${priceLabel}`
    }).join('\n')
    return `ZONA ${zone}:\n${lines}`
  }).join('\n\n')
}

function buildSystemPrompt(config, products, deliveryZones, deliveryTiers, weekAlmuerzos, paymentMethods, almuerzoDeliveryTiers, businessHours) {
  const corePrompt = fs.readFileSync(path.join(__dirname, 'prompts/core.md'), 'utf8')
  const now      = nowInEcuador()
  const menu     = formatProducts(products)
  const almuerzo = formatWeekAlmuerzos(weekAlmuerzos, config)

  return [
    corePrompt,
    buildScheduleBlock(businessHours, config, now, BH_DAYS_ES, MON_FIRST,
                       formatScheduleStr, openDaysLabel, getTodaySchedule, checkIsOpen),
    `MENÚ COMPLETO (Carta):\n${menu}`,
    `MENÚ DE ALMUERZOS (Lunes a Viernes):\n${almuerzo}`,
    `REGLA ABSOLUTA — ALMUERZOS (MÁXIMA PRIORIDAD):
NUNCA menciones almuerzos, menú del día, turnos de almuerzo, planes semanales/mensuales de almuerzo, ni nada relacionado con almuerzos a menos que el cliente lo pregunte explícitamente.
Cuando el cliente pregunte por horarios, atención los domingos, carta o cualquier otra cosa NO relacionada con almuerzos → NO menciones almuerzos. Responde solo lo que se preguntó.
Solo cuando el cliente use palabras como "almuerzo", "menú del día", "menú de hoy", "qué hay hoy", "qué tienen hoy", "menú de la semana", "plan semanal", "plan mensual" → entonces puedes hablar de almuerzos.
IMPORTANTE: "menú de hoy", "menú del día", "qué hay hoy" siempre se refiere al almuerzo del día — trátalo como una pregunta de almuerzo y responde con esa información.`,
    buildDeliveryBlock(deliveryZones, deliveryTiers, almuerzoDeliveryTiers,
                       formatDeliveryZones, formatAlmuerzoDeliveryTiers),
    buildOrderRules(config, paymentMethods, formatPaymentMethods)
  ].join('\n\n')
}

async function processMessage(customerPhone, customerMessage, customerName = null) {
  try {
    // Save customer to db
    await upsertCustomer(customerPhone, customerName)

    // Load persisted geocoding flags from Supabase (survive server restarts)
    const flags = await getFlags(customerPhone)

    // ── Session management ────────────────────────────────────────────────────
    // Get or create the current session for this customer.  All saveMessage()
    // and getHistory() calls below are scoped to this sessionId so Claude only
    // sees messages from the current order — never from a completed previous order.
    // Falls back to null on DB error, which gracefully reverts to full history.
    const sessionId = await getOrCreateSession(customerPhone).catch(e => {
      console.warn('[session] getOrCreateSession failed (non-blocking):', e.message)
      return null
    })

    // ── CAMPAIGN OVERRIDE: Fanesca Semana Santa 2026 ───────────────────────────
    // TODO: REMOVE after campaign ends.
    // Catches three entry points from the Meta Ads campaign:
    //   1. Standard CTA button text: "Quiero información sobre la Fanesca"
    //   2. Full ad copy paste: customer forwards the Meta ad text (contains fb.me /
    //      "Dirección por favor" / 3+ ✅ emojis) — means they're already in order mode
    //   3. Direct price or delivery question mentioning "fanesca" in the same message
    const _fanMsg = customerMessage.trim()
    const _mentionsFanesca     = /fanesca/i.test(_fanMsg)
    const _isStandardCTA       = /quiero informaci[oó]n sobre la fanesca/i.test(_fanMsg)
    const _isAdCopyPaste       = _mentionsFanesca && (
      _fanMsg.includes('fb.me') ||
      /direcci[oó]n por favor/i.test(_fanMsg) ||
      (_fanMsg.match(/✅/g) || []).length >= 3   // 3+ checkmarks = ad copy body
    )
    const _isPriceQuestion     = _mentionsFanesca && !_isStandardCTA &&
      /precio|cu[aá]nto|cuanto|vale|cuesta/i.test(_fanMsg)
    const _isDeliveryQuestion  = _mentionsFanesca && !_isStandardCTA &&
      /entrega|delivery|domicilio|direcci[oó]n|env[ií]o/i.test(_fanMsg)

    if (_isStandardCTA || _isAdCopyPaste || _isPriceQuestion || _isDeliveryQuestion) {
      const allProducts = await getProducts()
      const mainFanesca = allProducts.find(p => /fanesca/i.test(p.name) && !/congelada/i.test(p.name))
      const mainPrice = mainFanesca ? `$${Number(mainFanesca.price).toFixed(2)}` : '$9.50'

      let fanescaReply

      if (_isAdCopyPaste || _isDeliveryQuestion) {
        // Customer is already in "order mode" (forwarded ad copy or asked about delivery)
        // Skip the pitch — go straight to order intake
        fanescaReply = [
          '¡Hola! Con gusto te tomamos tu pedido de Fanesca.',
          '',
          `💰 *Precio: ${mainPrice}* — bacalao opcional incluido sin costo adicional 🍲`,
          '',
          '¿La quieres para entrega a domicilio o consumo en el local? 🏠🚗'
        ].join('\n')
      } else if (_isPriceQuestion) {
        // Just asking the price — quick answer + soft CTA
        fanescaReply = [
          `¡Claro! Nuestra Fanesca Tradicional Quiteña tiene un precio de *${mainPrice}*.`,
          '',
          'El bacalao es opcional e incluido sin costo adicional 🍲',
          '',
          '📅 Para semana santa tenemos pocas unidades — ¿te gustaría reservar la tuya?'
        ].join('\n')
      } else {
        // Standard CTA — full campaign intro
        fanescaReply = [
          '¡Claro! Te cuento sobre nuestra Fanesca 🍲',
          '',
          '',
          '🔥 *FANESCA TRADICIONAL QUITEÑA*',
          '',
          'La mejor de Quito!',
          '✨ Lo que nos diferencia:',
          '',
          '✅ Receta tradicional familiar',
          '✅ Ingredientes frescos del día',
          '✅ Preparación artesanal',
          '✅ Delivery GRATIS en ciertas zonas de Quito',
          '',
          `💰 *Precio: ${mainPrice}*`,
          '',
          '📅 Para semana santa tenemos pocas unidades disponibles pero aún puedes reservar la tuya',
          '',
          '🧊 También ofrecemos Fanesca Congelada con registro sanitario para preparar en casa.',
          '',
          '¿Te gustaría hacer tu pedido o tienes alguna pregunta específica?'
        ].join('\n')
      }

      // Proactive geocoding within campaign fast-path:
      // If customer included their address in this message, geocode it now so the
      // NEXT turn (when they say "domicilio" / give turno) already has zone info.
      const _proactiveMatch = (_isAdCopyPaste || _isDeliveryQuestion)
        ? _fanMsg.match(/(?:a (?:la |mi )?direcci[oó]n|mi direcci[oó]n es|direcci[oó]n:)\s+(.+?)(?=,\s*(?:por favor|podr[ií]|si puede|necesit|gracias)|$)/i)
        : null
      if (_proactiveMatch) {
        const _extractedAddr = _proactiveMatch[1].trim()
        console.log(`[proactive-geocode] Address keyword detected — geocoding: "${_extractedAddr}"`)
        const _zoneResult = await getDeliveryZoneByAddress(_extractedAddr)
        if (_zoneResult && !['GEOMETRIC_CENTER', 'APPROXIMATE'].includes(_zoneResult.locationType)) {
          console.log(`[proactive-geocode] Zone injected: Zone ${_zoneResult.zone} (${_zoneResult.distanceKm}km)`)
          await saveDeliveryAddress(customerPhone, _extractedAddr, _zoneResult.zone, _zoneResult.distanceKm)
            .catch(e => console.warn('saveDeliveryAddress (fanesca fast-path) failed:', e.message))
        } else {
          console.warn(`[proactive-geocode] Low confidence or failed for: "${_extractedAddr}" — saving raw address`)
          await saveRawAddress(customerPhone, _extractedAddr)
            .catch(e => console.warn('saveRawAddress (fanesca fast-path) failed:', e.message))
          await setFlag(customerPhone, 'house_number_pending', true)
          console.log(`[proactive-geocode] houseNumberPending set for ${customerPhone}`)
        }
      }

      await saveMessage(customerPhone, 'user', customerMessage, sessionId)
      await saveMessage(customerPhone, 'assistant', fanescaReply, sessionId)
      return { reply: fanescaReply, needsHandoff: false, needsPaymentHandoff: false }
    }
    // ──────────────────────────────────────────────────────────────────────────

    // Read current cycle from DB — cycle is set manually in Supabase config table
    const currentCycle = await getCurrentCycle()

    // Fetch all data in parallel (history fetched BEFORE saving new message)
    const [config, products, deliveryZones, deliveryTiers, almuerzoDeliveryTiers, weekAlmuerzos, paymentMethods, businessHours, history, storedGeo] = await Promise.all([
      getAllConfig(),
      getProducts(),
      getDeliveryZones(),
      getDeliveryTiers(),
      getAlmuerzoDeliveryTiers(),
      getWeekAlmuerzos(currentCycle),
      getPaymentMethods(),
      getBusinessHours(),
      getHistory(customerPhone, sessionId),   // session-scoped: only current order messages
      getCustomerAddress(customerPhone).catch(() => null)
    ])

    const fullSystemPrompt = buildSystemPrompt(config, products, deliveryZones, deliveryTiers, weekAlmuerzos, paymentMethods, almuerzoDeliveryTiers, businessHours)

    // Build messages array for Claude — ensure alternating roles (no two consecutive same role)
    const rawMessages = history.map(h => ({ role: h.role, content: h.message }))

    // Sanitize: remove consecutive duplicate roles which break Claude's API
    const messages = rawMessages.reduce((acc, msg) => {
      if (acc.length === 0 || acc[acc.length - 1].role !== msg.role) {
        acc.push(msg)
      } else {
        // Merge into previous message to avoid duplicate role error
        acc[acc.length - 1].content += '\n' + msg.content
      }
      return acc
    }, [])

    const lastBotMsg = [...history].reverse().find(h => h.role === 'assistant')

    // ── Shared helper: build orderTypeNote from history ──────────────────────
    const buildOrderTypeNote = () => {
      const orderType = detectOrderTypeFromHistory(history)
      if (orderType === 'almuerzo') {
        const qty = detectAlmuerzoQty(history)
        console.log(`Order type: ALMUERZO (qty=${qty})`)
        return `Tipo de pedido: ALMUERZO PURO (${qty} unidad${qty !== 1 ? 'es' : ''}). Usar tabla TARIFAS ALMUERZOS para calcular envío.`
      } else if (orderType === 'mixed') {
        console.log(`Order type: MIXED`)
        return `Tipo de pedido: MIXTO (almuerzo + carta). Usar tabla CARTA sobre el total combinado.`
      } else {
        console.log(`Order type: CARTA`)
        return `Tipo de pedido: CARTA. Usar tabla CARTA por valor del pedido.`
      }
    }

    const { enrichedMessage } = await resolveDeliveryZone(customerMessage, {
      customerPhone,
      storedGeo,
      lastBotMsg,
      history,
      flags,
      buildOrderTypeNote,
      detectOrderTypeFromHistory,
      detectAlmuerzoQty
    })

    // NOTE: msgTrimmed still needed below for in-person and confirmation detection
    const msgTrimmed = customerMessage.trim()

    // (geocoding branches have been extracted to src/tools/geo.js)

    // Business-hours check — uses DB data (businessHours) fetched above, so the schedule
    // can be changed in Supabase without requiring a redeployment.
    // Must happen BEFORE messages.push() so the after-hours tag lands in the right message.
    const nowEc = nowInEcuador()
    const isRestaurantOpen = checkIsOpen(businessHours, nowEc)

    // Inject stored delivery info so Claude can offer it to the customer without asking from scratch.
    if (storedGeo?.address && !storedGeo?.zone) {
      // Address saved but no zone — it's a landmark/intersection without an exact house number.
      // Claude must ask naturally for JUST the number or building name (not the full address again).
      const shortBase = storedGeo.address.length > 60
        ? storedGeo.address.substring(0, 60) + '…'
        : storedGeo.address
      enrichedMessage += `\n\n[SISTEMA: Este cliente indicó anteriormente la dirección de referencia: "${storedGeo.address}" — pero es una intersección o referencia sin número de casa exacto, por lo que AÚN NO se puede calcular el costo de envío. Cuando llegue el momento de confirmar la dirección de entrega, pide de forma natural el número de casa, nombre del edificio, o su ubicación de Google Maps. Ejemplo: "Para darte el costo de envío exacto, ¿nos podrías dar el número de casa o el nombre del edificio en ${shortBase}? Puedes también compartir tu ubicación de Google Maps 📍🏠" — El cliente puede responder con solo el número (ej. E2-24), con la dirección parcial (Mariana de Jesús E2-24), con la dirección completa, o con un pin/link de Maps. El sistema geocodificará automáticamente cualquier formato.]`
    } else if (storedGeo?.address) {
      // Complete address with zone — offer it back verbatim, and inject zone + cost
      // so Claude never has to guess the delivery price.
      const addrZone = storedGeo.zone || null
      let addrCostInstruction = ''
      if (addrZone === 4 || addrZone === '4') {
        addrCostInstruction = ` ⛔ ZONA 4: si el cliente confirma esta dirección, responde EXACTAMENTE: "¡Claro! Permíteme un momento, estamos verificando el costo de envío para tu sector 🔍 En breve un asesor te confirma los detalles." y luego escribe HANDOFF. NUNCA indiques un precio de envío.`
      } else if (addrZone) {
        const pendingForAddr = await getPendingOrder(customerPhone).catch(() => null)
        const addrCost = await lookupDeliveryCost(addrZone, detectOrderTypeFromHistory(history), pendingForAddr?.total || null, pendingForAddr?.cantidad || null).catch(() => null)
        if (addrCost !== null) {
          addrCostInstruction = ` Zona interna: ${addrZone} (NO mencionar al cliente). El costo de envío exacto según la base de datos es $${addrCost.toFixed(2)} — usa ESTE número exactamente, no calcules por tu cuenta.`
        } else {
          addrCostInstruction = ` Zona interna: ${addrZone} (NO mencionar al cliente). El costo de envío exacto no está disponible aún — usa las tablas de tarifas para zona ${addrZone}.`
        }
      }
      enrichedMessage += `\n\n[SISTEMA: Este cliente tiene una dirección registrada: "${storedGeo.address}".${addrCostInstruction} Al momento de pedir la dirección de entrega, SIEMPRE ofrece primero esta opción preguntando: "¿Enviamos a tu dirección anterior — ${storedGeo.address} — o prefieres indicar una nueva? 📍". Si el cliente confirma, usa EXACTAMENTE esta dirección. Si da una nueva, úsala y descarta la registrada.]`
    } else if (storedGeo?.locationPin) {
      // Customer previously shared a location pin.
      // Use the clean Maps URL stored in last_location_url — always built from real coords,
      // regardless of whether the customer sent a native pin or a Maps URL.
      const pinLabel = storedGeo.locationUrl || 'Ubicación compartida vía WhatsApp'

      // Recover zone if it wasn't stored (e.g. URL had ?g_st=aw when first saved).
      // Re-resolve now so Claude always gets zone info for stored pins.
      let pinZone = storedGeo.zone || null
      if (!pinZone) {
        try {
          // last_location_pin now only stores { lat, lng } — no url field.
          // If coords are present, use them directly.
          let coords = storedGeo.locationPin?.lat != null
            ? { lat: storedGeo.locationPin.lat, lng: storedGeo.locationPin.lng }
            : null
          if (coords) {
            const zoneResult = await getDeliveryZoneByCoordinates(coords.lat, coords.lng)
            if (zoneResult) {
              pinZone = zoneResult.zone
              // Persist the recovered zone so next turn doesn't need to re-resolve
              saveDeliveryZoneOnly(customerPhone, zoneResult.zone, zoneResult.distanceKm).catch(() => {})
              console.log(`[storedPin] Zone recovered: ${pinZone} (${zoneResult.distanceKm}km)`)
            }
          }
        } catch (e) {
          console.warn('[storedPin] Zone recovery failed:', e.message)
        }
      }

      // Build cost instruction: zone 4 → always HANDOFF, other zones → inject real DB cost.
      // Never tell Claude to "cotiza" on its own — it will hallucinate.
      let pinCostInstruction = ''
      if (pinZone === 4 || pinZone === '4') {
        pinCostInstruction = ` ⛔ ZONA 4: si el cliente confirma esta ubicación, responde EXACTAMENTE: "¡Claro! Permíteme un momento, estamos verificando el costo de envío para tu sector 🔍 En breve un asesor te confirma los detalles." y luego escribe HANDOFF. NUNCA indiques un precio de envío.`
      } else if (pinZone) {
        const pendingForPin = await getPendingOrder(customerPhone).catch(() => null)
        const pinCost = await lookupDeliveryCost(pinZone, detectOrderTypeFromHistory(history), pendingForPin?.total || null, pendingForPin?.cantidad || null).catch(() => null)
        if (pinCost !== null) {
          pinCostInstruction = ` Zona interna: ${pinZone} (NO mencionar al cliente). El costo de envío exacto según la base de datos es $${pinCost.toFixed(2)} — usa ESTE número exactamente, no calcules por tu cuenta.`
        } else {
          pinCostInstruction = ` Zona interna: ${pinZone} (NO mencionar al cliente). El costo de envío exacto no está disponible aún — usa las tablas de tarifas para zona ${pinZone}.`
        }
      }

      enrichedMessage += `\n\n[SISTEMA: Este cliente tiene una ubicación guardada de una sesión anterior: "${pinLabel}".${pinCostInstruction} Si el cliente YA mencionó una dirección o sector en este mensaje, usa esa información directamente — NO preguntes por la guardada. Solo ofrece la guardada si el cliente NO ha mencionado ninguna ubicación: "¿Enviamos a tu ubicación guardada — ${pinLabel} — o prefieres indicar una nueva? 📍". Si confirma la guardada: usa el costo indicado arriba y en el resumen escribe "📍 ${pinLabel}". Si da nueva dirección: procesa normalmente.]`
    }

    // Inject [SISTEMA] after-hours tag directly into the user message so Claude sees
    // the constraint inline — more reliable than relying on the distant system-prompt flag.
    if (!isRestaurantOpen) {
      const nowH = nowEc.getHours(), nowM = nowEc.getMinutes()
      const currentTimeStr = `${String(nowH).padStart(2, '0')}:${String(nowM).padStart(2, '0')}`
      const schedule = openDaysLabel(businessHours)
      enrichedMessage += `\n\n[SISTEMA: ⚠️ FUERA DE HORARIO — Son las ${currentTimeStr}. Operamos ${schedule}. PROHIBIDO procesar pedidos con entrega inmediata. SIEMPRE ofrece programar el pedido para el próximo día hábil.]`
      console.log(`After-hours tag injected: ${currentTimeStr}`)
    }

    // Append the fully-enriched user message (zone + after-hours tags applied above)
    messages.push({ role: 'user', content: enrichedMessage })

    // Deterministic override: if the MOST RECENT bot message asked delivery/local
    // and the customer replies with an in-person signal → close immediately.
    //
    // IMPORTANT: only check the LAST assistant message, not any of the last 4.
    // Using .some() on a window of messages caused false positives: when the bot
    // had already moved past the delivery/local question to asking for the address,
    // the old question was still in the window — so an address containing "local"
    // (e.g. "Centro comercial el bosque local 1 planta baja") incorrectly triggered
    // the in-person close. Checking only the last message prevents this entirely.
    //
    // Also dropped the bare includes('local') match — too broad (matches store locales,
    // shopping centres, etc.). Only specific phrases are now used.
    const recentBotMsgs = [...history].slice(-4).filter(h => h.role === 'assistant')
    const lastBotMsgForInPerson = recentBotMsgs[recentBotMsgs.length - 1]
    const hadDeliveryOrLocalQuestion = !!(lastBotMsgForInPerson && (
      lastBotMsgForInPerson.message.includes('entrega a domicilio o consumo en el local') ||
      lastBotMsgForInPerson.message.includes('domicilio o consumo')
    ))
    const msgLowerTrimmed = customerMessage.trim().toLowerCase()
    const isInPersonOrder =
      hadDeliveryOrLocalQuestion && (
        msgLowerTrimmed === 'local' ||                     // exact single-word reply
        /\ben el local\b/.test(msgLowerTrimmed) ||         // "en el local" phrase
        /\bal local\b/.test(msgLowerTrimmed) ||            // "al local"
        msgLowerTrimmed.includes('consumo') ||
        msgLowerTrimmed.includes('ahi voy') ||
        msgLowerTrimmed.includes('ahí voy') ||
        msgLowerTrimmed.includes('voy al local') ||
        msgLowerTrimmed.includes('personalmente') ||
        msgLowerTrimmed.includes('retiro')
      )

    if (isInPersonOrder) {
      console.log('In-person order detected — BYPASSING Claude, closing conversation')
      const inPersonReply = '¡Perfecto! Te estaremos esperando. El pago se realiza directamente en el local. ¡Hasta pronto! 👋'
      await saveMessage(customerPhone, 'user', customerMessage, sessionId)
      await saveMessage(customerPhone, 'assistant', inPersonReply, sessionId)
      // Conversation complete — end session and clear geocoding flags
      await clearFlags(customerPhone)
      endSession(customerPhone).catch(() => {})
      return {
        reply: inPersonReply,
        needsHandoff: false,
        needsPaymentHandoff: false
      }
    }

    // Deterministic override: if the LAST bot message had "Confirmas tu pedido" and customer says yes → bypass Claude and send payment directly.
    // Bug 4 fix: only check the LAST assistant message (not any in the last 8).
    // Checking a wider window caused false positives: after the customer sent a GPS pin
    // that changed the zone, an OLD "Confirmas tu pedido" + old "Si" in history tricked
    // the bot into skipping the updated pricing summary.
    // GUARD: only fire when the restaurant is open. If closed, fall through to Claude so it can
    // redirect to scheduling — the isConfirmation path sends payment info unconditionally, which
    // would let a customer confirm an immediate order even when the restaurant is closed.
    const AFFIRMATIVES = ['si', 'sí', 'confirmo', 'dale', 'ok', 'listo', 'va', 'perfecto', 'claro', 'yes', 'bueno', 'adelante', 'de acuerdo']
    // Bug 4: only check the LAST assistant message, not a wide window
    const lastAssistantMsg = [...history].reverse().find(h => h.role === 'assistant')
    const confirmationMsg = lastAssistantMsg && lastAssistantMsg.message.includes('Confirmas tu pedido') ? lastAssistantMsg : null
    const hadConfirmationPrompt = !!confirmationMsg
    const customerMsgNorm = customerMessage.trim().toLowerCase().replace(/[¡!¿?.,]/g, '').trim()
    const isAffirmative = AFFIRMATIVES.some(a => customerMsgNorm === a || customerMsgNorm.startsWith(a + ' '))
    const isConfirmation = hadConfirmationPrompt && isAffirmative && isRestaurantOpen

    if (isConfirmation) {
      console.log('Order confirmation detected — BYPASSING Claude, sending payment directly')

      // Extract total from the confirmation message.
      // Use \bTOTAL\b so we match "TOTAL:" but NOT "Subtotal:" (word boundary prevents substring match)
      const totalMatch = confirmationMsg.message.match(/\bTOTAL\b[:\s*]+\$?([\d,.]+)/i)
      const totalAmount = totalMatch ? `$${totalMatch[1]}` : '(ver resumen arriba)'

      // Build payment reply directly without calling Claude
      const bankInfo = formatPaymentMethods(paymentMethods)
      const paymentReply = `¡Perfecto! Tu pedido está confirmado 🎉\n\nAquí están los datos para tu transferencia:\n\n${bankInfo}\n\n*Monto a transferir: ${totalAmount}*\n\nUna vez realices la transferencia, envíanos la captura del comprobante para procesar tu pedido. ¡Gracias por confiar en nosotros! 💛`

      await saveMessage(customerPhone, 'user', customerMessage, sessionId)
      await saveMessage(customerPhone, 'assistant', paymentReply, sessionId)

      return {
        reply: paymentReply,
        needsHandoff: false,
        needsPaymentHandoff: false
      }
    }

    // Call Claude
    const response = await client.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 2048,
      system: [
        {
          type: 'text',
          text: fullSystemPrompt,
          cache_control: { type: 'ephemeral' }
        }
      ],
      messages,
      betas: ['prompt-caching-2024-07-31']
    })

    console.log(
      `[tokens] input=${response.usage.input_tokens}` +
      ` output=${response.usage.output_tokens}` +
      ` cache_read=${response.usage.cache_read_input_tokens ?? 0}` +
      ` cache_created=${response.usage.cache_creation_input_tokens ?? 0}`
    )

    console.log('Full Claude response:', JSON.stringify(response, null, 2))

    // Guard against empty content
    if (!response.content || response.content.length === 0 || !response.content[0].text) {
      console.warn('Claude returned empty content. stop_reason:', response.stop_reason)
      // Do NOT save anything to history — keep DB clean
      return {
        reply: 'Lo sentimos, no pude procesar tu mensaje. Por favor intenta de nuevo.',
        needsHandoff: false,
        needsPaymentHandoff: false
      }
    }

    const replyText = response.content[0].text
    console.log('Claude reply:', replyText)

    // Strip <ORDEN> block before saving to history and sending to customer —
    // it is a machine-readable tag, the customer should never see it.
    // Also strip any [SISTEMA:...] blocks that Claude may have echoed back from the enriched
    // user message — these are internal instructions and must never reach the customer.
    const cleanReplyText = replyText
      .replace(/<ORDEN>[\s\S]*?<\/ORDEN>/g, '')
      .replace(/\[SISTEMA:[^\]]*\]/g, '')
      .trim()

    // Save both messages only after Claude succeeds (session-scoped)
    await saveMessage(customerPhone, 'user', customerMessage, sessionId)
    await saveMessage(customerPhone, 'assistant', cleanReplyText, sessionId)

    // ── Persist order snapshot from <ORDEN> JSON block ────────────────────────
    // Claude emits a hidden <ORDEN>{...}</ORDEN> block in every order summary.
    // We parse it as JSON (reliable) instead of regex-scanning free text (fragile).
    // DB fields (address, locationPin, customerName, deliveryCost) are added here
    // from authoritative sources — Claude's JSON only covers conversation data.
    const ordenMatch = replyText.match(/<ORDEN>([\s\S]*?)<\/ORDEN>/)
    if (ordenMatch) {
      try {
        const claudeSnap = JSON.parse(ordenMatch[1].trim())
        // Re-fetch geo FRESH here — storedGeo was read at the START of this turn,
        // before the customer's location/address was saved to DB during this turn.
        // A fresh read captures location pins or addresses saved mid-turn.
        const freshGeo = await getCustomerAddress(customerPhone).catch(() => null)
        // Merge conversation data from Claude with authoritative DB data
        const snap = {
          phone:         customerPhone,
          customerName:  freshGeo?.customerName || customerName || customerPhone,
          // Conversation-specific — from Claude's structured JSON
          total:         claudeSnap.total         ?? null,
          itemsText:     claudeSnap.itemsText      || '',
          orderType:     claudeSnap.orderType      || 'carta',
          cantidad:      claudeSnap.cantidad       ?? null,
          turno:         claudeSnap.turno          || null,
          scheduledDate: claudeSnap.scheduledDate  || null,
          horarioEntrega:claudeSnap.horarioEntrega || null,
          fechaEnvio:    claudeSnap.scheduledDate
                         || new Date().toLocaleDateString('en-CA', { timeZone: 'America/Guayaquil' }),
          // Authoritative DB fields — always from fresh DB read, never from Claude's text
          address:       freshGeo?.address        || null,
          locationPin:   freshGeo?.locationPin    || null,   // { lat, lng } for internal use
          locationUrl:   freshGeo?.locationUrl    || null,   // clean Maps URL → Zoho Ubicacion
          deliveryCost:  null  // filled below — operator cost takes priority over DB lookup
        }
        // Preserve any deliveryCost already set by the human operator via operator-assist.
        // DB lookup is only a fallback — operator price always wins.
        const priorSnap = await getPendingOrder(customerPhone).catch(() => null)
        if (priorSnap?.deliveryCost != null) {
          snap.deliveryCost = priorSnap.deliveryCost
          console.log(`lookupDeliveryCost: using operator-provided cost $${snap.deliveryCost} (skipping DB lookup)`)
        } else if (freshGeo?.zone) {
          const authCost = await lookupDeliveryCost(freshGeo.zone, snap.orderType, snap.total, snap.cantidad).catch(() => null)
          if (authCost !== null) {
            console.log(`lookupDeliveryCost: zone=${freshGeo.zone} type=${snap.orderType} total=${snap.total} qty=${snap.cantidad} → $${authCost}`)
            snap.deliveryCost = authCost
          }
        }
        console.log('Saving pending_order from <ORDEN> JSON:', snap)
        savePendingOrder(customerPhone, snap).catch(err =>
          console.error('savePendingOrder error (non-blocking):', err.message)
        )
      } catch (e) {
        console.error('Failed to parse <ORDEN> JSON — snapshot not saved:', e.message, ordenMatch[1])
      }
    }
    // ──────────────────────────────────────────────────────────────────────────

    // Detect handoff type
    const needsPaymentHandoff = replyText.includes('HANDOFF_PAYMENT')
    const needsHandoff = needsPaymentHandoff || replyText.includes('HANDOFF')

    // ── Zoho: fire on payment handoff (customer sent comprobante) ──────────────
    if (needsPaymentHandoff && process.env.ZOHO_CLIENT_ID) {
      // Read pre-saved order snapshot from DB (written when bot sent the summary).
      // Bug 2+3 fix: NO history-scan fallback. If pending_order is null it means
      // triggerZohoOnPayment() already processed this order (customer sent image first,
      // then typed "Transferencia realizada"). Creating a second Zoho record from
      // history scan produced garbage data (bot sentences as address). Just skip.
      let orderData = await getPendingOrder(customerPhone).catch(() => null)
      if (orderData) {
        console.log('Zoho: using pending_order from DB for', customerPhone, orderData)
      } else {
        console.log('Zoho: no pending_order for', customerPhone, '— order already processed by image handler, skipping Zoho')
      }

      // ── Override with authoritative DB values at send time ───────────────────
      // Conversation-specific fields (total, itemsText, turno, etc.) stay from
      // pending_order. But address, locationPin, customerName, and deliveryCost
      // are always re-fetched fresh from the customers table so Zoho always gets
      // the real stored values, never a snapshot of bot-parsed text.
      if (orderData) {
        const freshGeo = await getCustomerAddress(customerPhone).catch(() => null)
        if (freshGeo) {
          if (freshGeo.address)      orderData.address      = freshGeo.address
          if (freshGeo.locationPin)  orderData.locationPin  = freshGeo.locationPin  // { lat, lng }
          if (freshGeo.locationUrl)  orderData.locationUrl  = freshGeo.locationUrl  // clean Maps URL → Zoho Ubicacion
          if (freshGeo.customerName) orderData.customerName = freshGeo.customerName
          if (freshGeo.campana)      orderData.campana      = freshGeo.campana      // Meta ad campaign
          if (freshGeo.zone && orderData.deliveryCost == null) {
            // Only look up from DB if no deliveryCost was set (operator cost takes priority)
            const authCost = await lookupDeliveryCost(freshGeo.zone, orderData.orderType, orderData.total, orderData.cantidad).catch(() => null)
            if (authCost !== null) {
              console.log(`Zoho: deliveryCost from DB — zone=${freshGeo.zone} → $${authCost}`)
              orderData.deliveryCost = authCost
            }
          } else if (orderData.deliveryCost != null) {
            console.log(`Zoho: keeping operator-provided deliveryCost $${orderData.deliveryCost} (skipping DB lookup)`)
          }
        }
        console.log('Zoho: final orderData before send', orderData)
      }
      // ─────────────────────────────────────────────────────────────────────────

      if (orderData) {
        console.log('Zoho: firing delivery record creation for', customerPhone, orderData)
        createZohoDeliveryRecord(orderData).catch(err =>
          console.error('Zoho delivery record failed (non-blocking):', err.message)
        )
        // Clear the order snapshot so follow-up images don't re-trigger Zoho.
        // Session stays open — it will be closed by closeOrderSession() when the
        // operator sends "📦 Orden Confirmada" to the customer.
        clearFlags(customerPhone).catch(() => {})
        clearPendingOrder(customerPhone).catch(() => {})
      } else {
        console.warn('Zoho: HANDOFF_PAYMENT detected but no order data found — skipping')
      }
    }
    // ──────────────────────────────────────────────────────────────────────────

    // cleanReplyText already has <ORDEN> stripped; also remove HANDOFF tokens.
    // When HANDOFF is present, truncate at the token — discard any text Claude
    // added after it (e.g. "Mientras tanto, te ayudo...") so the customer only
    // sees the scripted message and nothing more.
    let cleanReply = cleanReplyText
    if (needsPaymentHandoff) {
      cleanReply = cleanReply.split('HANDOFF_PAYMENT')[0].trim()
    } else if (needsHandoff) {
      cleanReply = cleanReply.split('HANDOFF')[0].trim()
    }
    cleanReply = cleanReply.replace('HANDOFF_PAYMENT', '').replace('HANDOFF', '').trim()

    return {
      reply: cleanReply,
      needsHandoff,
      needsPaymentHandoff
    }

  } catch (error) {
    console.error('Error processing message:', error)
    return {
      reply: 'Lo sentimos, estamos experimentando problemas técnicos. Por favor intenta de nuevo en un momento.',
      needsHandoff: false,
      needsPaymentHandoff: false
    }
  }
}

/**
 * Called from index.js when a customer sends an image (payment screenshot).
 * Fetches history, finds the order summary, builds the Zoho payload and fires
 * createZohoDeliveryRecord() — fully non-blocking.
 */
async function triggerZohoOnPayment(customerPhone, customerName) {
  if (!process.env.ZOHO_CLIENT_ID) return  // Zoho not configured — skip silently

  try {
    // Only fire if there is an active pending_order in DB.
    // null means the order was already processed (clearPendingOrder already ran) —
    // additional images from the same customer are follow-ups handled by the human admin.
    const orderData = await getPendingOrder(customerPhone).catch(() => null)

    if (!orderData) {
      console.log('Zoho: no pending_order for', customerPhone, '— image is a follow-up, skipping Zoho')
      return
    }

    // Override with authoritative DB values (address, locationUrl, customerName, deliveryCost)
    // so Zoho always gets real stored data — never a stale pending_order snapshot.
    const freshGeo = await getCustomerAddress(customerPhone).catch(() => null)
    if (freshGeo) {
      if (freshGeo.address)      orderData.address      = freshGeo.address
      if (freshGeo.locationPin)  orderData.locationPin  = freshGeo.locationPin
      if (freshGeo.locationUrl)  orderData.locationUrl  = freshGeo.locationUrl
      if (freshGeo.customerName) orderData.customerName = freshGeo.customerName
      if (freshGeo.campana)      orderData.campana      = freshGeo.campana      // Meta ad campaign
      if (freshGeo.zone) {
        const authCost = await lookupDeliveryCost(freshGeo.zone, orderData.orderType, orderData.total, orderData.cantidad).catch(() => null)
        if (authCost !== null) {
          console.log(`triggerZohoOnPayment: deliveryCost from DB — zone=${freshGeo.zone} → $${authCost}`)
          orderData.deliveryCost = authCost
        }
      }
    }

    console.log('Zoho: firing delivery record (payment image received) for', customerPhone, orderData)
    createZohoDeliveryRecord(orderData).catch(err =>
      console.error('Zoho delivery record failed (non-blocking):', err.message)
    )
    // Clear the order snapshot so follow-up images don't re-trigger Zoho.
    // Session stays open — it will be closed by closeOrderSession() when the
    // operator sends "📦 Orden Confirmada" to the customer.
    clearFlags(customerPhone).catch(() => {})
    clearPendingOrder(customerPhone).catch(() => {})
  } catch (err) {
    console.error('Zoho triggerZohoOnPayment error (non-blocking):', err.message)
  }
}

/**
 * Close the active order session for a customer.
 * Called from index.js when the operator sends "📦 Orden Confirmada" to the customer.
 * This is the ONLY place endSession() should be called for delivery orders —
 * not on image receipt, not on HANDOFF_PAYMENT text — only on operator confirmation.
 * Also clears the geocodeClarificationPending flag and resumes the bot so the
 * customer's next message starts a fresh session with an active bot.
 */
async function closeOrderSession(phone) {
  await clearFlags(phone)
  await endSession(phone).catch(e => console.error('[closeOrderSession] endSession error:', e.message))
  console.log(`[closeOrderSession] Session closed for ${phone}`)
}

module.exports = { processMessage, triggerZohoOnPayment, closeOrderSession, hasPendingOrder: (phone) => getPendingOrder(phone).then(Boolean).catch(() => false) }