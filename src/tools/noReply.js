// Decides, without calling Claude, when a customer message needs no reply.
// Every WhatsApp message the bot sends costs money and adds noise, so a bare
// "👍", "gracias" or "ok" after the bot already said its piece gets silence.
//
// Safety rule: if the bot's last message asked something ("?"), the short
// message may be the answer (a 👍 or "dale" to "¿Te lo envío?"), so we let it
// through to Claude. The order-confirmation prompt is never filtered.

const THANKS = [
  'gracias', 'muchas gracias', 'mil gracias', 'gracias igual', 'igual gracias',
  'no gracias', 'no muchas gracias', 'gracias a ti', 'gracias a usted',
  'ok gracias', 'okey gracias', 'perfecto gracias', 'dale gracias',
  'bueno gracias', 'genial gracias', 'excelente gracias', 'super gracias'
]

const ACKS = [
  'ok', 'okey', 'oki', 'okis', 'perfecto', 'dale', 'bueno', 'genial',
  'excelente', 'super', 'chevere', 'de acuerdo', 'entendido', 'vale',
  'buenisimo', 'muy bien'
]

const NO_REPLY_PHRASES = new Set([...THANKS, ...ACKS])

// Lowercase, drop accents, emojis and punctuation, collapse spaces.
function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[\p{Extended_Pictographic}\p{Emoji_Modifier}‍️]/gu, ' ')
    .replace(/[^a-zñ0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function isNoReplyNeeded(customerMessage, lastBotMessage = '') {
  const raw = String(customerMessage || '').trim()
  if (!raw) return false

  const lastBot = String(lastBotMessage || '')
  if (lastBot.includes('Confirmas tu pedido')) return false
  if (lastBot.includes('?')) return false

  const text = normalize(raw)
  if (text === '') return true                  // only emojis / punctuation
  return NO_REPLY_PHRASES.has(text)
}

module.exports = { isNoReplyNeeded, normalize }
