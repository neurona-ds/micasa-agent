const path = require('path')
require('dotenv').config({ path: path.resolve(__dirname, '../.env'), override: true })
const express = require('express')
const axios = require('axios')
const { processMessage } = require('./agent')
const { isBotPaused, pauseBot, resumeBot } = require('./memory')

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
    if (eventType !== 'message') {
      // Catches: empty string, "sentMessageStatus", "delivery", "read", etc.
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

      // If it's the human agent email → pause bot + handle #resume
      if (humanEmail && operatorEmail === humanEmail) {
        if (rawText === '#resume') {
          await resumeBot(customerPhone)
          console.log(`Bot RESUMED for ${customerPhone} by human agent`)
          return res.status(200).json({ status: 'bot_resumed' })
        }
        await pauseBot(customerPhone)
        console.log(`Bot AUTO-PAUSED for ${customerPhone} — human agent took over`)
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
      // Otherwise block bot and let human handle it
      await pauseBot(customerPhone)
      console.log(`Auto-paused: assigned to human agent (${assigneeEmail})`)
      return res.status(200).json({ status: 'assigned_to_human_skipped' })
    }

    // Check if bot is paused (skip check if we just resumed above)
    if (!justResumed) {
      const paused = await isBotPaused(customerPhone)
      if (paused) {
        console.log(`Bot is paused for ${customerPhone} — human handling this chat`)
        return res.status(200).json({ status: 'bot_paused_skipped' })
      }
    }

    // Rate limit: if already processing a message for this phone, ignore
    if (processingPhones.has(customerPhone)) {
      console.log(`Already processing message for ${customerPhone} — ignoring`)
      return res.status(200).json({ status: 'rate_limited' })
    }

    // Rate limit: enforce minimum 8 seconds between messages per phone
    const last = lastProcessed.get(customerPhone) || 0
    const elapsed = Date.now() - last
    if (elapsed < 8000) {
      console.log(`Too soon for ${customerPhone} (${elapsed}ms since last) — ignoring`)
      return res.status(200).json({ status: 'rate_limited' })
    }

    // Detect media/image message types
    const messageType = (body.type || 'text').toLowerCase()
    const isMediaMessage = ['image', 'document', 'audio', 'video'].includes(messageType)

    // If customer sent a photo/media — treat as payment confirmation
    if (isMediaMessage) {
      console.log(`MEDIA MESSAGE received from ${customerPhone} — type: ${messageType}`)

      const ackMessage =
        '¡Gracias! 📲 Recibimos tu comprobante de pago. Estamos verificando tu transferencia y en breve procesamos tu pedido. ¡Que disfrutes tu comida! 💛'

      await sendWatiMessage(customerPhone, ackMessage)
      await notifyHandoff(customerPhone, customerName, 'PAYMENT', 'Cliente envió comprobante de pago')

      return res.status(200).json({ status: 'media_handoff' })
    }

    // Regular text message — WATI sends text as plain string
    const customerMessage =
      (typeof body.text === 'string' ? body.text : null) ||  // WATI real format
      body.text?.body ||                                       // alternative format
      body.body ||                                             // old format
      null

    if (!customerMessage) {
      console.log('No message text found — ignoring. Payload:', JSON.stringify(body))
      return res.status(200).json({ status: 'ignored' })
    }

    // Mark as processing — block any concurrent webhook for this phone
    processingPhones.add(customerPhone)
    lastProcessed.set(customerPhone, Date.now())

    // Deterministic override: weekend almuerzo ORDER → immediate HANDOFF (no Claude call needed)
    const dow = new Date().getDay() // 0=Sun, 6=Sat
    const isWeekend = dow === 0 || dow === 6
    const msgLower = customerMessage.toLowerCase()
    const mentionsAlmuerzo = msgLower.includes('almuerzo') || msgLower.includes('almuerzos')
    const mentionsOrderIntent = (
      msgLower.includes('quiero') || msgLower.includes('pedir') || msgLower.includes('pedido') ||
      msgLower.includes('dame') || msgLower.includes('me das') || msgLower.includes('ordenar') ||
      msgLower.includes('domicilio') || msgLower.includes('delivery') ||
      msgLower.includes('para el lunes') || msgLower.includes('para el martes') ||
      msgLower.includes('para la semana') || msgLower.includes('para mañana') ||
      /^\d+/.test(msgLower.trim()) // starts with a number e.g. "2 almuerzos"
    )
    // Fire HANDOFF if: mentions almuerzo + any order intent, OR if it's weekend and clear order keywords with food context
    const isAlmuerzoOrderOnWeekend = isWeekend && mentionsAlmuerzo && mentionsOrderIntent

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
    } else if (needsHandoff) {
      await notifyHandoff(customerPhone, customerName, 'GENERAL', customerMessage)
    }

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
