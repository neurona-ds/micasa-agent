/**
 * test-benitez-zoho.js — Jorge Benítez exact flow WITH Zoho enabled
 *
 * Replicates Jorge Benítez's real conversation (2026-03-07) to verify:
 *   1. "Los Pinos E 13-66 y Guayacanes. Sector El Edén. Tras del Hospital de Solca"
 *      (14 words, previously blocked by <= 12 word limit) now passes looksLikeAddress
 *   2. GPS pin saves formattedAddress to last_delivery_address (not just zone)
 *   3. Zoho CRM record receives the address (not null)
 *
 * Run:  node test-benitez-zoho.js
 */

const path = require('path')
require('dotenv').config({ path: path.resolve(__dirname, '.env'), override: true })

// ⚠️  Zoho NOT disabled — real CRM record will be created

const { processMessage } = require('./src/agent')
const { getCustomerAddress, getPendingOrder } = require('./src/memory')
const { createZohoDeliveryRecord } = require('./src/zoho')
const { createClient } = require('@supabase/supabase-js')
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY)

const TEST_PHONE = '593000099006'
const TEST_NAME  = 'Jorge Benítez Test'

const C = {
  reset: '\x1b[0m', bold: '\x1b[1m',
  cyan: '\x1b[36m', green: '\x1b[32m', yellow: '\x1b[33m',
  red: '\x1b[31m',  grey: '\x1b[90m',  blue: '\x1b[34m',
}

async function resetDB() {
  await supabase.from('customers').upsert({
    phone: TEST_PHONE, name: TEST_NAME,
    pending_order: null, last_delivery_address: null,
    last_delivery_zone: null, last_delivery_distance_km: null,
    last_location_pin: null, last_location_url: null,
    current_session_id: null, session_last_activity_at: null, bot_paused: false
  }, { onConflict: 'phone' })
  await supabase.from('conversations').delete().eq('customer_phone', TEST_PHONE)
  console.log(`${C.grey}  [setup] DB reset done${C.reset}`)
}

async function send(label, message) {
  console.log(`\n${C.cyan}${C.bold}[${label}]${C.reset} ${C.cyan}Customer:${C.reset} ${JSON.stringify(message.substring(0, 160))}`)
  const { reply, needsHandoff, needsPaymentHandoff } = await processMessage(TEST_PHONE, message, TEST_NAME)
  console.log(`${C.blue}     Bot:${C.reset} ${reply.substring(0, 320)}${reply.length > 320 ? '…' : ''}`)
  if (needsPaymentHandoff) console.log(`${C.yellow}     ⚡ HANDOFF_PAYMENT${C.reset}`)
  else if (needsHandoff)   console.log(`${C.yellow}     ⚡ HANDOFF${C.reset}`)
  return { reply, needsHandoff, needsPaymentHandoff }
}

;(async () => {
  console.log(`\n${C.bold}${'═'.repeat(66)}${C.reset}`)
  console.log(`${C.bold}  Micasa Bot — Jorge Benítez Flow + Zoho Entry Test${C.reset}`)
  console.log(`${C.bold}${'═'.repeat(66)}${C.reset}`)
  console.log(`${C.grey}  Phone : ${TEST_PHONE}${C.reset}`)
  console.log(`${C.grey}  Name  : ${TEST_NAME}${C.reset}`)
  console.log(`${C.grey}  Zoho  : ENABLED — real CRM record will be created${C.reset}`)

  await resetDB()

  // ── Step 1: Order (fanesca fast-path) ────────────────────────────────────────
  console.log(`\n${C.bold}── Step 1: "Quiero dos fanescas a domicilio" ──${C.reset}`)
  await send('1/6', 'Quiero dos fanescas con pescado a domicilio')

  // ── Step 2: Confirm delivery → bot asks for address ("dirección completa 📍") ─
  console.log(`\n${C.bold}── Step 2: "Domicilio por favor" → bot must ask for address ──${C.reset}`)
  await send('2/6', 'Domicilio por favor')

  // ── Step 3: 14-word address — now lastBotAskedAddress=true → geocodes + saves ─
  console.log(`\n${C.bold}── Step 3: 14-word address ──${C.reset}`)
  await send('3/6', 'Los Pinos E 13-66 y Guayacanes. Sector El Edén. Tras del Hospital de Solca')

  const geo3 = await getCustomerAddress(TEST_PHONE).catch(() => null)
  console.log(`${C.grey}  DB after step 3 → address="${geo3?.address}" | zone=${geo3?.zone}${C.reset}`)
  if (geo3?.address) {
    console.log(`${C.green}  ✓ customer text address saved: "${geo3.address}"${C.reset}`)
  } else {
    console.log(`${C.yellow}  ⚠ text address not saved yet${C.reset}`)
  }

  // ── Step 4: GPS pin (real coords from Benítez session) ───────────────────────
  console.log(`\n${C.bold}── Step 4: GPS pin (-0.1351433, -78.4669747) ──${C.reset}`)
  await send('4/6', 'https://www.google.com/maps/search/-0.1351433,-78.4669747')

  const geo4 = await getCustomerAddress(TEST_PHONE).catch(() => null)
  console.log(`${C.grey}  DB after step 4 → address="${geo4?.address}" | zone=${geo4?.zone} | dist=${geo4?.distanceKm}km${C.reset}`)

  if (geo4?.address) {
    console.log(`${C.green}  ✓ address in DB — Zoho will receive: "${geo4.address}"${C.reset}`)
  } else {
    console.log(`${C.red}  ✗ address still null after pin${C.reset}`)
  }

  // ── Step 5: Confirm order ────────────────────────────────────────────────────
  console.log(`\n${C.bold}── Step 5: Confirm order ──${C.reset}`)
  await send('5/6', 'Si confirmo')

  const order5 = await getPendingOrder(TEST_PHONE).catch(() => null)
  console.log(`${C.grey}  DB pending_order.address="${order5?.address}" | total=${order5?.total}${C.reset}`)

  // ── Step 6: Trigger Zoho directly with the pending order ────────────────────
  // In production, Zoho fires when the customer sends a payment image (index.js handler).
  // Here we trigger it directly with the confirmed pending_order to verify the address
  // reaches Zoho correctly.
  console.log(`\n${C.bold}── Step 6: Trigger Zoho with pending order ──${C.reset}`)
  const finalOrder = await getPendingOrder(TEST_PHONE).catch(() => null)
  console.log(`${C.grey}  Sending to Zoho: address="${finalOrder?.address}"${C.reset}`)
  await createZohoDeliveryRecord(finalOrder)


  console.log(`\n${C.bold}${'═'.repeat(66)}${C.reset}`)
  console.log(`${C.bold}  Done. Check Zoho CRM for a deal from "${TEST_NAME}"${C.reset}`)
  console.log(`${C.bold}  Address: ${geo4?.address || '(null — fix not working)'}${C.reset}`)
  console.log(`${C.bold}  Zone: ${geo4?.zone || '?'} | Dist: ${geo4?.distanceKm || '?'}km${C.reset}`)
  console.log(`${C.bold}${'═'.repeat(66)}${C.reset}\n`)

  process.exit(0)
})().catch(err => {
  console.error(`\n${C.red}FATAL:${C.reset}`, err)
  process.exit(1)
})
