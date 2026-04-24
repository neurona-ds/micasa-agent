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
  getPendingOrder,
  clearPendingOrder
} = require('../memory')
const { setFlag } = require('../state/flags')

/**
 * Resolves delivery zone from customer message.
 * Handles Maps URLs, text addresses, clarifications, house-number supplements,
 * proactive address detection, and address supplements.
 *
 * @param {string} customerMessage - raw message from customer
 * @param {Object} context - { customerPhone, storedGeo, lastBotMsg, history,
 *                            flags, buildOrderTypeNote, detectOrderTypeFromHistory,
 *                            detectAlmuerzoQty }
 * @returns {{ enrichedMessage: string }}
 */
async function resolveDeliveryZone(customerMessage, context) {
  const {
    customerPhone,
    storedGeo,
    lastBotMsg,
    history,
    flags,
    buildOrderTypeNote,
    detectOrderTypeFromHistory,
    detectAlmuerzoQty
  } = context

  // lastBotAskedAddress: true ONLY when the bot was explicitly ASKING for the customer's address.
  // Strategy: the message must contain a "dirección/ubicación" reference AND a "?" must appear
  // within 120 characters of that reference — indicating a request, not a confirmation.
  // Pure confirmations like "Tengo tu dirección en X 📍" have no "?" near "dirección".
  // The "stored address offer" ("¿enviamos a tu dirección anterior... o prefieres indicar una nueva?")
  // IS an address request and correctly passes the window check because it contains "?".
  const lastBotAskedAddress = lastBotMsg && (() => {
    const m = lastBotMsg.message
    // Must reference address/location at all
    if (!/direcci[oó]n|ubicaci[oó]n/i.test(m)) return false
    // Must NOT be an order summary
    if (
      /¿Confirmas tu pedido\?/i.test(m) ||
      /TOTAL:|Subtotal:|RESUMEN/i.test(m)
    ) return false
    // Purely confirmatory phrases: "Tengo tu dirección en X 📍" — bot just confirmed the address,
    // no question follows. Excluded explicitly. The window check below also catches this
    // (no "?" near "dirección") but the explicit check is a safety net.
    // NOTE: do NOT exclude "Recibí tu ubicación 📍 ¿Podrías..." — that IS an address request.
    if (/tengo tu direcci[oó]n\s+(en|completa:|:)/i.test(m)) return false
    // Must actually be asking a question about the address.
    // Scan a window of 120 chars after (and 60 before) the first dirección/ubicación mention.
    const addrIdx = m.search(/direcci[oó]n|ubicaci[oó]n/i)
    const win = m.substring(Math.max(0, addrIdx - 60), addrIdx + 200)
    return win.includes('?')
  })()

  // Bug 1 fix: detect when the PREVIOUS turn asked for clarification after low-confidence geocode.
  // We use a Supabase-persisted flag (geocode_clarification_pending) set when isLowConfidence fires,
  // rather than parsing Claude's reply text — Claude's wording varies, making keyword checks fragile.
  const lastBotAskedClarification = flags.geocode_clarification_pending === true

  // Detect when the system is waiting for a house number / building name supplement.
  // Primary signal: house_number_pending flag (set in Supabase when proactive geocode returns
  // GEOMETRIC_CENTER) — reliable regardless of Claude's exact phrasing.
  // Secondary signal: keyword match on last bot message (Claude's typical phrasings from
  // the SISTEMA tag template) — catches cases where flag wasn't set (e.g., older sessions).
  const lastBotAskedHouseNumber = flags.house_number_pending === true || !!(lastBotMsg && (
    lastBotMsg.message.includes('número de casa') ||
    lastBotMsg.message.includes('nombre del edificio')
  ))

  // Quick sanity check: is this message plausibly an address?
  // Avoids geocoding short replies, turn-time answers, and conversational sentences.
  const msgTrimmed = customerMessage.trim()
  const looksLikeAddress = (
    msgTrimmed.length >= 15 &&
    msgTrimmed.split(/\s+/).length <= 20 &&  // Ecuadorian addresses can include cross-street + sector refs
    !/^no\b/i.test(msgTrimmed) &&            // "no quiero..." / "no tengo..." → not an address
    !/^(domicilio|delivery|retiro|local|si|sí|no|ok|dale|listo|claro|perfecto|turno|quiero|para)$/i.test(msgTrimmed) &&
    !/^\d{1,2}:\d{2}/.test(msgTrimmed) &&   // "12:30", "1:30 – 2:30"
    !/^turno/i.test(msgTrimmed) &&           // "turno de las..."
    // Spanish conversational verbs / menu-query words that never appear in addresses:
    !/\b(quiero|ustedes|abren|cierran|pueden|puedo|tenemos|tengo|tienen|tienes|tiene|cuándo|cuando|cuánto|cuanto|están|abre|cierra|pronto|dijiste|dices|dijeron|ofrece|ofrecen|venden|vende|incluye|cuesta|vale|muestras|muestra|envías|envía|mandas|manda|imagen|imágenes|foto|fotos|picture|photo)\b/i.test(msgTrimmed) &&
    // "Por favor" followed by a verb = question/request, not an address
    !/^por favor\s+\w*(as?|es?|ís?)\b/i.test(msgTrimmed) &&
    // Billing info exclusions — RUC numbers (13-digit), emails, and "con factura" keyword
    // are dead giveaways that the customer is giving invoice data, not a delivery address.
    !/\b\d{13}\b/.test(msgTrimmed) &&        // Ecuador RUC (13 digits) → billing data
    !/@[\w.-]+\.\w+/.test(msgTrimmed) &&     // email address → billing data
    !/con factura/i.test(msgTrimmed)          // "con factura" prefix → billing request
  )

  const isMapsUrl = /https?:\/\/(maps\.app\.goo\.gl|goo\.gl\/maps|maps\.google\.com|www\.google\.com\/maps)/i.test(customerMessage.trim())

  let enrichedMessage = customerMessage

  // Proactive address detection: detect Spanish address keywords in the message even
  // when the bot didn't explicitly ask for the address (e.g., customer includes address
  // in their first message: "quiero fanescas a la dirección Jorge Juan y Mariana de Jesús").
  // Only evaluated when none of the primary geocoding triggers are active, to avoid overhead.
  const proactiveAddressMatch = (!isMapsUrl && !lastBotAskedAddress && !lastBotAskedClarification && !lastBotAskedHouseNumber)
    ? customerMessage.match(/(?:a (?:la |mi )?direcci[oó]n|mi direcci[oó]n es|direcci[oó]n:)\s+(.+?)(?=,\s*(?:por favor|podr[ií]|si puede|necesit|gracias)|$)/i)
    : null

  // Conversational non-address filter — shared by house-number-reply and supplement branches.
  // Avoids geocoding obvious non-address replies like confirmations, greetings, delivery/pickup
  // selections, and general questions. Must NOT accidentally catch real address supplements.
  const isSimpleConversation = (
    msgTrimmed.length < 2 ||
    // Single-word confirmations / greetings
    /^(si|sí|no|ok|dale|listo|claro|perfecto|espera|momento|después|luego|gracias|entendido|hola|buenas|buenos|genial|excelente|confirmado|confirmo)$/i.test(msgTrimmed) ||
    // Messages starting with conversational verbs or question words
    /^(qué|cómo|cuándo|cuánto|puedes|puedo|quiero|quisiera|necesito|hay|tienes|tengo)\b/i.test(msgTrimmed) ||
    // Delivery/pickup intent words — these are order-type choices, never address supplements
    /^(domicilio|delivery|a domicilio|para llevar|para recoger|retiro|retirar|en el local|pick.?up)\b/i.test(msgTrimmed)
  )

  // Address-supplement detection (narrow fallback): fires when stored address has no zone AND
  // the message looks like a short Ecuadorian number/building. Used as a fallback when
  // lastBotAskedHouseNumber didn't fire (Claude phrased the question differently).
  const storedAddressNoZone = !!(storedGeo?.address && !storedGeo?.zone)
  const looksLikeAddressSupplement = storedAddressNoZone &&
    !isMapsUrl && !lastBotAskedAddress && !lastBotAskedClarification &&
    !lastBotAskedHouseNumber && !proactiveAddressMatch &&
    !isSimpleConversation &&
    msgTrimmed.length >= 2 && msgTrimmed.length <= 60 &&
    msgTrimmed.split(/\s+/).length <= 10 &&
    // Must contain an Ecuadorian street number, building name, floor, unit, or similar
    /[A-Za-z]{1,2}\d{1,3}[-–]\d{1,4}|\bn[°º]?\s*\d+|#\s*\d+|\bedificio\b|\bpiso\s+\d|\bdepto\.?\b|\bdepartamento\b|\bbloque\s+\w|\bcasa\s+\d|\bsuite\s+\w/i.test(msgTrimmed) &&
    !/^\d{1,2}:\d{2}/.test(msgTrimmed)

  if (isMapsUrl) {
    // ── Maps URL: resolve redirect → extract real coords → accurate zone ──
    // Runs regardless of conversation state — zone is always needed for pricing.
    const urlTrimmed = customerMessage.trim()
    console.log(`Maps URL detected — resolving redirect: ${urlTrimmed}`)

    // Step 1: follow the redirect to get actual lat/lng (no API key, no cost)
    const resolvedCoords = await resolveGoogleMapsUrl(urlTrimmed)

    // Step 2: save pin — only if we resolved coords (need lat/lng for clean Maps URL).
    // Writes last_location_pin { lat, lng } + last_location_url (clean Maps URL).
    // If redirect resolution failed we skip — no coords = no reliable location data.
    if (resolvedCoords) {
      saveLocationPin(customerPhone, resolvedCoords.lat, resolvedCoords.lng).catch(err =>
        console.warn('[agent] saveLocationPin (maps url) failed:', err.message)
      )
    }

    // Step 3: calculate zone — use real coords if resolved, else fall back to geocoding URL
    const zoneResult = resolvedCoords
      ? await getDeliveryZoneByCoordinates(resolvedCoords.lat, resolvedCoords.lng)
      : await getDeliveryZoneByAddress(urlTrimmed)

    if (zoneResult) {
      const { zone, distanceKm, formattedAddress } = zoneResult
      saveDeliveryZoneOnly(customerPhone, zone, distanceKm).catch(err =>
        console.warn('saveDeliveryZoneOnly (maps url) failed:', err.message)
      )
      const orderTypeNote = buildOrderTypeNote()

      // Bug 4 Part B: Detect delivery cost change when a location pin/Maps URL
      // changes the zone AFTER an order summary was already shown.
      // If the new zone's delivery cost differs from what's in pending_order,
      // tell Claude to show an updated summary before proceeding to payment.
      let costChangeWarning = ''
      const existingOrder = await getPendingOrder(customerPhone).catch(() => null)
      if (existingOrder && existingOrder.deliveryCost !== null && existingOrder.deliveryCost !== undefined) {
        const newCost = await lookupDeliveryCost(zone, existingOrder.orderType, existingOrder.total, existingOrder.cantidad).catch(() => null)
        if (newCost !== null && newCost !== existingOrder.deliveryCost) {
          console.log(`Bug 4: delivery cost changed! Old=$${existingOrder.deliveryCost} → New=$${newCost} (zone ${zone})`)
          costChangeWarning = ` ⚠️ IMPORTANTE: El costo de envío cambió de $${existingOrder.deliveryCost.toFixed(2)} a $${newCost.toFixed(2)} con esta nueva ubicación. DEBES mostrar un resumen ACTUALIZADO con el nuevo costo de envío y total ANTES de pedir confirmación. NO uses el resumen anterior.`
          // Clear the stale pending_order so a fresh <ORDEN> is generated
          clearPendingOrder(customerPhone).catch(() => {})
        }
      }

      enrichedMessage = `${customerMessage}\n\n[SISTEMA: Ubicación Maps URL → coords (${resolvedCoords?.lat ?? '?'},${resolvedCoords?.lng ?? '?'}) | Distancia: ${distanceKm}km → Zona ${zone}. ${orderTypeNote} NO mencionar zona al cliente. En el resumen del pedido escribe la dirección así: "📍 ${urlTrimmed}"${costChangeWarning}]`
      console.log(`Maps URL zone injected: Zone ${zone} (${distanceKm}km) via ${resolvedCoords ? 'real coords' : 'geocoding fallback'}`)
    } else {
      console.warn(`Maps URL zone calculation failed — Claude will not have zone info`)
    }
  } else if (lastBotAskedAddress && looksLikeAddress) {
    // ── Text address: geocode only when bot asked for it ──────────────────
    console.log(`Address response detected — calling Google Maps for zone`)
    const zoneResult = await getDeliveryZoneByAddress(customerMessage)
    if (zoneResult) {
      const { zone, distanceKm, formattedAddress } = zoneResult
      const orderTypeNote = buildOrderTypeNote()

      // Detect low-confidence geocode using Google's own location_type field:
      // GEOMETRIC_CENTER = centroid of a city/neighbourhood (address not found precisely)
      // APPROXIMATE      = very rough result
      // Both mean the distance is unreliable — don't assign a zone, ask for clarification.
      const isLowConfidence = ['GEOMETRIC_CENTER', 'APPROXIMATE'].includes(zoneResult.locationType)

      if (isLowConfidence) {
        // If we already have a reliable zone from a location pin, use it instead of asking
        // for clarification — the pin gave us precise coordinates, the text address is just
        // the human-readable label. No need to ask again.
        const pinZone = storedGeo?.zone || null
        if (pinZone && pinZone !== 4 && pinZone !== '4') {
          console.log(`Low-confidence geocode but pin zone ${pinZone} already known — using pin zone, saving text as address`)
          const orderType = detectOrderTypeFromHistory(history)
          const qty       = detectAlmuerzoQty(history)
          const authCost  = await lookupDeliveryCost(pinZone, orderType, null, orderType === 'almuerzo' ? qty : null).catch(() => null)
          const costStr   = authCost !== null ? ` El costo de envío exacto es $${authCost.toFixed(2)} — usa ESTE número exactamente.` : ''
          const orderTypeNote = buildOrderTypeNote()
          enrichedMessage = `${customerMessage}\n\n[SISTEMA: Dirección del cliente → "${customerMessage.trim()}" | Zona ${pinZone} confirmada por pin de ubicación previo.${costStr} ${orderTypeNote} NO mencionar zona al cliente. En el resumen del pedido escribe la dirección así: "📍 ${customerMessage.trim()}"]`
          saveDeliveryAddress(customerPhone, customerMessage.trim(), pinZone, zoneResult.distanceKm).catch(err =>
            console.warn('saveDeliveryAddress (pin-fallback) failed:', err.message)
          )
          console.log(`Zone injected (pin fallback): Zone ${pinZone} for text address "${customerMessage.trim()}"`)
        } else {
        console.warn(`Low-confidence geocode: "${customerMessage}" → "${formattedAddress}" — asking for clarification`)
        enrichedMessage = `${customerMessage}\n\n[SISTEMA: La dirección proporcionada no pudo geocodificarse con precisión (resultado: "${formattedAddress}"). No calcules zona todavía. Pide al cliente una referencia más específica: calle principal, intersección o barrio. Ejemplo: "¿Me podrías dar la calle principal o una referencia cercana, como un parque o edificio conocido? 📍"]`
        // Save the raw text so pending_order.address is never null even when geocoding fails
        saveRawAddress(customerPhone, customerMessage.trim()).catch(err =>
          console.warn('saveRawAddress (low-confidence) failed:', err.message)
        )
        // Flag: next message from this customer is a clarification reference → re-geocode it
        await setFlag(customerPhone, 'geocode_clarification_pending', true)
        console.log(`[geocode] Clarification pending set for ${customerPhone}`)
        } // end if pinZone fallback
      } else {
        // Look up the exact delivery cost from the DB so Claude doesn't have to calculate it.
        // This prevents Claude from inventing wrong prices (e.g. $3.50 when DB says $3).
        const orderType = detectOrderTypeFromHistory(history)
        const qty       = detectAlmuerzoQty(history)
        let costInstruction = ''
        if (zone === 4 || zone === '4') {
          costInstruction = ` ⛔ ZONA 4: responde EXACTAMENTE: "¡Claro! Permíteme un momento, estamos verificando el costo de envío para tu sector 🔍 En breve un asesor te confirma los detalles." y luego escribe HANDOFF.`
        } else {
          const authCost = await lookupDeliveryCost(zone, orderType, null, orderType === 'almuerzo' ? qty : null)
            .catch(() => null)
          if (authCost !== null) {
            costInstruction = ` El costo de envío exacto es $${authCost.toFixed(2)} — usa ESTE número exactamente, NO calcules ni estimes otro valor.`
            console.log(`Zone injected with cost: Zone ${zone} → $${authCost}`)
          }
        }
        enrichedMessage = `${customerMessage}\n\n[SISTEMA: Dirección del cliente → "${customerMessage.trim()}" | Distancia: ${distanceKm}km → Zona ${zone}.${costInstruction} ${orderTypeNote} NO mencionar zona al cliente. En el resumen del pedido escribe la dirección así: "📍 ${customerMessage.trim()}"]`
        console.log(`Zone injected: Zone ${zone} (${distanceKm}km)`)
        saveDeliveryAddress(customerPhone, customerMessage.trim(), zone, distanceKm).catch(err =>
          console.warn('saveDeliveryAddress failed (non-blocking):', err.message)
        )
      }
    } else {
      console.warn(`Zone calculation failed — Claude will estimate from address text`)
      // Save the raw text so pending_order.address is never null even when geocoding completely fails
      saveRawAddress(customerPhone, customerMessage.trim()).catch(err =>
        console.warn('saveRawAddress (geocode-failure) failed:', err.message)
      )
    }
  } else if (lastBotAskedClarification && msgTrimmed.length >= 10) {
    // ── Re-geocode reference message after low-confidence clarification ──
    // Customer gave a reference like "Cercano a Los Pinos y Galo Plaza Lasso" after
    // the bot asked for a more specific address. Try geocoding this reference text.
    // Clear the flag regardless of outcome — don't loop indefinitely
    await setFlag(customerPhone, 'geocode_clarification_pending', false)

    // Guard: skip re-geocode if the message is clearly a confirmation or non-address reply.
    // "Confirmo pedido", "Sí confirmo", "Dale", "Ok" etc. must NOT be geocoded.
    const isNonAddressReply = isSimpleConversation ||
      /^(confirmo|si confirmo|sí confirmo|confirmar|confirmado|confirma)/i.test(msgTrimmed) ||
      /\b(pedido|orden|mi pedido|mi orden)\b/i.test(msgTrimmed) ||
      /\b(imagen|foto|fotos|picture|photo)\b/i.test(msgTrimmed) ||
      /\b(quiero|tienes|tiene|puedo|pueden|cuánto|cuanto|cuándo|cuando)\b/i.test(msgTrimmed) ||
      // Time/delivery questions — "en qué tiempo", "cuánto demora", "cuándo llega", etc.
      /\b(tiempo|demora|tarda|llega|llegará|minutos|horas|rápido|rapido)\b/i.test(msgTrimmed) ||
      // Messages starting with "Si" as "if/yes" followed by a question word or verb
      /^si\s+(en|cuándo|cuando|hay|tienen|puedo|puede)\b/i.test(msgTrimmed) ||
      // Generic question starters that clearly are not addresses
      /^(en qué|en que|por qué|por que|cómo|como es|qué tan|que tan)\b/i.test(msgTrimmed)

    if (isNonAddressReply) {
      console.log(`Clarification flag was set but message looks like non-address reply — skipping geocode: "${customerMessage}"`)
      // Fall through to Claude normally
    } else {

    console.log(`Clarification reference detected — re-geocoding: "${customerMessage}"`)
    // (flag already cleared above)

    const zoneResult = await getDeliveryZoneByAddress(customerMessage)

    if (zoneResult) {
      const isStillLowConfidence = ['GEOMETRIC_CENTER', 'APPROXIMATE'].includes(zoneResult.locationType)

      if (!isStillLowConfidence) {
        // Good geocode — inject zone + exact cost
        const { zone, distanceKm, formattedAddress } = zoneResult
        const orderTypeNote = buildOrderTypeNote()
        const orderType2 = detectOrderTypeFromHistory(history)
        const qty2       = detectAlmuerzoQty(history)
        let clarCostInstruction = ''
        if (zone === 4 || zone === '4') {
          clarCostInstruction = ` ⛔ ZONA 4: responde EXACTAMENTE: "¡Claro! Permíteme un momento, estamos verificando el costo de envío para tu sector 🔍 En breve un asesor te confirma los detalles." y luego escribe HANDOFF.`
        } else {
          const clarCost = await lookupDeliveryCost(zone, orderType2, null, orderType2 === 'almuerzo' ? qty2 : null)
            .catch(() => null)
          if (clarCost !== null) {
            clarCostInstruction = ` El costo de envío exacto es $${clarCost.toFixed(2)} — usa ESTE número exactamente.`
          }
        }
        enrichedMessage = `${customerMessage}\n\n[SISTEMA: Referencia del cliente → "${customerMessage.trim()}" | Distancia: ${distanceKm}km → Zona ${zone}.${clarCostInstruction} ${orderTypeNote} NO mencionar zona al cliente. En el resumen del pedido escribe la dirección así: "📍 ${customerMessage.trim()}"]`
        console.log(`Clarification zone injected: Zone ${zone} (${distanceKm}km)`)
        saveDeliveryAddress(customerPhone, customerMessage.trim(), zone, distanceKm).catch(err =>
          console.warn('saveDeliveryAddress (clarification) failed:', err.message)
        )
      } else {
        // Still low confidence — save raw address, tell Claude to NOT include delivery cost
        console.warn(`Clarification re-geocode still low confidence: "${customerMessage}" → "${zoneResult.formattedAddress}"`)
        saveRawAddress(customerPhone, customerMessage.trim()).catch(err =>
          console.warn('saveRawAddress (clarification-low) failed:', err.message)
        )
        enrichedMessage = `${customerMessage}\n\n[SISTEMA: ⚠️ ZONA NO CONFIRMADA — La referencia del cliente tampoco pudo geocodificarse con precisión. NUNCA incluyas costo de envío en el resumen. Indica al cliente que un administrador confirmará el costo de envío. Usa HANDOFF para que un humano resuelva la zona y el precio de envío.]`
      }
    } else {
      // Geocoding completely failed — save raw, inject NO-ZONE
      console.warn(`Clarification geocode failed entirely for: "${customerMessage}"`)
      saveRawAddress(customerPhone, customerMessage.trim()).catch(err =>
        console.warn('saveRawAddress (clarification-fail) failed:', err.message)
      )
      enrichedMessage = `${customerMessage}\n\n[SISTEMA: ⚠️ ZONA NO CONFIRMADA — No se pudo determinar la ubicación del cliente. NUNCA incluyas costo de envío en el resumen. Indica al cliente que un administrador confirmará el costo de envío. Usa HANDOFF para que un humano resuelva la zona y el precio de envío.]`
    }
    } // end else (not isNonAddressReply)
  } else if (lastBotAskedHouseNumber && storedAddressNoZone && !isSimpleConversation) {
    // ── House-number reply: bot asked for number/building, handle ALL reply forms ──────
    // Customer may reply with:
    //   (a) Just the number:      "E2-24"
    //   (b) Partial/remaining:    "Mariana de Jesús E2-24"
    //   (c) Full new address:     "Mariana de Jesús E2-24 y 6 de Diciembre, La Gasca"
    //   (d) Maps URL:             handled by isMapsUrl branch above
    //
    // Strategy: for bare house-number codes (a), skip direct geocode — Google returns
    //           RANGE_INTERPOLATED for short codes like "E2-24" but maps them to a
    //           completely different street → always unreliable without context.
    //           For partial/full addresses (b/c), try direct geocode first.
    //           Falls back to combined with stored base if direct is low-conf or null.
    //           If both low-confidence → save best combined raw without discarding base.
    //           If both null → keep existing stored address untouched.

    console.log(`[house-number-reply] Geocoding response: "${customerMessage.trim()}"`)

    // Bare house-number codes: single token that looks like "E2-24", "N24-15", "#12", "n°3"
    // These geocode unreliably in isolation → skip direct, go straight to combined.
    const isPureHouseNumber = (
      msgTrimmed.split(/\s+/).length === 1 &&
      (
        /^[A-Za-z]{0,2}\d{1,3}[-–]\d{1,4}$/.test(msgTrimmed) ||          // E2-24, OE6-12
        /^n[°º]?\s*\d+[-–]?\d*$/i.test(msgTrimmed) ||                     // n°24, N24
        /^#\s*\d+[A-Za-z]?$/.test(msgTrimmed)                              // #24, #24B
      )
    )

    const directResult = isPureHouseNumber
      ? null   // skip direct geocode for bare codes — combine with base instead
      : await getDeliveryZoneByAddress(customerMessage).catch(() => null)
    if (isPureHouseNumber) {
      console.log(`[house-number-reply] Pure house-number code detected — skipping direct geocode, combining with base`)
    }
    const isDirectHighConf = directResult &&
      !['GEOMETRIC_CENTER', 'APPROXIMATE'].includes(directResult.locationType)

    if (isDirectHighConf) {
      // Customer gave a complete, geocodeable address directly
      const { zone, distanceKm, formattedAddress } = directResult
      const orderTypeNote = buildOrderTypeNote()
      const fullAddressDirect = `${storedGeo.address}, ${customerMessage.trim()}`
      enrichedMessage = `${customerMessage}\n\n[SISTEMA: Dirección completada por el cliente → "${fullAddressDirect}" | Distancia: ${distanceKm}km → Zona ${zone}. ${orderTypeNote} NO mencionar zona al cliente. En el resumen del pedido usa "📍 ${fullAddressDirect}".]`
      console.log(`[house-number-reply] Direct geocode succeeded: Zone ${zone} (${distanceKm}km) — "${formattedAddress}"`)
      await setFlag(customerPhone, 'house_number_pending', false)  // resolved — clear flag
      saveDeliveryAddress(customerPhone, fullAddressDirect, zone, distanceKm).catch(err =>
        console.warn('saveDeliveryAddress (house-number direct) failed:', err.message)
      )
    } else {
      // Direct geocode low-conf or null → combine with stored base address
      const combinedAddress = `${storedGeo.address}, ${customerMessage.trim()}`
      console.log(`[house-number-reply] Direct low-conf/null — trying combined: "${combinedAddress}"`)
      const combinedResult = await getDeliveryZoneByAddress(combinedAddress).catch(() => null)
      const isCombinedHighConf = combinedResult &&
        !['GEOMETRIC_CENTER', 'APPROXIMATE'].includes(combinedResult.locationType)

      if (isCombinedHighConf) {
        const { zone, distanceKm, formattedAddress } = combinedResult
        const orderTypeNote = buildOrderTypeNote()
        enrichedMessage = `${customerMessage}\n\n[SISTEMA: Dirección completada → "${combinedAddress}" | Distancia: ${distanceKm}km → Zona ${zone}. ${orderTypeNote} NO mencionar zona al cliente. En el resumen del pedido usa "📍 ${combinedAddress}".]`
        console.log(`[house-number-reply] Combined geocode succeeded: Zone ${zone} (${distanceKm}km) — "${formattedAddress}"`)
        await setFlag(customerPhone, 'house_number_pending', false)  // resolved — clear flag
        saveDeliveryAddress(customerPhone, combinedAddress, zone, distanceKm).catch(err =>
          console.warn('saveDeliveryAddress (house-number combined) failed:', err.message)
        )
      } else if (combinedResult) {
        // Both returned GEOMETRIC_CENTER — save combined raw; better than losing the supplement
        console.warn(`[house-number-reply] Both geocodes low-conf — saving combined raw: "${combinedAddress}"`)
        saveRawAddress(customerPhone, combinedAddress).catch(err =>
          console.warn('saveRawAddress (house-number both-low) failed:', err.message)
        )
      }
      // If both null → don't overwrite the existing stored address; keep what we have
    }
  } else if (proactiveAddressMatch) {
    // ── Proactive geocoding: address keyword detected in unprompted message ──────────
    // Customer included their address before bot asked (e.g., "quiero fanescas a la
    // dirección Jorge Juan y Mariana de Jesús"). Geocode it now so zone is available
    // for pricing without an extra round-trip.
    const extractedAddress = proactiveAddressMatch[1].trim()
    console.log(`[proactive-geocode] Address keyword detected — geocoding: "${extractedAddress}"`)
    const zoneResult = await getDeliveryZoneByAddress(extractedAddress)

    if (zoneResult) {
      const isLowConfidence = ['GEOMETRIC_CENTER', 'APPROXIMATE'].includes(zoneResult.locationType)

      if (!isLowConfidence) {
        const { zone, distanceKm, formattedAddress } = zoneResult
        const orderTypeNote = buildOrderTypeNote()
        enrichedMessage = `${customerMessage}\n\n[SISTEMA: Dirección detectada en el mensaje → "${extractedAddress}" | Distancia: ${distanceKm}km → Zona ${zone}. ${orderTypeNote} NO mencionar zona al cliente. En el resumen del pedido escribe la dirección así: "📍 ${extractedAddress}"]`
        console.log(`[proactive-geocode] Zone injected: Zone ${zone} (${distanceKm}km)`)
        saveDeliveryAddress(customerPhone, extractedAddress, zone, distanceKm).catch(err =>
          console.warn('saveDeliveryAddress (proactive) failed:', err.message)
        )
      } else {
        // Low confidence — save raw address and flag that we need a supplement
        console.warn(`[proactive-geocode] Low confidence: "${extractedAddress}" → "${zoneResult.formattedAddress}" — saving raw address`)
        saveRawAddress(customerPhone, extractedAddress).catch(err =>
          console.warn('saveRawAddress (proactive-low) failed:', err.message)
        )
        await setFlag(customerPhone, 'house_number_pending', true)
        console.log(`[proactive-geocode] houseNumberPending set for ${customerPhone}`)
      }
    } else {
      // Geocoding failed — save raw address and flag for supplement
      console.warn(`[proactive-geocode] Geocoding failed for: "${extractedAddress}" — saving raw address`)
      saveRawAddress(customerPhone, extractedAddress).catch(err =>
        console.warn('saveRawAddress (proactive-fail) failed:', err.message)
      )
      await setFlag(customerPhone, 'house_number_pending', true)
      console.log(`[proactive-geocode] houseNumberPending set for ${customerPhone}`)
    }
  } else if (looksLikeAddressSupplement) {
    // ── Address supplement: customer provided house number / building name ──────────
    // The stored address is a landmark/intersection that returned GEOMETRIC_CENTER.
    // Combine stored base + this supplement and re-geocode for an exact zone.
    const combinedAddress = `${storedGeo.address}, ${customerMessage.trim()}`
    console.log(`[address-supplement] Re-geocoding combined: "${combinedAddress}"`)
    const zoneResult = await getDeliveryZoneByAddress(combinedAddress)

    if (zoneResult) {
      const isLowConfidence = ['GEOMETRIC_CENTER', 'APPROXIMATE'].includes(zoneResult.locationType)

      if (!isLowConfidence) {
        const { zone, distanceKm, formattedAddress } = zoneResult
        const orderTypeNote = buildOrderTypeNote()
        enrichedMessage = `${customerMessage}\n\n[SISTEMA: El cliente completó la dirección → "${combinedAddress}" | Distancia: ${distanceKm}km → Zona ${zone}. ${orderTypeNote} NO mencionar zona al cliente. En el resumen del pedido usa "📍 ${combinedAddress}".]`
        console.log(`[address-supplement] Zone injected: Zone ${zone} (${distanceKm}km) — "${formattedAddress}"`)
        saveDeliveryAddress(customerPhone, combinedAddress, zone, distanceKm).catch(err =>
          console.warn('saveDeliveryAddress (supplement) failed:', err.message)
        )
      } else {
        // Still low confidence — save the combined string as raw; Claude will work from it
        console.warn(`[address-supplement] Still low confidence for combined: "${combinedAddress}"`)
        saveRawAddress(customerPhone, combinedAddress).catch(err =>
          console.warn('saveRawAddress (supplement-low) failed:', err.message)
        )
      }
    } else {
      console.warn(`[address-supplement] Geocoding failed for: "${combinedAddress}"`)
      saveRawAddress(customerPhone, combinedAddress).catch(err =>
        console.warn('saveRawAddress (supplement-fail) failed:', err.message)
      )
    }
  }

  // ── Bug 1 safety net: NO-ZONE injection when no enrichment happened ──────
  // If after all geocoding branches the message was never enriched AND there's
  // an active delivery context AND no zone in DB → inject explicit warning so
  // Claude never invents a delivery cost.
  if (enrichedMessage === customerMessage && !isMapsUrl) {
    // Check if there's an active delivery order context (pending_order exists or
    // recent conversation mentions delivery) but no zone in DB
    const pendingOrder = await getPendingOrder(customerPhone).catch(() => null)
    if (pendingOrder && !storedGeo?.zone) {
      enrichedMessage += `\n\n[SISTEMA: ⚠️ ZONA NO CONFIRMADA — Este pedido es a domicilio pero NO hay zona de envío confirmada en el sistema. NUNCA incluyas costo de envío en el resumen del pedido. Si necesitas mostrar un resumen, indica que el costo de envío será confirmado por un administrador.]`
      console.log('NO-ZONE safety net injected — pending order exists but no zone in DB')
    }
  }

  return { enrichedMessage }
}

module.exports = { resolveDeliveryZone }
