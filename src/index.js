const path = require('path')
require('dotenv').config({ path: path.resolve(__dirname, '../.env'), override: true })
const express = require('express')
const axios = require('axios')
const { processMessage } = require('./agent')
const { isBotPaused, pauseBot, resumeBot } = require('./memory')

const app = express()
app.use(express.json())

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

    // Log key fields only (not full body to keep logs clean)
    console.log('Webhook received:', JSON.stringify({
      waId: body.waId,
      senderName: body.senderName,
      type: body.type,
      owner: body.owner,
      eventType: body.eventType,
      text: typeof body.text === 'string' ? body.text.substring(0, 80) : body.text,
      operatorName: body.operatorName,
      operatorEmail: body.operatorEmail
    }))

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

    // Check if bot is paused for this customer (human takeover active)
    const paused = await isBotPaused(customerPhone)
    if (paused) {
      console.log(`Bot is paused for ${customerPhone} — human handling this chat`)
      return res.status(200).json({ status: 'bot_paused_skipped' })
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

    let reply, needsHandoff, needsPaymentHandoff
    try {
      ;({ reply, needsHandoff, needsPaymentHandoff } = await processMessage(
        customerPhone,
        customerMessage,
        customerName
      ))
    } finally {
      processingPhones.delete(customerPhone)
    }

    // Send reply to customer
    await sendWatiMessage(customerPhone, reply)

    // Handle handoff notifications
    if (needsPaymentHandoff) {
      await notifyHandoff(customerPhone, customerName, 'PAYMENT', customerMessage)
    } else if (needsHandoff) {
      await notifyHandoff(customerPhone, customerName, 'GENERAL', customerMessage)
    }

    res.status(200).json({ status: 'ok' })

  } catch (error) {
    console.error('Webhook error:', error)
    res.status(500).json({ status: 'error', message: error.message })
  }
})

// Send message via WATI
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
    console.log(`Message sent to ${phone}:`, response.data?.result || 'ok')
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
