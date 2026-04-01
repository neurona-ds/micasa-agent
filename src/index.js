const path = require('path')
require('dotenv').config({ path: path.resolve(__dirname, '../.env'), override: true })
const express = require('express')
const axios = require('axios')
const { processMessage, triggerZohoOnPayment, closeOrderSession, hasPendingOrder } = require('./agent')
const { isBotPaused, pauseBot, resumeBot, getDeliveryZoneByCoordinates, saveDeliveryZoneOnly, saveDeliveryAddress, saveLocationPin, getPendingOrder, savePendingOrder, lookupDeliveryCost, clearPendingOrder, saveMessage, getOrCreateSession, saveCampanaMeta } = require('./memory')

// Meta ad campaign codes embedded at the end of the ad's pre-filled message.
// Detected on the customer's first message → saved to customers.campana_meta → passed to Zoho.
const CAMPAIGN_MAP = {
  '/ci':  'Cold Interest',
  '/wrq': 'Warm Retargeting Web',
  '/la':  'Lookalike 1% - 2%',
  '/wri': 'Warm Retargeting Instagram'
}

const app = express()
app.use(express.json())

// Dedup by whatsappMessageId — WATI sometimes fires the same webhook 2-3x
// Keep the last 500 message IDs in memory (oldest evicted first)
const processedMsgIds = new Set()
const MSG_ID_MAX = 500

// IDs of messages WE sent via the WATI API.
// WATI echoes our outgoing messages back as incoming webhooks (owner:false),
// which would create an infinite loop. We capture the sent ID and block the echo.
const botSentMsgIds = new Set()
const BOT_SENT_MAX = 500

// Rate limit: only process one message per phone number at a time
// Prevents loops when WATI fires multiple webhooks for the same conversation
const processingPhones = new Set()
const lastProcessed = new Map() // phone -> timestamp

// Health check endpoint
app.get('/', (req, res) => {
  res.json({ status: 'Micasa Restaurante Agent is running!' })
})

