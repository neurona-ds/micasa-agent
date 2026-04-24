'use strict'

// Detect whether the current order is pure almuerzo, pure carta, or mixed.
// Only scans USER messages — bot messages contain "Jugo Natural", "Postre", etc.
// as part of almuerzo descriptions, which would otherwise trigger false MIXED hits.
function detectOrderTypeFromHistory(history) {
  // User messages: look for explicit order signals
  const recentUserMsgs = history.filter(h => h.role === 'user').slice(-10)
  const userText = recentUserMsgs.map(h => h.message.toLowerCase()).join(' ')

  // Bot order-summary lines only (contain × or x) — e.g. "2 × Almuerzo del día"
  const recentBotMsgs = history.filter(h => h.role === 'assistant').slice(-6)
  const botSummaryText = recentBotMsgs
    .filter(m => m.message.includes('×') || m.message.includes(' x '))
    .map(m => m.message.toLowerCase()).join(' ')

  const combined = userText + ' ' + botSummaryText

  const almuerzoSignals = ['almuerzo', 'menú del día', 'menu del dia', 'menú de hoy', 'menu de hoy', 'plan semanal', 'plan mensual']
  // Carta signals: product names that would NEVER appear in an almuerzo description
  const cartaSignals = [
    'churrasco', 'pollo bbq', 'pollo al grill', 'tilapia', 'chuleta', 'seco de',
    'parrillada', 'ají de carne', 'loco de', 'fanesca', 'sopa de quinoa', 'congelado', 'arroz con'
  ]
  // Beverages only count as carta when the USER explicitly requests them
  const beverageSignals = ['batido', 'jugo natural']

  const hasAlmuerzo = almuerzoSignals.some(s => combined.includes(s))
  const hasCarta = cartaSignals.some(s => combined.includes(s)) ||
                   beverageSignals.some(s => userText.includes(s))

  if (hasAlmuerzo && hasCarta) return 'mixed'
  if (hasAlmuerzo) return 'almuerzo'
  return 'carta'
}

// Try to extract the number of almuerzos from conversation history
function detectAlmuerzoQty(history) {
  let qty = 1 // default: assume 1 if not explicitly mentioned
  const recentUserMsgs = history.filter(h => h.role === 'user').slice(-10)
  for (const msg of recentUserMsgs) {
    const match = msg.message.match(/(\d+)\s*almuerzo/i)
    if (match) qty = Math.max(qty, parseInt(match[1]))
  }
  // Also check bot order summaries (e.g. "2 × Almuerzo del día")
  const recentBotMsgs = history.filter(h => h.role === 'assistant').slice(-6)
  for (const msg of recentBotMsgs) {
    const match = msg.message.match(/(\d+)\s*[xX×]\s*almuerzo/i)
    if (match) qty = Math.max(qty, parseInt(match[1]))
  }
  return qty
}

// ─── Zoho order-data extraction helpers ───────────────────────────────────────

/**
 * Parse a Spanish date string like "lunes 2 de marzo" or "2 de marzo de 2026"
 * into a YYYY-MM-DD string. Returns null if parsing fails.
 * Used to convert "📅 Entrega programada: lunes 2 de marzo" into Zoho's Fecha_de_Envio.
 */
