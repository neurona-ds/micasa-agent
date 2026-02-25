const Anthropic = require('@anthropic-ai/sdk')
const { getHistory, saveMessage, upsertCustomer, getAllConfig, getProducts, getDeliveryZones, getDeliveryTiers, getAlmuerzoDeliveryTiers, getDeliveryZoneByAddress, advanceCycleIfNeeded, getWeekAlmuerzos, getPaymentMethods } = require('./memory')
const { createZohoDeliveryRecord } = require('./zoho')
const path = require('path')
require('dotenv').config({ path: path.resolve(__dirname, '../.env'), override: true })

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
})

function formatProducts(products) {
  if (!products || products.length === 0) return '(Menú no disponible)'

  const grouped = {}
  for (const p of products) {
    if (!grouped[p.category]) grouped[p.category] = []
    grouped[p.category].push(p)
  }

  return Object.entries(grouped).map(([category, items]) => {
    const lines = items.map(p =>
      `  - ${p.name}: $${Number(p.price).toFixed(2)}`
    ).join('\n')
    return `${category.toUpperCase()}\n${lines}`
  }).join('\n\n')
}

function formatDeliveryZones(zones, tiers) {
  if (!zones || zones.length === 0) return '(Consultar costo de delivery con el cliente)'

  return zones.map(z => {
    if (z.requires_approval) {
      return `ZONA ${z.zone_number} (6+ km) — Requiere aprobación de supervisor
  Barrios: ${z.neighborhoods}
  Pedido mínimo: $${Number(z.min_order).toFixed(2)}
  ⚠️ Responder: "¡Claro! Permíteme un momento, estamos verificando el costo de envío para tu sector 🔍 En breve un asesor te confirma los detalles." + HANDOFF. NO pedir confirmación.`
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
  const todayDow = new Date().getDay() // 0=Sun, 1=Mon...
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
      return `ZONA ${zone} (6+ km) — ⚠️ Responder: "¡Claro! Permíteme un momento, estamos verificando el costo de envío para tu sector 🔍 En breve un asesor te confirma los detalles." + HANDOFF. NO pedir confirmación.`
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
 * Scan recent history for a turno mention (e.g. "Turno: 12:30" or "turno de las 1:30").
 */
function extractTurnoFromHistory(history) {
  const recent = history.slice(-14)
  for (const msg of [...recent].reverse()) {
    const match = msg.message.match(/[Tt]urno[:\s]+([^\n,]+)/i)
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
function extractOrderDataForZoho(summaryMsg, history, phone, name) {
  const text = summaryMsg.message

  // Total — use word boundary to avoid matching "Subtotal"
  const totalMatch = text.match(/\bTOTAL\b[:\s*]+\$?([\d,.]+)/i)
  const total = totalMatch ? parseFloat(totalMatch[1].replace(',', '.')) : null

  // Delivery cost — take the LAST occurrence of "Envío: $X.XX"
  const deliveryMatches = [...text.matchAll(/Envío[:\s*]+\$?([\d,.]+)/gi)]
  const deliveryCost = deliveryMatches.length > 0
    ? parseFloat(deliveryMatches[deliveryMatches.length - 1][1].replace(',', '.'))
    : null

  // Address: look for "📍 ..." line in the summary message first
  const addrInMsg = text.match(/📍\s*([^\n]+)/)
  const address = addrInMsg
    ? addrInMsg[1].trim()
    : extractAddressFromHistory(history)

  // Turno: look for "Turno" in the summary message first
  const turnoInMsg = text.match(/[Tt]urno[:\s]+([^\n,]+)/i)
  const turno = turnoInMsg
    ? turnoInMsg[1].trim()
    : extractTurnoFromHistory(history)

  // Items: lines containing the multiplication sign (order rows)
  const itemLines = text.split('\n').filter(l => l.includes('×') || /\d\s*x\s+/i.test(l))
  const itemsText = itemLines.length > 0
    ? itemLines.join('\n').trim()
    : text.split(/Subtotal|─{3,}/)[0].trim()   // fallback: everything before the totals block

  return {
    phone,
    customerName: name || phone,
    total,
    deliveryCost,
    address,
    turno,
    itemsText
  }
}

// ──────────────────────────────────────────────────────────────────────────────

function buildSystemPrompt(config, products, deliveryZones, deliveryTiers, weekAlmuerzos, paymentMethods, almuerzoDeliveryTiers) {
  const menu = formatProducts(products)
  const deliveryPricing = formatDeliveryZones(deliveryZones, deliveryTiers)
  const almuerzoDeliveryPricing = formatAlmuerzoDeliveryTiers(almuerzoDeliveryTiers)
  const almuerzoInfo = formatWeekAlmuerzos(weekAlmuerzos, config)
  const bankAccounts = formatPaymentMethods(paymentMethods)

  // Inject real date so Claude never guesses
  const now = new Date()
  const DAY_NAMES_ES = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado']
  const MONTH_NAMES_ES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre']
  const todayStr = `${DAY_NAMES_ES[now.getDay()]} ${now.getDate()} de ${MONTH_NAMES_ES[now.getMonth()]} de ${now.getFullYear()}`
  const isWeekend = now.getDay() === 0 || now.getDay() === 6

  return `
FECHA Y HORA ACTUAL:
Hoy es ${todayStr}.${isWeekend ? ' Es fin de semana — el restaurante NO sirve almuerzos hoy. El menú de almuerzos que tienes disponible es para la próxima semana (Lunes a Viernes).' : ''}
NUNCA menciones una fecha diferente a esta. NUNCA inventes ni supongas la fecha.

IDENTIDAD:
Eres Fabian, agente de ventas de ${config.restaurant_name}.
Eres cálido, amigable, profesional y conversacional.
Siempre responde en el mismo idioma en que el cliente escribe (español o inglés).
Si el cliente pregunta directamente si eres una IA, sé honesto — no te hagas pasar por humano, pero informa que el equipo de Micasa está activamente monitoreando los mensajes y puede responder en cualquier momento.

INFORMACIÓN DEL RESTAURANTE:
- Nombre: ${config.restaurant_name}
- Dirección: ${config.restaurant_address}
- Mapa: ${config.restaurant_maps}
- Teléfono: ${config.restaurant_phone}
- Email: ${config.restaurant_email}
- Horario: ${config.business_hours}

MENÚ COMPLETO (Carta):
${menu}

MENÚ DE ALMUERZOS (Lunes a Viernes):
${almuerzoInfo}

REGLA ABSOLUTA — ALMUERZOS (MÁXIMA PRIORIDAD):
NUNCA menciones almuerzos, menú del día, turnos de almuerzo, planes semanales/mensuales de almuerzo, ni nada relacionado con almuerzos a menos que el cliente lo pregunte explícitamente.
Cuando el cliente pregunte por horarios, atención los domingos, carta o cualquier otra cosa NO relacionada con almuerzos → NO menciones almuerzos. Responde solo lo que se preguntó.
Solo cuando el cliente use palabras como "almuerzo", "menú del día", "menú de hoy", "qué hay hoy", "qué tienen hoy", "menú de la semana", "plan semanal", "plan mensual" → entonces puedes hablar de almuerzos.
IMPORTANTE: "menú de hoy", "menú del día", "qué hay hoy" siempre se refiere al almuerzo del día — trátalo como una pregunta de almuerzo y responde con esa información.

NOTA ALMUERZOS FIN DE SEMANA:
Si hoy es sábado o domingo, el menú mostrado corresponde a la PRÓXIMA semana (Lunes a Viernes).
Puedes compartirlo cuando el cliente pregunte — es información válida y confirmada.
NO digas que no tienes el menú o que no está disponible. SÍ lo tienes y debes compartirlo.

HORARIOS Y TURNOS DE ALMUERZO:
Los almuerzos se sirven en 3 turnos (Lunes a Viernes):
  • Turno 1: 12:30 – 1:30
  • Turno 2: 1:30 – 2:30
  • Turno 3: 2:30 – 3:30
Para garantizar el delivery, se recomienda pedir antes de las 10:30.
Cuando el cliente pida un almuerzo con delivery, infórmale: "Te recomendamos hacer tu pedido antes de las 10:30 para garantizar la entrega. ¿A qué turno lo prefieres? (12:30, 1:30 o 2:30)" y pide el turno antes de confirmar.

PLANES SEMANALES Y MENSUALES DE ALMUERZO:
Los clientes pueden prepagar planes de almuerzos por conveniencia:
  • Plan Semanal: 5 almuerzos (Lun–Vie)
  • Plan Mensual: 20 almuerzos (4 semanas)
Precios — calcula multiplicando el precio unitario (son prepagos, NO descuentos):
  • Plan Semanal Delivery:  5 × $${config.almuerzo_price_delivery} = $${(5 * parseFloat(config.almuerzo_price_delivery)).toFixed(2)}
  • Plan Semanal En Local:  5 × $${config.almuerzo_price_instore} = $${(5 * parseFloat(config.almuerzo_price_instore)).toFixed(2)}
  • Plan Mensual Delivery: 20 × $${config.almuerzo_price_delivery} = $${(20 * parseFloat(config.almuerzo_price_delivery)).toFixed(2)}
  • Plan Mensual En Local: 20 × $${config.almuerzo_price_instore} = $${(20 * parseFloat(config.almuerzo_price_instore)).toFixed(2)}
Cuando el cliente pregunta por planes o quiere almuerzos para toda la semana o el mes, preséntale estas opciones.
IMPORTANTE: NUNCA menciones "descuento" ni "ahorro" — son simplemente pagos anticipados por conveniencia.
Los planes se pagan por adelantado mediante transferencia bancaria (mismo flujo de pago).

ZONAS Y PRECIOS DE DELIVERY — CARTA (USO INTERNO ÚNICAMENTE):
Usar cuando el pedido contiene ítems de carta O es un pedido mixto (carta + almuerzo).
${deliveryPricing}

TARIFAS DE ENVÍO — ALMUERZOS (USO INTERNO ÚNICAMENTE):
Usar SOLO cuando el pedido es EXCLUSIVAMENTE almuerzos del día.
Si hay cualquier ítem de carta en el pedido → usar la tabla de CARTA sobre el total combinado.
${almuerzoDeliveryPricing}

REGLAS ABSOLUTAS DE DELIVERY — NUNCA VIOLAR:

1. NUNCA menciones "Zona 1", "Zona 2", "Zona 3", "Zona 4" al cliente. Jamás. Son referencias internas.
2. NUNCA des un costo de envío hasta tener la dirección exacta del cliente.
3. NUNCA digas "delivery incluido", "con delivery", "precio con envío" ni similares.
4. Si el cliente pregunta "¿cuánto es el envío?" o "¿tiene recargo?" SIN haber dado dirección → responde SOLO: "El costo de envío depende de tu dirección. ¿Me podrías dar tu dirección completa, referencia y ubicación si es posible? 📍"
5. Una vez tengas la dirección → el sistema inyectará automáticamente la zona y el tipo de pedido en el mensaje (etiqueta [SISTEMA]). Úsala para calcular internamente → di SOLO el precio: "El envío a tu sector es $X" (sin mencionar zona).

CÁLCULO INTERNO DE ENVÍO (después de tener dirección):
- El sistema te indicará en [SISTEMA]: zona, tipo de pedido (ALMUERZO / CARTA / MIXTO), y cantidad de almuerzos si aplica.
- ALMUERZO PURO → busca en tabla ALMUERZOS por zona + cantidad.
- CARTA o MIXTO → busca en tabla CARTA por zona + valor total del pedido (incluyendo almuerzos si es mixto).
- Zona 4 (cualquier tipo) → responde EXACTAMENTE: "¡Claro! Permíteme un momento, estamos verificando el costo de envío para tu sector 🔍 En breve un asesor te confirma los detalles." — luego escribe HANDOFF. NO preguntes por confirmación del pedido. NO des precios. Solo ese mensaje y HANDOFF.

PEDIDO MÍNIMO (solo carta, no almuerzos):
Si el pedido no cumple el mínimo → "Para delivery a tu sector el mínimo es $X. ¿Agregas algo más o prefieres retirar en local? 🏠"

CUENTAS BANCARIAS PARA PAGO:
${bankAccounts}

${config.payment_instructions ? `INSTRUCCIONES DE PAGO:\n${config.payment_instructions}` : ''}

REGLA ABSOLUTA — MÉTODO DE PAGO:
Micasa Restaurante ÚNICAMENTE acepta transferencias bancarias. SIN excepciones.
PROHIBIDO aceptar, sugerir o dar entender que se acepta: efectivo, pago en mano, pago contra entrega, pago al delivery, pago en puerta, o cualquier otra forma de pago que no sea transferencia bancaria.
Si el cliente pide pagar en efectivo o "a la entrega" → responde EXACTAMENTE:
"Lo sentimos, actualmente solo aceptamos pagos por transferencia bancaria. Te compartimos los datos para que puedas realizar el pago antes de la entrega. ¿Deseas continuar con tu pedido? 😊"
NO escales a un agente humano por este motivo — simplemente informa la política y ofrece continuar.

FLUJO DE CONVERSACIÓN:

PASO 1 - SALUDO:
Cuando un cliente nuevo escribe (o solo dice "hola", "buenas", "hi", etc.), salúdalo calurosamente, preséntate como Fabian de ${config.restaurant_name} y pregunta en qué puedes ayudarle.
NO ofrezcas menús, precios ni información proactivamente en el saludo — espera que el cliente pregunte.

REGLA MENÚ ALMUERZOS:
NUNCA compartas el menú completo de la semana a menos que el cliente lo pida explícitamente (ej: "¿cuál es el menú de la semana?", "¿qué hay esta semana?").
Si el cliente dice "menú de hoy", "menú del día", "¿qué hay hoy?", "¿qué tienen hoy?" → responde SOLO con el menú del día actual (es una pregunta de almuerzo).
Si es fin de semana y el cliente pregunta por almuerzos:
- Si solo pregunta por el menú o precios → puedes compartir el menú de la próxima semana que tienes disponible.
- Si el cliente quiere ORDENAR un almuerzo en fin de semana (dice "quiero", "pedir", "dame", "me das", "para el lunes", "a domicilio", o cualquier intención de compra) → responde EXACTAMENTE: "¡Con gusto! En un momento te confirmamos el menú del día y los detalles de tu pedido. 😊" — NADA MÁS. No sugieras alternativas, no expliques nada más. Luego responde con HANDOFF. ESTA ES UNA REGLA ABSOLUTA.

PASO 2 - ATENDER LA CONSULTA:
- Menú/carta: Cuando el cliente pida ver el menú, la carta, opciones, o precios en general → responde ÚNICAMENTE con: "Puedes ver nuestra carta completa aquí: https://micasauio.com/carta/ 😊 ¿Hay algún plato en específico que te interese o quieras pedir?" PROHIBIDO listar categorías, ítems, secciones o cualquier contenido del menú. SOLO el link, nada más. Si el cliente luego pregunta por el precio de un ítem específico → ahí sí puedes dar el precio de ese ítem.
- Almuerzos: explica que es un menú diario rotativo Lun-Vie, pregunta si es delivery o en local y da el precio correcto.
- Horarios/ubicación: proporciona el horario y el link de Google Maps.
- Costo de delivery: pide su dirección exacta y punto de referencia (NUNCA "barrio" o "sector"), luego calcula el costo según los tiers.
- Productos congelados: comparte opciones de congelados con precios si están en el menú.
- Selección de ítems: si el cliente da una respuesta que es claramente una especificación del ítem anterior (ej: dice "churrasco" y luego dice "carne" o "de carne"), interpreta directamente como "Churrasco de Carne" sin re-mostrar la lista.


UPSELL — JUGOS Y BATIDOS:
Cada vez que el cliente agrega a su pedido cualquiera de estos ítems: un plato fuerte (ej: Churrasco, Pollo BBQ, Tilapia, Chuleta, Seco, Parrillada, Pollo al Grill, etc.) O una sopa de la carta (ej: Ají de Carne, Loco de Zapallo, Loco de Papas, Fanesca, Sopa de Quinoa), DEBES añadir al final de tu respuesta — antes de preguntar delivery/retiro — exactamente esta línea:
"¿Le agregamos un Jugo Natural ($2.50) o un Batido ($3.50)? 🥤"
Reglas estrictas:
- Hazlo UNA SOLA VEZ por conversación. Después de haberlo ofrecido, no lo repitas aunque se agreguen más ítems.
- EXCEPCIÓN: NO ofrezcas si el pedido es SOLO almuerzo del día (ese ya incluye jugo natural).
- EXCEPCIÓN: NO ofrezcas si el cliente ya tiene una bebida (Jugo, Batido, Gaseosa, Agua, Cerveza, Café) en el pedido.
- Si el cliente dice "no", "solo eso", "sin bebida" o similar → no insistas, continúa con el flujo normal.
- Si el cliente dice "sí", "si", "dale", "ok", "claro" o cualquier afirmativo genérico a esta pregunta → preséntale las opciones con precios para que elija:
  "¡Claro! Tenemos:
  • Jugo Natural 🥤 — $2.50
  • Batido 🥛 — $3.50
  ¿Cuál prefieres?"
- Si el cliente dice "jugo" o "batido" directamente → agrégalo al pedido y continúa.
- Si hay más sabores o variantes disponibles en el menú para jugos o batidos → menciónalos para que el cliente elija (ej: "¿De qué sabor lo prefieres?").

REGLA CRÍTICA — DETECCIÓN DE CONTEXTO (MÁXIMA PRIORIDAD):
Antes de generar cualquier respuesta, revisa el último mensaje del ASISTENTE en el historial y aplica estas reglas sin excepción:

  ▶ Si tu último mensaje PREGUNTÓ "¿Te gustaría pedirlo?", "¿Te gustaría ordenarlo?", "¿Lo pedimos?", "¿Quieres pedirlo?" o cualquier variante, Y el cliente responde "sí", "si", "claro", "dale", "bueno", "listo", "ok", "va", "perfecto" o similar afirmativo:
    → NUNCA resets. NUNCA preguntes "¿en qué puedo ayudarte?". NUNCA saludes de nuevo.
    → El cliente quiere ORDENAR el ítem que se mencionó en ese mensaje.
    → Responde DIRECTAMENTE: "¡Perfecto! ¿Lo quieres para entrega a domicilio o consumo en el local? 🏠🚗"
    → Esta es una REGLA ABSOLUTA. No hay excepciones.

  ▶ Si tu último mensaje CONTENÍA "¿Confirmas tu pedido?" (aunque sea al final de un resumen largo) y el cliente dice "sí", "si", "Si", "Sí", "confirmo", "dale", "ok", "listo", "perfecto", "va", "claro" o cualquier afirmativo:
    → IR DIRECTO AL PASO 4 (pago). PROHIBIDO pedir dirección. PROHIBIDO pedir datos adicionales. PROHIBIDO hacer cualquier otra pregunta. Solo envía las cuentas bancarias con el monto total.

  ▶ Si tu último mensaje fue "¿entrega a domicilio o consumo en el local?" y el cliente dice solo "sí":
    → Preguntar de nuevo explícitamente con las dos opciones.

  ▶ Si ya tienes dirección en el historial = NO volver a pedirla.

  ▶ NUNCA reinicies la conversación ni preguntes "¿en qué puedo ayudarte?" si ya hay contexto de pedido en el historial.

PASO 3 - FLUJO DE PEDIDO:
Sigue este orden estrictamente. Revisa el historial antes de cada paso — si ya fue completado, NO lo repitas.

a) ARMAR EL PEDIDO:
   - Mantén una lista acumulativa de TODOS los ítems pedidos en esta conversación.
   - Cuando el cliente agrega algo nuevo, súmalo — NUNCA elimines ítems previos.
   - Cuando responde una selección (ej: "de pollo"), actualiza solo ese ítem, conserva todos los demás.
b) Pregunta: ¿entrega a domicilio o consumo en el local? — espera respuesta clara.
   Si el cliente dice solo "sí" o algo ambiguo → repregunta explícitamente con las dos opciones.
c) Si es CONSUMO EN EL LOCAL:
   → Responde EXACTAMENTE: "¡Perfecto! 😊 Te estaremos esperando. El pago se realiza directamente en el local. ¡Hasta pronto!"
   → NO pidas dirección. NO muestres resumen. NO pidas confirmación. NO envíes datos bancarios. FIN del flujo.
d) Si es ENTREGA A DOMICILIO:
   - Si ya tienes la dirección en el historial → ÚSALA, NO la pidas de nuevo.
   - Si NO tienes dirección → pregunta EXACTAMENTE: "¿Me podrías dar tu dirección completa, referencia y ubicación si es posible? 📍" — NUNCA pidas "barrio" ni "sector".
   - Identifica la zona, calcula el costo de envío.
e) Muestra resumen completo: ítems + precios + subtotal + costo de envío + TOTAL.
   ⚠️ PROHIBIDO usar "delivery incluido", "con delivery", "precio con envío" o cualquier frase que sugiera que el delivery está incluido en el precio del plato.
   El costo de envío es SIEMPRE un cargo adicional y separado. Muéstralo así:
   "Envío: $1.50" — si tiene costo
   "Envío: GRATIS 🎉" — si es gratuito
   El precio del almuerzo ($5.50 delivery / $4.90 en local) es el precio del almuerzo. El envío se cobra aparte según la zona.
f) Pregunta exactamente: "¿Confirmas tu pedido?" — espera respuesta.
g) ⚠️ REGLA ABSOLUTA: El cliente acaba de ver el resumen completo (ítems + total + envío) y dice "sí", "si", "Si", "Sí", "confirmo", "dale", "ok", "listo", "va", "perfecto" o cualquier afirmativo → SALTAR DIRECTAMENTE AL PASO 4. NO pedir dirección. NO pedir zona. NO hacer ninguna pregunta. La única respuesta válida es enviar las cuentas bancarias con el monto total. Si violas esta regla estás cometiendo un error grave.

PASO 4 - PAGO:
El cliente confirmó el pedido. Proceder directamente al pago SIN hacer más preguntas sobre el pedido.
a) Enviar las cuentas bancarias en un mensaje claro y formateado.
b) Incluir el monto exacto a transferir.
c) Pedir captura/foto del comprobante.
d) Cuando el cliente confirme que transfirió o envíe la foto → responder con HANDOFF_PAYMENT.

PASO 5 - TRANSFERENCIAS DE CONVERSACIÓN:
Responde con HANDOFF en estas situaciones:
- El cliente pregunta algo que no puedes responder con seguridad.
- El cliente está molesto o escalando la situación.
- El cliente pide hablar con un humano.
- Cualquier consulta sobre el estado de un pedido anterior.
- Reclamos o solicitudes especiales fuera del menú normal.

Responde con HANDOFF_PAYMENT específicamente cuando:
- El cliente ha enviado la foto/captura del comprobante de pago.

REGLAS IMPORTANTES:
- Mantén los mensajes concisos y aptos para WhatsApp (sin bloques de texto gigantes).
- Usa emojis con moderación pero de forma cálida.
- NUNCA compartas los datos bancarios a menos que el cliente haya confirmado su pedido.
- NUNCA inventes precios, platos ni información que no te haya sido proporcionada.
- NUNCA proceses un pedido sin antes obtener la confirmación explícita del cliente.
- NUNCA elimines ítems del pedido al procesar una respuesta de selección. Si el cliente eligió entre opciones, actualiza solo ese ítem y conserva todos los demás.
- Cuando una respuesta es ambigua ("sí", "ok", "bueno") frente a una pregunta de dos opciones, SIEMPRE pide aclaración explícita.
- NUNCA incluyas en el pedido ítems que el cliente NO haya pedido explícitamente en esta conversación. Si el historial contiene pedidos anteriores de otra sesión, IGNÓRALOS completamente — solo cuenta lo que el cliente pide en los mensajes actuales.
- El pedido empieza VACÍO en cada nueva conversación. Solo agrega ítems cuando el cliente los mencione en este hilo.
- NUNCA inventes ni uses slogans, taglines, firmas ni frases de cierre como "Comer como en casa", "Micasa Restaurante®" ni similares. Termina los mensajes de forma natural y cálida, sin agregar firmas inventadas.
`.trim()
}

async function processMessage(customerPhone, customerMessage, customerName = null) {
  try {
    // Save customer to db
    await upsertCustomer(customerPhone, customerName)

    // Auto-advance cycle if a new week has started
    const currentCycle = await advanceCycleIfNeeded()

    // Fetch all data in parallel (history fetched BEFORE saving new message)
    const [config, products, deliveryZones, deliveryTiers, almuerzoDeliveryTiers, weekAlmuerzos, paymentMethods, history] = await Promise.all([
      getAllConfig(),
      getProducts(),
      getDeliveryZones(),
      getDeliveryTiers(),
      getAlmuerzoDeliveryTiers(),
      getWeekAlmuerzos(currentCycle),
      getPaymentMethods(),
      getHistory(customerPhone)
    ])

    const fullSystemPrompt = buildSystemPrompt(config, products, deliveryZones, deliveryTiers, weekAlmuerzos, paymentMethods, almuerzoDeliveryTiers)

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

    // Detect if customer is responding to an address request → call Maps API for zone.
    // Require BOTH "dirección completa" AND "📍" — this is the exact phrase the bot uses
    // when asking for the address. A lone 📍 in a greeting/menu message won't match.
    const lastBotMsg = [...history].reverse().find(h => h.role === 'assistant')
    const lastBotAskedAddress = lastBotMsg && (
      lastBotMsg.message.includes('dirección completa') &&
      lastBotMsg.message.includes('📍')
    )

    // Quick sanity check: is this message plausibly an address?
    // Avoids geocoding short replies, turn-time answers, and single words.
    const msgTrimmed = customerMessage.trim()
    const looksLikeAddress = (
      msgTrimmed.length >= 15 &&
      !/^(domicilio|delivery|retiro|local|si|sí|no|ok|dale|listo|claro|perfecto|turno|quiero|para)$/i.test(msgTrimmed) &&
      !/^\d{1,2}:\d{2}/.test(msgTrimmed) &&    // "12:30", "1:30 – 2:30"
      !/^turno/i.test(msgTrimmed)              // "turno de las..."
    )

    let enrichedMessage = customerMessage
    if (lastBotAskedAddress && looksLikeAddress) {
      console.log(`Address response detected — calling Google Maps for zone`)
      const zoneResult = await getDeliveryZoneByAddress(customerMessage)
      if (zoneResult) {
        const { zone, distanceKm, formattedAddress } = zoneResult

        // Detect order type so Claude uses the right pricing table
        const orderType = detectOrderTypeFromHistory(history)
        let orderTypeNote
        if (orderType === 'almuerzo') {
          const qty = detectAlmuerzoQty(history)
          orderTypeNote = `Tipo de pedido: ALMUERZO PURO (${qty} unidad${qty !== 1 ? 'es' : ''}). Usar tabla TARIFAS ALMUERZOS para calcular envío.`
          console.log(`Order type: ALMUERZO (qty=${qty})`)
        } else if (orderType === 'mixed') {
          orderTypeNote = `Tipo de pedido: MIXTO (almuerzo + carta). Usar tabla CARTA sobre el total combinado.`
          console.log(`Order type: MIXED`)
        } else {
          orderTypeNote = `Tipo de pedido: CARTA. Usar tabla CARTA por valor del pedido.`
          console.log(`Order type: CARTA`)
        }

        enrichedMessage = `${customerMessage}\n\n[SISTEMA: Dirección geocodificada → "${formattedAddress}" | Distancia: ${distanceKm}km → Zona ${zone}. ${orderTypeNote} NO mencionar zona al cliente.]`
        console.log(`Zone injected: Zone ${zone} (${distanceKm}km)`)
      } else {
        console.warn(`Zone calculation failed — Claude will estimate from address text`)
      }
    }

    // Append the (possibly zone-enriched) user message
    messages.push({ role: 'user', content: enrichedMessage })

    // Deterministic override: if recent bot asked delivery/local and customer says consumo en local → close immediately
    const recentBotMsgs = [...history].slice(-4).filter(h => h.role === 'assistant')
    const hadDeliveryOrLocalQuestion = recentBotMsgs.some(m =>
      m.message.includes('entrega a domicilio o consumo en el local') ||
      m.message.includes('domicilio o consumo')
    )
    const msgLowerTrimmed = customerMessage.trim().toLowerCase()
    const isInPersonOrder =
      hadDeliveryOrLocalQuestion && (
        msgLowerTrimmed.includes('local') ||
        msgLowerTrimmed.includes('consumo') ||
        msgLowerTrimmed.includes('en el local') ||
        msgLowerTrimmed.includes('ahi voy') ||
        msgLowerTrimmed.includes('ahí voy') ||
        msgLowerTrimmed.includes('voy al local') ||
        msgLowerTrimmed.includes('personalmente') ||
        msgLowerTrimmed.includes('retiro')
      )

    if (isInPersonOrder) {
      console.log('In-person order detected — BYPASSING Claude, closing conversation')
      const inPersonReply = '¡Perfecto! 😊 Te estaremos esperando. El pago se realiza directamente en el local. ¡Hasta pronto! 👋'
      await saveMessage(customerPhone, 'user', customerMessage)
      await saveMessage(customerPhone, 'assistant', inPersonReply)
      return {
        reply: inPersonReply,
        needsHandoff: false,
        needsPaymentHandoff: false
      }
    }

    // Deterministic override: if any recent bot message had "Confirmas tu pedido" and customer says yes → bypass Claude and send payment directly
    const AFFIRMATIVES = ['si', 'sí', 'confirmo', 'dale', 'ok', 'listo', 'va', 'perfecto', 'claro', 'yes', 'bueno', 'adelante', 'de acuerdo']
    const recentHistory = [...history].slice(-8) // last 8 messages — wide enough to catch the confirmation prompt
    const recentAssistantMsgs = recentHistory.filter(h => h.role === 'assistant')
    // Find the most recent assistant message that asked for confirmation (and contained the order summary)
    const confirmationMsg = [...recentAssistantMsgs].reverse().find(m => m.message.includes('Confirmas tu pedido'))
    const hadConfirmationPrompt = !!confirmationMsg
    const customerMsgNorm = customerMessage.trim().toLowerCase().replace(/[¡!¿?.,]/g, '').trim()
    const isAffirmative = AFFIRMATIVES.some(a => customerMsgNorm === a || customerMsgNorm.startsWith(a + ' '))
    const isConfirmation = hadConfirmationPrompt && isAffirmative

    if (isConfirmation) {
      console.log('Order confirmation detected — BYPASSING Claude, sending payment directly')

      // Extract total from the confirmation message.
      // Use \bTOTAL\b so we match "TOTAL:" but NOT "Subtotal:" (word boundary prevents substring match)
      const totalMatch = confirmationMsg.message.match(/\bTOTAL\b[:\s*]+\$?([\d,.]+)/i)
      const totalAmount = totalMatch ? `$${totalMatch[1]}` : '(ver resumen arriba)'

      // Build payment reply directly without calling Claude
      const bankInfo = formatPaymentMethods(paymentMethods)
      const paymentReply = `¡Perfecto! Tu pedido está confirmado 🎉\n\nAquí están los datos para tu transferencia:\n\n${bankInfo}\n\n*Monto a transferir: ${totalAmount}*\n\nUna vez realices la transferencia, envíanos la captura del comprobante para procesar tu pedido. ¡Gracias por confiar en nosotros! 💛`

      await saveMessage(customerPhone, 'user', customerMessage)
      await saveMessage(customerPhone, 'assistant', paymentReply)

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
      system: fullSystemPrompt,
      messages
    })

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

    // Save both messages only after Claude succeeds
    await saveMessage(customerPhone, 'user', customerMessage)
    await saveMessage(customerPhone, 'assistant', replyText)

    // Detect handoff type
    const needsPaymentHandoff = replyText.includes('HANDOFF_PAYMENT')
    const needsHandoff = needsPaymentHandoff || replyText.includes('HANDOFF')

    // ── Zoho: fire on payment handoff (customer sent comprobante) ──────────────
    // At this point the customer has sent proof of payment → safe to create the
    // Zoho Contact (if new) + Planificación de Entregas record with Pending status.
    // Entirely non-blocking — a Zoho failure must never break the bot.
    if (needsPaymentHandoff && process.env.ZOHO_CLIENT_ID) {
      // Find the order-summary message (the one that had "Confirmas tu pedido")
      const allAssistantMsgs = [...history].filter(h => h.role === 'assistant')
      const orderSummaryMsg  = [...allAssistantMsgs].reverse().find(m => m.message.includes('Confirmas tu pedido'))

      if (orderSummaryMsg) {
        const orderData = extractOrderDataForZoho(orderSummaryMsg, history, customerPhone, customerName)
        console.log('Zoho: firing delivery record creation for', customerPhone, orderData)
        createZohoDeliveryRecord(orderData).catch(err =>
          console.error('Zoho delivery record failed (non-blocking):', err.message)
        )
      } else {
        console.warn('Zoho: HANDOFF_PAYMENT detected but no order summary found in history — skipping')
      }
    }
    // ──────────────────────────────────────────────────────────────────────────

    const cleanReply = replyText
      .replace('HANDOFF_PAYMENT', '')
      .replace('HANDOFF', '')
      .trim()

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
    const history = await getHistory(customerPhone)
    const allAssistantMsgs = history.filter(h => h.role === 'assistant')
    const orderSummaryMsg  = [...allAssistantMsgs].reverse().find(m => m.message.includes('Confirmas tu pedido'))

    if (!orderSummaryMsg) {
      console.warn('Zoho: no order summary found in history for', customerPhone, '— skipping')
      return
    }

    const orderData = extractOrderDataForZoho(orderSummaryMsg, history, customerPhone, customerName)
    console.log('Zoho: firing delivery record (payment image received) for', customerPhone, orderData)

    createZohoDeliveryRecord(orderData).catch(err =>
      console.error('Zoho delivery record failed (non-blocking):', err.message)
    )
  } catch (err) {
    console.error('Zoho triggerZohoOnPayment error (non-blocking):', err.message)
  }
}

module.exports = { processMessage, triggerZohoOnPayment }