// Webhook endpoint - WATI sends messages here
app.post('/webhook', async (req, res) => {
  try {
    const body = req.body

    // Log full body so we can see every field WATI sends
    console.log('Webhook received:', JSON.stringify(body))

    // WATI real webhook payload structure:
    // {
    //   waId: "593...",         — customer phone
    //   senderName: "Name",
    //   type: "text",
    //   text: "hola",           — plain string (not an object)
    //   owner: false,           — false = incoming from customer, true = outgoing
    //   eventType: "message"
    // }

    const customerPhone = body.waId || body.from || null
    const customerName = body.senderName || null

    if (!customerPhone) {
      console.log('No phone found in payload — ignoring')
      return res.status(200).json({ status: 'ignored' })
    }

    // ── STALE WEBHOOK FILTER ─────────────────────────────────────────────────
    // WATI queues webhooks while the server is down (Railway redeploy) and
    // replays them all at once when it comes back. Since processedMsgIds is
    // in-memory, those old messages appear fresh after a restart.
    // Fix: reject any webhook whose message timestamp is older than 5 minutes.
    // Real messages arrive within seconds; replays are hours/days old.
    const msgTimestamp = body.timestamp ? parseInt(body.timestamp) * 1000 : null
    if (msgTimestamp) {
      const ageSeconds = Math.round((Date.now() - msgTimestamp) / 1000)
      if (ageSeconds > 300) { // older than 5 minutes
        console.log(`Stale webhook rejected: age=${ageSeconds}s msgId=${body.whatsappMessageId || 'none'} created=${body.created}`)
        return res.status(200).json({ status: 'stale_webhook_ignored' })
      }
    }

    // Deduplicate by whatsappMessageId — WATI fires duplicates for the same event
    const waMsgId = body.whatsappMessageId || null
    if (waMsgId) {
      // Block echo: WATI echoes our own outgoing messages back as incoming webhooks.
      // If this ID was registered when we sent it, ignore it silently.
      if (botSentMsgIds.has(waMsgId)) {
        console.log(`Bot-echo ignored: msgId=${waMsgId}`)
        return res.status(200).json({ status: 'bot_echo_ignored' })
      }

      // Block duplicate: same customer message arriving twice
      if (processedMsgIds.has(waMsgId)) {
        console.log(`Duplicate webhook ignored: msgId=${waMsgId}`)
        return res.status(200).json({ status: 'duplicate_ignored' })
      }
      // Evict oldest entries if set is getting large
      if (processedMsgIds.size >= MSG_ID_MAX) {
        const first = processedMsgIds.values().next().value
        processedMsgIds.delete(first)
      }
      processedMsgIds.add(waMsgId)
    }

    // ── STRICT INCOMING MESSAGE FILTER ──────────────────────────────────────
    // A genuine customer message has ALL of these:
    //   eventType === "message"   (not a status update / delivery receipt)
    //   owner     === false       (false = from customer, true = from bot/operator)
    //   type      === "text" | "image" | "document" | "audio" | "video"
    //   statusString in [undefined, "SENT", "RECEIVED"]  (not DELIVERED / READ)
    //
    // We check eventType first (cheapest). The owner + statusString checks
    // below catch bot echoes and delivery/read receipts that sneak through
    // with eventType:"message" — those were causing unsolicited bot replies.

    const eventType = (body.eventType || '').toLowerCase()
    if (eventType !== 'message' && eventType !== 'sessionmessagesent_v2') {
      // Catches: empty string, "sentMessageStatus", "delivery", "read", etc.
      // sessionmessagesent_v2 = human operator sent a message — needed for operator-assist.
      console.log(`Ignoring non-message event: eventType="${eventType}"`)
      return res.status(200).json({ status: 'ignored_event_type' })
    }

    // Block outgoing message webhooks (delivery/read receipts from WATI)
    const statusString = (body.statusString || '').toUpperCase()
    const OUTGOING_STATUSES = ['DELIVERED', 'READ', 'FAILED', 'OPENED', 'PLAYED', 'DELETED']
    if (OUTGOING_STATUSES.includes(statusString)) {
      console.log(`Ignoring status-update webhook: statusString="${statusString}"`)
      return res.status(200).json({ status: 'ignored_status_update' })
    }

    const rawText = typeof body.text === 'string' ? body.text.trim().toLowerCase() : ''

    // --- OWNER MESSAGES (outgoing — sent by bot API or human operator in WATI) ---
    if (body.owner === true) {
      const operatorEmail = (body.operatorEmail || '').toLowerCase()
      const botEmail = (process.env.WATI_BOT_EMAIL || '').toLowerCase()
      const humanEmail = (process.env.WATI_HUMAN_EMAIL || '').toLowerCase()
      const fullText = typeof body.text === 'string' ? body.text : ''

      // ── ORDER CONFIRMATION DETECTION ─────────────────────────────────────────
      // When the operator sends "📦 Orden Confirmada" (or any message containing
      // "Orden Confirmada") to the customer, it signals the payment has been
      // verified and the order is being dispatched. This is the authoritative
      // signal to close the order session — not the payment screenshot (too early).
      //
      // On confirmation we:
      //  1. Close the session (endSession + clear geocodeClarificationPending)
      //  2. Resume the bot so the customer's NEXT message starts a fresh session
      if (fullText.toLowerCase().includes('orden confirmada')) {
        await closeOrderSession(customerPhone)
        await resumeBot(customerPhone)
        console.log(`[order-confirmed] Session closed + bot resumed for ${customerPhone}`)
        // Fall through — also apply human-agent logic (pause will be overridden by
        // resumeBot above, but we want the operator's message handling to run)
      }

      // If it's any human agent (not the bot itself) → operator assist + pause/resume logic
      // Accept any operatorEmail that is NOT the bot — don't restrict to a single human email
      // so that any team member replying in WATI triggers the operator-assist.
      const isHumanOperator = operatorEmail && operatorEmail !== botEmail
      if (isHumanOperator) {
        if (rawText === '#resume') {
          await resumeBot(customerPhone)
          console.log(`Bot RESUMED for ${customerPhone} by human agent`)
          return res.status(200).json({ status: 'bot_resumed' })
        }

        // ── OPERATOR ASSIST ─────────────────────────────────────────────────────
        // When the operator writes to the customer (not a confirmation message),
        // save their message as [OPERADOR]: in history (role='assistant' so Claude
        // treats it as authoritative ground truth). Then extract any delivery cost
        // or zone the operator provided and update DB fields so the bot has
        // consistent state. If structured data was found, auto-resume the bot so
        // it can continue the order flow without further human intervention.
        if (fullText && !fullText.toLowerCase().includes('orden confirmada')) {
          // Save operator message to conversation history
          const sid = await getOrCreateSession(customerPhone).catch(() => null)
          await saveMessage(customerPhone, 'assistant', `[OPERADOR]: ${fullText}`, sid)
            .catch(e => console.warn('[operator-assist] saveMessage failed:', e.message))
          console.log(`[operator-assist] Saved operator message for ${customerPhone}: "${fullText.substring(0, 80)}"`)

          // Extract delivery cost — e.g. "$3.00", "$ 2.50", "$2,50"
          const costMatch = fullText.match(/\$\s*(\d+(?:[.,]\d{1,2})?)/i)
          const extractedCost = costMatch ? parseFloat(costMatch[1].replace(',', '.')) : null

          // Extract delivery zone — e.g. "zona 3", "Zona2", "zona 1"
          const zoneMatch = fullText.match(/\bzona\s*(\d)\b/i)
          const extractedZone = zoneMatch ? parseInt(zoneMatch[1]) : null

          let dataExtracted = false

          if (extractedCost !== null) {
            // Merge deliveryCost into existing pending_order (don't overwrite other fields)
            const existingOrder = await getPendingOrder(customerPhone).catch(() => null)
            if (existingOrder) {
              await savePendingOrder(customerPhone, { ...existingOrder, deliveryCost: extractedCost })
                .catch(e => console.warn('[operator-assist] savePendingOrder failed:', e.message))
              console.log(`[operator-assist] Updated pending_order.deliveryCost → $${extractedCost}`)
            }
            dataExtracted = true
          }

          if (extractedZone !== null) {
            // Save zone without overwriting the address or distance (null dist is acceptable)
            await saveDeliveryZoneOnly(customerPhone, extractedZone, null)
              .catch(e => console.warn('[operator-assist] saveDeliveryZoneOnly failed:', e.message))
            console.log(`[operator-assist] Saved zone → ${extractedZone} for ${customerPhone}`)
            dataExtracted = true
          }

          // Auto-resume bot when operator provided structured delivery data
          if (dataExtracted) {
            await resumeBot(customerPhone)
            console.log(`[operator-assist] Bot AUTO-RESUMED — operator provided delivery data for ${customerPhone}`)
            return res.status(200).json({ status: 'operator_data_extracted_bot_resumed' })
          }
        }
        // ────────────────────────────────────────────────────────────────────────

        // Only pause if this is NOT the confirmation message (we just resumed above)
        if (!fullText.toLowerCase().includes('orden confirmada')) {
          await pauseBot(customerPhone)
          console.log(`Bot AUTO-PAUSED for ${customerPhone} — human agent took over`)
        }
        return res.status(200).json({ status: 'operator_takeover' })
      }

      // Bot email or anything else → ignore silently
      console.log(`Ignoring owner message from: ${operatorEmail || 'bot'}`)
      return res.status(200).json({ status: 'ignored_owner_message' })
    }

    // WATI sets operatorEmail + assignedId to the assignee on ALL messages.
    // We use assignedId (most reliable) with email as fallback.
    const botAssignedId = (process.env.WATI_BOT_ASSIGNED_ID || '').toLowerCase()
    const botEmail = (process.env.WATI_BOT_EMAIL || '').toLowerCase()
    const assignedId = (body.assignedId || '').toLowerCase()
    const assigneeEmail = (body.operatorEmail || '').toLowerCase()

    console.log(`assignedId=${assignedId} assigneeEmail=${assigneeEmail} botAssignedId=${botAssignedId} botEmail=${botEmail}`)

    // Is this assigned to the bot?
    const isAssignedToBot =
      (botAssignedId && assignedId === botAssignedId) ||
      (!botAssignedId && botEmail && assigneeEmail === botEmail)

    // Is this assigned to a human (not the bot)?
    const isAssignedToHuman = !isAssignedToBot && (assignedId || assigneeEmail)

    let justResumed = false

    // If assigned to bot → auto-resume and process message
    if (isAssignedToBot) {
      await resumeBot(customerPhone)
      console.log(`Auto-resumed: assigned to bot (${assignedId || assigneeEmail})`)
      justResumed = true
    } else if (isAssignedToHuman) {
      // If human agent sends #resume as a message, resume bot
      if (rawText === '#resume') {
        await resumeBot(customerPhone)
        console.log(`Bot RESUMED for ${customerPhone} by #resume command`)
        return res.status(200).json({ status: 'bot_resumed' })
      }
      // Save customer text messages to history while assigned to human agent,
      // so Claude has full context when the bot eventually resumes.
      const incomingType = (body.type || 'text').toLowerCase()
      const incomingText = typeof body.text === 'string' ? body.text : null
      if (incomingText && incomingType === 'text') {
        const sid = await getOrCreateSession(customerPhone).catch(() => null)
        await saveMessage(customerPhone, 'user', incomingText, sid)
          .catch(e => console.warn('[operator-assist] saveMessage (customer) failed:', e.message))
        console.log(`[operator-assist] Saved customer message to history (assigned to human)`)
      }
      // Otherwise block bot and let human handle it
      await pauseBot(customerPhone)
      console.log(`Auto-paused: assigned to human agent (${assigneeEmail})`)
      return res.status(200).json({ status: 'assigned_to_human_skipped' })
    }

    // Check if bot is paused (skip check if we just resumed above)
    if (!justResumed) {
      const paused = await isBotPaused(customerPhone)
      if (paused) {
        // Save customer text messages to history while bot is paused,
        // so Claude has full context when the bot eventually resumes.
        const incomingType = (body.type || 'text').toLowerCase()
        const incomingText = typeof body.text === 'string' ? body.text : null
        if (incomingText && incomingType === 'text') {
          const sid = await getOrCreateSession(customerPhone).catch(() => null)
          await saveMessage(customerPhone, 'user', incomingText, sid)
            .catch(e => console.warn('[operator-assist] saveMessage (paused) failed:', e.message))
          console.log(`[operator-assist] Saved customer message to history (bot paused)`)
        }
        console.log(`Bot is paused for ${customerPhone} — human handling this chat`)
        return res.status(200).json({ status: 'bot_paused_skipped' })
      }
    }

    // Rate limit: if already processing a message for this phone, ignore
    if (processingPhones.has(customerPhone)) {
      console.log(`Already processing message for ${customerPhone} — ignoring`)
      return res.status(200).json({ status: 'rate_limited' })
    }

    // Rate limit: guard against rare WATI duplicates that arrive with a different
    // waMsgId (true duplicates with the same ID are already blocked above).
    // 500 ms is enough to catch network-level duplicates (which arrive in <100 ms)
    // while NOT blocking a customer who sends a follow-up message or location pin
    // 1–2 seconds after the bot's reply (previously dropped at 3 s).
    const last = lastProcessed.get(customerPhone) || 0
    const elapsed = Date.now() - last
    if (elapsed < 500) {
      console.log(`Too soon for ${customerPhone} (${elapsed}ms since last) — ignoring`)
      return res.status(200).json({ status: 'rate_limited' })
    }

    // Detect media/image message types
    const messageType = (body.type || 'text').toLowerCase()
    const isMediaMessage = ['image', 'document', 'audio', 'video'].includes(messageType)

    // If customer sent a photo/media — treat as payment confirmation only if there
    // is an active pending order. Subsequent images (e.g. clarifications) are
    // forwarded to the admin without re-triggering the full payment flow.
    if (isMediaMessage) {
      console.log(`MEDIA MESSAGE received from ${customerPhone} — type: ${messageType}`)

      const hasPending = await hasPendingOrder(customerPhone)

      if (hasPending) {
        // First payment image — active order in progress
        const ackMessage =
          '¡Gracias! 📲 Recibimos tu comprobante de pago. Estamos verificando tu transferencia y en breve procesamos tu pedido. ¡Que disfrutes tu comida! 💛'
        await sendWatiMessage(customerPhone, ackMessage)
        await notifyHandoff(customerPhone, customerName, 'PAYMENT', 'Cliente envió comprobante de pago')
        triggerZohoOnPayment(customerPhone, customerName)
      } else {
        // Follow-up image — order already processed, ignore silently
        console.log(`MEDIA follow-up (no pending order) from ${customerPhone} — ignored`)
      }

      return res.status(200).json({ status: 'media_handoff' })
    }

    // ── LOCATION PIN MESSAGE ─────────────────────────────────────────────────
    // Customer shared their WhatsApp location. Extract lat/lng, reverse-geocode
    // to a formatted address, calculate zone, save to DB, then pass an enriched
    // message to Claude with the zone injected — same flow as a text address.
    if (messageType === 'location') {
      console.log(`LOCATION PIN received from ${customerPhone}`)

      let lat = null, lng = null
      try {
        // WATI may send location data as a JSON string or plain object
        const locData = typeof body.data === 'string'
          ? JSON.parse(body.data)
          : (body.data || {})
        lat = locData.latitude ?? locData.lat ?? null
        lng = locData.longitude ?? locData.lng ?? null
      } catch (e) {
        console.warn('Could not parse location data:', body.data)
      }

      // Fallback: some WATI versions put coords inside body.text as a Maps URL
      // e.g. "https://www.google.com/maps/search/-0.19949272274971,-78.481018066406"
      // when body.data is null. Extract coords from the URL directly.
      if ((lat == null || lng == null) && typeof body.text === 'string') {
        const coordMatch = body.text.match(/maps\/search\/(-?\d+\.?\d*),\+?(-?\d+\.?\d*)/)
          || body.text.match(/[?&]q=(-?\d+\.?\d*),\+?(-?\d+\.?\d*)/)
          || body.text.match(/\/@(-?\d+\.?\d*),(-?\d+\.?\d*)/)
        if (coordMatch) {
          lat = parseFloat(coordMatch[1])
          lng = parseFloat(coordMatch[2])
          console.log(`[location handler] Coords extracted from text URL: lat=${lat}, lng=${lng}`)
        }
      }

      if (lat == null || lng == null) {
        console.warn('Location message missing lat/lng — ignoring')
        return res.status(200).json({ status: 'location_missing_coords' })
      }

      processingPhones.add(customerPhone)
      try {
        // Save coords immediately — before geocoding, non-blocking.
        // Writes last_location_pin { lat, lng } + last_location_url (clean Maps URL).
        saveLocationPin(customerPhone, lat, lng).catch(err =>
          console.warn('saveLocationPin failed (non-blocking):', err.message)
        )

        const zoneResult = await getDeliveryZoneByCoordinates(lat, lng)

        // "📍 Ubicación compartida" is what Claude sees as the "customer message".
        // We intentionally do NOT include the geocoded formatted address here —
        // Claude would echo it back to the customer, which confuses them when it
        // differs from what they recognise (e.g. "El Bosque, Quito 170132" vs
        // what they call their neighbourhood). Zone is still injected for pricing.
        let locationMessage = '📍 Ubicación compartida vía WhatsApp'
        if (zoneResult) {
          const { zone, distanceKm, formattedAddress } = zoneResult

          // Save zone + distance only — the customer's typed text address is the
          // human reference for Zoho. Pin is used for delivery zone calculation only.
          saveDeliveryZoneOnly(customerPhone, zone, distanceKm).catch(err =>
            console.warn('[location handler] saveDeliveryZoneOnly failed:', err.message)
          )

          // Bug 4 Part B: Detect delivery cost change when a location pin changes the zone
          // AFTER an order summary was already shown. If cost differs, tell Claude to show updated summary.
          let costChangeWarning = ''
          const existingOrder = await getPendingOrder(customerPhone).catch(() => null)
          if (existingOrder && existingOrder.deliveryCost !== null && existingOrder.deliveryCost !== undefined) {
            const newCost = await lookupDeliveryCost(zone, existingOrder.orderType, existingOrder.total, existingOrder.cantidad).catch(() => null)
            if (newCost !== null && newCost !== existingOrder.deliveryCost) {
              console.log(`[location handler] Bug 4: delivery cost changed! Old=$${existingOrder.deliveryCost} → New=$${newCost} (zone ${zone})`)
              costChangeWarning = ` ⚠️ IMPORTANTE: El costo de envío cambió de $${existingOrder.deliveryCost.toFixed(2)} a $${newCost.toFixed(2)} con esta nueva ubicación. DEBES mostrar un resumen ACTUALIZADO con el nuevo costo de envío y total ANTES de pedir confirmación. NO uses el resumen anterior.`
              // Clear the stale pending_order so a fresh <ORDEN> is generated
              clearPendingOrder(customerPhone).catch(() => {})
            }
          }

          // Inject zone for delivery pricing — geocoded address is intentionally
          // omitted from what Claude sees (stored internally for Zoho only via log).
          locationMessage += `\n\n[SISTEMA: Pin de ubicación recibido | Distancia: ${distanceKm}km → Zona ${zone}. NO mencionar zona al cliente. NO mostrar dirección geocodificada al cliente.${costChangeWarning}]`
          console.log(`[location handler] Zone ${zone} (${distanceKm}km) | geocoded="${formattedAddress}" (NOT sent to Claude)`)
        } else {
          console.warn('[location handler] Reverse-geocoding failed — passing pin to Claude without zone')
        }

        const result = await processMessage(customerPhone, locationMessage, customerName)
        await sendWatiMessage(customerPhone, result.reply)
        if (result.needsPaymentHandoff) {
          await notifyHandoff(customerPhone, customerName, 'PAYMENT', locationMessage)
        } else if (result.needsHandoff) {
          await notifyHandoff(customerPhone, customerName, 'GENERAL', locationMessage)
        }
        lastProcessed.set(customerPhone, Date.now())
      } finally {
        processingPhones.delete(customerPhone)
      }
      return res.status(200).json({ status: 'location_processed' })
    }
    // ──────────────────────────────────────────────────────────────────────────

    // Regular text message — WATI sends text as plain string
    let customerMessage =
      (typeof body.text === 'string' ? body.text : null) ||  // WATI real format
      body.text?.body ||                                       // alternative format
      body.body ||                                             // old format
      null

    if (!customerMessage) {
      console.log('No message text found — ignoring. Payload:', JSON.stringify(body))
      return res.status(200).json({ status: 'ignored' })
    }

    // ── META CAMPAIGN CODE DETECTION ─────────────────────────────────────────
    // Meta ads append a short code at the end of the pre-filled message (e.g. "/la").
    // Detect it on any message, save to DB for Zoho attribution, strip before Claude.
    const campaignMatch = customerMessage.match(/\s*(\/(?:ci|wrq|la|wri))\s*$/i)
    if (campaignMatch) {
      const code = campaignMatch[1].toLowerCase()
      const campana = CAMPAIGN_MAP[code]
      if (campana) {
        saveCampanaMeta(customerPhone, campana).catch(e =>
          console.warn('[campana] saveCampanaMeta failed:', e.message)
        )
        console.log(`[campana] Code "${code}" → "${campana}" saved for ${customerPhone}`)
        customerMessage = customerMessage.slice(0, campaignMatch.index).trim()
        if (!customerMessage) customerMessage = 'Hola'  // fallback if message was ONLY the code
      }
    }
    // ─────────────────────────────────────────────────────────────────────────

    // Wait 3 seconds before processing — gives the customer time to finish
    // sending split messages and makes the reply feel less robotic.
    await new Promise(r => setTimeout(r, 3000))

    // Mark as processing — block any concurrent webhook for this phone.
    // lastProcessed is stamped AFTER the reply is sent (see below) so the
    // 3-second cooldown starts when the customer can actually see the response.
    processingPhones.add(customerPhone)

    // Deterministic override: ANY weekend almuerzo inquiry → immediate HANDOFF (no Claude call needed)
    // Weekend almuerzo menu is not pre-programmed — a human must confirm what's available.
    const dow = new Date(Date.now() - 5 * 60 * 60 * 1000).getDay() // Ecuador UTC-5, 0=Sun, 6=Sat
    const isWeekend = dow === 0 || dow === 6
    const msgLower = customerMessage.toLowerCase()
    const mentionsAlmuerzo = msgLower.includes('almuerzo') || msgLower.includes('almuerzos')
    const isAlmuerzoOrderOnWeekend = isWeekend && mentionsAlmuerzo

    let reply, needsHandoff, needsPaymentHandoff
    if (isAlmuerzoOrderOnWeekend) {
      console.log(`Weekend almuerzo order detected — bypassing Claude, sending HANDOFF`)
      reply = '¡Con gusto! En un momento te confirmamos el menú del día y los detalles de tu pedido. 😊'
      needsHandoff = true
      needsPaymentHandoff = false
      processingPhones.delete(customerPhone)
      // Save messages to history
      const { saveMessage } = require('./memory')
      await saveMessage(customerPhone, 'user', customerMessage)
      await saveMessage(customerPhone, 'assistant', reply)
    } else {
      try {
        ;({ reply, needsHandoff, needsPaymentHandoff } = await processMessage(
          customerPhone,
          customerMessage,
          customerName
        ))
      } finally {
        processingPhones.delete(customerPhone)
      }
    }

    // Send reply to customer
    // Payment messages are split into two: bank accounts + follow-up instructions
    const PAYMENT_SPLIT_MARKERS = ['Una vez realices la transferencia', 'Una vez hecho el pago', 'Una vez realizada la transferencia']
    const splitMarker = PAYMENT_SPLIT_MARKERS.find(m => reply.includes(m))
    if (splitMarker) {
      const splitIdx = reply.indexOf(splitMarker)
      const msg1 = reply.substring(0, splitIdx).trim()
      const msg2 = reply.substring(splitIdx).trim()
      await sendWatiMessage(customerPhone, msg1)
      await new Promise(r => setTimeout(r, 1000)) // 1s pause between messages
      await sendWatiMessage(customerPhone, msg2)
    } else {
      await sendWatiMessage(customerPhone, reply)
    }

    // Handle handoff notifications
    if (needsPaymentHandoff) {
      await notifyHandoff(customerPhone, customerName, 'PAYMENT', customerMessage)
      await pauseBot(customerPhone) // wait for human to verify payment
    } else if (needsHandoff) {
      await notifyHandoff(customerPhone, customerName, 'GENERAL', customerMessage)
      await pauseBot(customerPhone) // wait for human to provide delivery info — bot auto-resumes when operator sends price
    }

    // Stamp lastProcessed NOW — after the reply has been sent — so the 3-second
    // cooldown counts from when the customer can see the bot's response, not from
    // when the incoming webhook first arrived.
    lastProcessed.set(customerPhone, Date.now())

    res.status(200).json({ status: 'ok' })

  } catch (error) {
    console.error('Webhook error:', error)
    // Always return 200 — a 5xx response causes WATI to retry the webhook,
    // which would make the bot send duplicate/unsolicited messages.
    res.status(200).json({ status: 'error', message: error.message })
  }
})