function parseScheduledDate(dateStr) {
  const MONTHS = {
    enero:1, febrero:2, marzo:3, abril:4, mayo:5, junio:6,
    julio:7, agosto:8, septiembre:9, octubre:10, noviembre:11, diciembre:12,
    // abbreviated forms
    ene:1, feb:2, mar:3, abr:4, may:5, jun:6,
    jul:7, ago:8, sep:9, oct:10, nov:11, dic:12
  }

  const nowEc    = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Guayaquil' }))
  const nowYear  = nowEc.getFullYear()
  const nowMonth = nowEc.getMonth() + 1

  // Primary: "D de Mes" or "D de Mes de YYYY"
  const matchFull = dateStr.match(/(\d{1,2})\s+de\s+([a-záéíóúüñ]+)(?:\s+de\s+(\d{4}))?/i)
  if (matchFull) {
    const day   = parseInt(matchFull[1])
    const month = MONTHS[matchFull[2].toLowerCase()]
    if (month) {
      const year = matchFull[3]
        ? parseInt(matchFull[3])
        : (month < nowMonth ? nowYear + 1 : nowYear)
      return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
    }
  }

  // Fallback: "D Mes" or "D Mes YYYY" without "de" (e.g. "27 feb", "viernes 27 feb 2026")
  const matchShort = dateStr.match(/(\d{1,2})\s+([a-záéíóúüñ]{3,})(?:\s+(\d{4}))?/i)
  if (matchShort) {
    const day   = parseInt(matchShort[1])
    const month = MONTHS[matchShort[2].toLowerCase()]
    if (month) {
      const year = matchShort[3]
        ? parseInt(matchShort[3])
        : (month < nowMonth ? nowYear + 1 : nowYear)
      return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
    }
  }

  return null
}

/**
 * Scan history backwards for the user message that came right after the bot
 * asked for "dirección completa 📍" — that's the raw customer address.
 */
function extractAddressFromHistory(history) {
  for (let i = 0; i < history.length - 1; i++) {
    const msg = history[i]
    if (
      msg.role === 'assistant' &&
      msg.message.includes('dirección completa') &&
      msg.message.includes('📍')
    ) {
      const nextUser = history.slice(i + 1).find(m => m.role === 'user')
      if (nextUser) return nextUser.message.trim()
    }
  }
  return null
}

/**
 * Scan recent history for a turno/hora mention.
 * Matches "Turno: 12:30" (almuerzo slots) or "Hora: 12:00" (carta scheduled orders).
 */
function extractTurnoFromHistory(history) {
  const recent = history.slice(-14)
  for (const msg of [...recent].reverse()) {
    const match = msg.message.match(/[Tt]urno[:\s]+([^\n,|]+)/i)
      || msg.message.match(/[Hh]ora[:\s]+([^\n,|]+)/i)
    if (match) return match[1].trim()
    // bare time like "12:30" mentioned alongside turno context
    const timeMatch = msg.message.match(/\b(12:30|1:30|2:30|13:30|14:30)\b/)
    if (timeMatch && msg.message.toLowerCase().includes('turno')) return timeMatch[1]
  }
  return null
}

/**
 * Build the orderData payload for Zoho from the order-summary message
 * (the assistant message that contained "Confirmas tu pedido") plus history.
 *
 * @param {Object} summaryMsg  - history entry: { role:'assistant', message:'...' }
 * @param {Array}  history     - full conversation history
 * @param {string} phone       - customer WhatsApp phone
 * @param {string} name        - customer name from WATI
 * @returns {Object} orderData ready for createZohoDeliveryRecord()
 */
