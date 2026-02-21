const path = require('path')
require('dotenv').config({ path: path.resolve(__dirname, '../.env'), override: true })
const express = require('express')
const axios = require('axios')
const { processMessage } = require('./agent')
const { isBotPaused, pauseBot, resumeBot } = require('./memory')

const app = express()
app.use(express.json())

// Health check endpoint
app.get('/', (req, res) => {
  res.json({ status: 'Micasa Restaurante Agent is running!' })
})

// Webhook endpoint - WATI sends messages here
app.post('/webhook', async (req, res) => {
  try {
    console.log('Incoming webhook:', JSON.stringify(req.body, null, 2))

    const body = req.body

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
      // Since both bot and human share the same WATI account,
      // we can't distinguish them by email/name.
      // Use explicit commands typed by the operator:
      //   #pause  → pause the bot for this customer
      //   #resume → resume the bot for this customer
      // All other owner messages (including bot replies) are silently ignored.

      if (rawText === '#pause') {
        await pauseBot(customerPhone)
        console.log(`Bot PAUSED for ${customerPhone} by operator command`)
        return res.status(200).json({ status: 'bot_paused' })
      }

      if (rawText === '#resume') {
        await resumeBot(customerPhone)
        console.log(`Bot RESUMED for ${customerPhone} by operator command`)
        return res.status(200).json({ status: 'bot_resumed' })
      }

      // Everything else (bot replies, operator messages) — ignore silently
      return res.status(200).json({ status: 'ignored_owner_message' })
    }

    // Check if bot is paused for this customer (human takeover active)
    const paused = await isBotPaused(customerPhone)
    if (paused) {
      console.log(`Bot is paused for ${customerPhone} — human handling this chat`)
      return res.status(200).json({ status: 'bot_paused_skipped' })
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

    const { reply, needsHandoff, needsPaymentHandoff } = await processMessage(
      customerPhone,
      customerMessage,
      customerName
    )

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