// Send message via WATI and register the outgoing message ID so we can
// block the echo webhook WATI fires back for our own messages.
async function sendWatiMessage(phone, message) {
  try {
    const response = await axios.post(
      `https://live-mt-server.wati.io/470858/api/v1/sendSessionMessage/${phone}`,
      null,  // no body
      {
        params: { messageText: message },  // WATI requires messageText as query param
        headers: {
          Authorization: process.env.WATI_API_KEY,
          'Content-Type': 'application/json'
        }
      }
    )

    // Capture the outgoing WhatsApp message ID so we can ignore the echo webhook
    const sentMsgId =
      response.data?.id ||
      response.data?.messageId ||
      response.data?.data?.id ||
      response.data?.data?.messageId ||
      null

    if (sentMsgId) {
      if (botSentMsgIds.size >= BOT_SENT_MAX) {
        const first = botSentMsgIds.values().next().value
        botSentMsgIds.delete(first)
      }
      botSentMsgIds.add(sentMsgId)
      console.log(`Message sent to ${phone}: ok (msgId=${sentMsgId})`)
    } else {
      console.log(`Message sent to ${phone}:`, response.data?.result || 'ok', '(no msgId in response)')
    }
  } catch (error) {
    console.error('Error sending WATI message:', error.response?.data || error.message)
  }
}

// Notify admin via WhatsApp when handoff is needed
async function notifyHandoff(customerPhone, customerName, type, lastMessage) {
  const adminPhone = process.env.ADMIN_PHONE
  if (!adminPhone) {
    console.warn('ADMIN_PHONE not set in .env — handoff not sent')
    return
  }

  const emoji = type === 'PAYMENT' ? '💳' : '🚨'
  const label = type === 'PAYMENT' ? 'PAGO PENDIENTE' : 'ATENCIÓN REQUERIDA'

  const notification =
    `${emoji} *${label}*\n` +
    `Cliente: ${customerName || 'Desconocido'}\n` +
    `Teléfono: ${customerPhone}\n` +
    `Último mensaje: "${lastMessage}"\n` +
    `Responde directamente en WATI para tomar el caso.`

  await sendWatiMessage(adminPhone, notification)
  console.log(`${type} HANDOFF notified to admin (${adminPhone}) for customer: ${customerPhone}`)
}

const PORT = process.env.PORT || 3000
app.listen(PORT, () => {
  console.log(`Micasa Restaurante Agent running on port ${PORT}`)
})