// storedAddress: typed text address saved to DB — most reliable for Direccion field.
// storedLocationPin: raw pin object {url} or {lat,lng} — goes to Ubicacion field in Zoho.
function extractOrderDataForZoho(summaryMsg, history, phone, name, storedAddress = null, storedLocationPin = null) {
  // Strip bold/italic markdown from the raw message before all parsing so that
  // patterns like "📅 **Entrega programada:**" match the same regex as plain text.
  const text = summaryMsg.message.replace(/\*+/g, '')

  // Total — use word boundary to avoid matching "Subtotal"
  const totalMatch = text.match(/\bTOTAL\b[:\s]+\$?([\d,.]+)/i)
  const total = totalMatch ? parseFloat(totalMatch[1].replace(',', '.')) : null

  // Delivery cost — take the LAST occurrence of "Envío: $X.XX" or "Envío: GRATIS" (→ 0)
  const deliveryMatches = [...text.matchAll(/Envío[:\s]+\$?([\d,.]+)/gi)]
  const isGratis = /Envío[:\s]+GRATIS/i.test(text)
  const deliveryCost = deliveryMatches.length > 0
    ? parseFloat(deliveryMatches[deliveryMatches.length - 1][1].replace(',', '.'))
    : (isGratis ? 0 : null)

  // Address — 3-layer fallback (most → least reliable):
  //   1. storedAddress: geocoded by Google Maps, saved to customers table at query time
  //   2. 📍 line in the order summary message (bot instructed to always include it)
  //   3. History scan: find user reply after bot asked "dirección completa 📍" (fragile, last resort)
  const addrInMsg = text.match(/📍\s*([^\n]+)/)
  const address = storedAddress
    || (addrInMsg ? addrInMsg[1].trim() : null)
    || extractAddressFromHistory(history)

  // Turno/Hora: look in the summary message first.
  // Almuerzos use "Turno: 12:30" (slot notation); carta orders use "Hora: 12:00" (exact time).
  // Both are extracted the same way — zoho.js decides how to use the value based on orderType.
  const turnoInMsg = text.match(/[Tt]urno[:\s]+([^\n,|]+)/i)
    || text.match(/[Hh]ora[:\s]+([^\n,|]+)/i)
  const turno = turnoInMsg
    ? turnoInMsg[1].trim()
    : extractTurnoFromHistory(history)

  // Scheduled delivery date — present only for future-scheduled orders.
  // Bot writes: "📅 Entrega programada: lunes 2 de marzo | Turno: 3:00 PM"
  // (markdown already stripped above so **bold** wrappers don't break the regex)
  // Also scan recent history in case the scheduled line is in a different message.
  let scheduledDate = null
  const scheduledInMsg = text.match(/📅\s*Entrega programada:\s*([^|\n]+)/i)
  if (scheduledInMsg) {
    scheduledDate = parseScheduledDate(scheduledInMsg[1].trim())
  }
  if (!scheduledDate) {
    // Fallback 1: scan last 14 messages for the programada line (strip markdown there too)
    const recentMsgs = history.slice(-14)
    for (const msg of [...recentMsgs].reverse()) {
      const msgText = msg.message.replace(/\*+/g, '')
      const m = msgText.match(/📅\s*Entrega programada:\s*([^|\n]+)/i)
      if (m) { scheduledDate = parseScheduledDate(m[1].trim()); break }
    }
  }

  if (!scheduledDate) {
    // Fallback 2: extract date embedded in item name (e.g. "Almuerzo del día viernes 27 feb")
    // Scan summary + recent history for "del día [weekday] D [Mes]" or "para el [weekday] D [Mes]"
    const allText = [text, ...history.slice(-14).map(m => m.message.replace(/\*+/g, ''))].join('\n')
    const embeddedDate = allText.match(
      /(?:del\s+d[ií]a|para\s+el)\s+(?:\w+\s+)?(\d{1,2})\s+(?:de\s+)?([a-záéíóúüñ]{3,})(?:\s+(?:de\s+)?(\d{4}))?/i
    )
    if (embeddedDate) {
      const raw = embeddedDate[3]
        ? `${embeddedDate[1]} ${embeddedDate[2]} ${embeddedDate[3]}`
        : `${embeddedDate[1]} ${embeddedDate[2]}`
      scheduledDate = parseScheduledDate(raw)
    }
  }

  // Items: lines that represent order rows — clean and kitchen-ready for Notas_de_Cocina.
  // Bot formats items as:
  //   "1 × Churrasco de Pollo: $8.50"          (carta, × format)
  //   "- 1 Almuerzo del día (...): $5.50"       (almuerzo, dash-number format)
  //   "🥩 Churrasco de Carne — $9.00"           (emoji + em-dash format)
  // Exclude delivery/subtotal/total lines; markdown already stripped above.
  const itemLines = text.split('\n')
    .filter(l => {
      if (/envío|subtotal|\bTOTAL\b/i.test(l)) return false
      return (
        l.includes('×') ||
        /\d\s*x\s+/i.test(l) ||
        /^\s*[-•]\s*\d+\s+/i.test(l) ||
        /[–—]\s*\$[\d.]+/.test(l)        // em-dash / en-dash price format
      )
    })
    .map(l =>
      l
        .replace(/^\s*[-•]\s*/, '')                                                  // strip leading dash or bullet
        .replace(/^(?:[\u{1F000}-\u{1FFFF}]|[\u{2600}-\u{27BF}])+\s*/u, '- ')      // replace leading emoji with dash
        .trim()
    )
    .filter(Boolean)

  const itemsText = itemLines.join('\n')

  // Cantidad — for almuerzo orders (word "almuerzo" OR "Menú del Día").
  // Extract quantity from the × notation or leading number.
  // e.g. "4 × Menú del Día Lunes" → 4, "1 Almuerzo del día..." → 1
  let cantidad = null
  if (/almuerzo|men[uú]\s+del\s+d[ií]a/i.test(itemsText)) {
    const cantMatch = itemsText.match(/(\d+)\s*[xX×]\s*(?:almuerzo|men[uú])/i)
      || itemsText.match(/^[-•]?\s*(\d+)\s+(?:almuerzo|men[uú])/im)
    cantidad = cantMatch ? parseInt(cantMatch[1]) : 1
  }

  // Order type: drives Horario_de_Entrega logic.
  // Almuerzo orders have "almuerzo" or "Menú del Día" in the items block;
  // everything else (fanesca, churrasco, carta items) is 'carta'.
  const orderType = /almuerzo|men[uú]\s+del\s+d[ií]a/i.test(itemsText) ? 'almuerzo' : 'carta'

  // ── Pre-compute Zoho field values at order summary time ─────────────────────
  // Frozen here so pending_order is the single source of truth.
  // zoho.js reads these directly — no re-computation at payment time.

  // Horario_de_Entrega: almuerzo → slot mapping, carta → raw time or 'Inmediato'.
  // Logic mirrors mapTurnoToPickList() in zoho.js (duplicated intentionally so
  // agent.js stays self-contained and the value is frozen in the DB snapshot).
  let horarioEntrega
  if (orderType === 'almuerzo') {
    if (!turno)                                   horarioEntrega = 'Inmediato'
    else if (/12[:\s]?30/.test(turno))            horarioEntrega = '12:30 a 1:30'
    else if (/1[:\s]?30|13[:\s]?30/.test(turno)) horarioEntrega = '1:30 a 2:30'
    else if (/2[:\s]?30|14[:\s]?30/.test(turno)) horarioEntrega = '2:30 a 3:30'
    else                                           horarioEntrega = 'Inmediato'
  } else {
    // Carta: customer-stated time (e.g. '9:30') or 'Inmediato' if none given
    horarioEntrega = turno || 'Inmediato'
  }

  // Fecha_de_Envio: freeze delivery date NOW (Ecuador timezone) so zoho.js
  // gets the correct date even if payment arrives after midnight.
  // Future-scheduled orders use scheduledDate; same-day orders use today.
  const fechaEnvio = scheduledDate
    || new Date().toLocaleDateString('en-CA', { timeZone: 'America/Guayaquil' })
  // ────────────────────────────────────────────────────────────────────────────

  return {
    phone,
    customerName:   name || phone,
    total,
    deliveryCost,
    address,
    locationPin:    storedLocationPin || null,  // raw pin {url} or {lat,lng} → Zoho Ubicacion
    turno,
    itemsText,
    scheduledDate,    // YYYY-MM-DD or null (kept for reference)
    cantidad,         // number or null (null = non-almuerzo order)
    orderType,        // 'almuerzo' | 'carta'
    horarioEntrega,   // pre-computed Zoho Horario_de_Entrega pick-list value
    fechaEnvio        // pre-computed YYYY-MM-DD delivery date (frozen at order time)
  }
}

module.exports = {
  detectOrderTypeFromHistory,
  detectAlmuerzoQty,
  parseScheduledDate,
  extractAddressFromHistory,
  extractTurnoFromHistory,
  extractOrderDataForZoho
}
