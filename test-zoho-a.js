/**
 * test-zoho-a.js — Full order flow with real Zoho entry
 *
 * Runs Scenario A end-to-end WITH Zoho enabled:
 *   1. Order message with vague address "Mariana de Jesús e Inglaterra"
 *   2. "Domicilio por favor" → bot asks for house number
 *   3. "E2-24" → combined geocode → ROOFTOP → order summary with delivery cost
 *   4. "Si confirmo" → bot sends payment details (HANDOFF_PAYMENT)
 *   5. "Transferencia realizada" → triggers Zoho → real CRM record created
 *
 * Run:  node test-zoho-a.js
 */

const path = require('path')
require('dotenv').config({ path: path.resolve(__dirname, '.env'), override: true })

// ⚠️  Zoho NOT disabled — real record will be created in CRM

const { processMessage } = require('./src/agent')
const { getCustomerAddress } = require('./src/memory')
const { createClient }       = require('@supabase/supabase-js')
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY)

const TEST_PHONE = '593000099003'          // separate number from test-rodrigo
const TEST_NAME  = 'Zoho Test Customer'

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
  console.log(`\n${C.cyan}${C.bold}[${label}]${C.reset} ${C.cyan}Customer:${C.reset} ${JSON.stringify(message.substring(0, 140))}`)
  const { reply, needsHandoff, needsPaymentHandoff } = await processMessage(TEST_PHONE, message, TEST_NAME)
  console.log(`${C.blue}     Bot:${C.reset} ${reply.substring(0, 300)}${reply.length > 300 ? '…' : ''}`)
  if (needsPaymentHandoff) console.log(`${C.yellow}     ⚡ HANDOFF_PAYMENT${C.reset}`)
  else if (needsHandoff)   console.log(`${C.yellow}     ⚡ HANDOFF${C.reset}`)
  return { reply, needsHandoff, needsPaymentHandoff }
}

;(async () => {
  console.log(`\n${C.bold}${'═'.repeat(66)}${C.reset}`)
  console.log(`${C.bold}  Micasa Bot — Full Flow + Zoho Entry Test${C.reset}`)
  console.log(`${C.bold}${'═'.repeat(66)}${C.reset}`)
  console.log(`${C.grey}  Phone : ${TEST_PHONE}${C.reset}`)
  console.log(`${C.grey}  Name  : ${TEST_NAME}${C.reset}`)
  console.log(`${C.grey}  Zoho  : ENABLED — real CRM record will be created${C.reset}`)

  await resetDB()

  // ── Step 1: Order with vague address ───────────────────────────────────────
  console.log(`\n${C.bold}── Step 1: Order message with vague address ──${C.reset}`)
  await send('1/5', 'Buenos días quisiera por favor pedirle para el domingo dos fanescas con pescado a la dirección Mariana de Jesús e Inglaterra, podría por favor mandarme los datos para hacerle la transferencia en la noche, gracias')

  const geo1 = await getCustomerAddress(TEST_PHONE).catch(() => null)
  console.log(`${C.grey}  DB → address="${geo1?.address}" | zone=${geo1?.zone}${C.reset}`)

  // ── Step 2: Choose delivery ────────────────────────────────────────────────
  console.log(`\n${C.bold}── Step 2: Delivery choice ──${C.reset}`)
  await send('2/5', 'Domicilio por favor')

  // ── Step 3: Provide house number ───────────────────────────────────────────
  console.log(`\n${C.bold}── Step 3: House number supplement "E2-24" ──${C.reset}`)
  const { reply: step3reply } = await send('3/5', 'E2-24')

  const geo3 = await getCustomerAddress(TEST_PHONE).catch(() => null)
  console.log(`${C.grey}  DB → address="${geo3?.address}" | zone=${geo3?.zone} | dist=${geo3?.distanceKm}km${C.reset}`)

  const hasZone  = !!geo3?.zone
  const hasCost  = /\$\s*\d+[\.,]\d{2}/.test(step3reply) || /envío.*\$\d/i.test(step3reply)
  console.log(`${C.grey}  Zone resolved: ${hasZone ? C.green+'YES'+C.reset : C.red+'NO'+C.reset+C.grey}${C.reset}`)
  console.log(`${C.grey}  Delivery cost in reply: ${hasCost ? C.green+'YES'+C.reset : C.red+'NO'+C.reset+C.grey}${C.reset}`)

  // ── Step 4: Confirm order ─────────────────────────────────────────────────
  console.log(`\n${C.bold}── Step 4: Confirm order ──${C.reset}`)
  const { reply: step4reply, needsPaymentHandoff: step4payment } = await send('4/5', 'Si confirmo')

  const hasPaymentInfo = /transferencia|cuenta|banco|pago/i.test(step4reply)
  console.log(`${C.grey}  Payment info in reply: ${hasPaymentInfo ? C.green+'YES'+C.reset : C.yellow+'(Claude phrased differently)'+C.reset+C.grey}${C.reset}`)
  console.log(`${C.grey}  HANDOFF_PAYMENT: ${step4payment ? C.green+'YES'+C.reset : C.grey+'NO'+C.reset+C.grey}${C.reset}`)

  // ── Step 5: Payment confirmation → Zoho ───────────────────────────────────
  console.log(`\n${C.bold}── Step 5: Payment confirmation → Zoho record ──${C.reset}`)
  console.log(`${C.grey}  Waiting for Zoho… (watch for "Zoho: firing delivery record" in logs)${C.reset}`)
  const { needsPaymentHandoff: step5payment } = await send('5/5', 'Transferencia realizada')

  // Give Zoho a moment to complete (it's non-blocking fire-and-forget)
  await new Promise(r => setTimeout(r, 3000))

  console.log(`\n${C.bold}${'═'.repeat(66)}${C.reset}`)
  console.log(`${C.bold}  Done. Check Zoho CRM for a new deal from "${TEST_NAME}"${C.reset}`)
  console.log(`${C.bold}  Address: ${geo3?.address || '(see logs)'}${C.reset}`)
  console.log(`${C.bold}  Zone: ${geo3?.zone || '?'} | Dist: ${geo3?.distanceKm || '?'}km${C.reset}`)
  console.log(`${C.bold}${'═'.repeat(66)}${C.reset}\n`)

  process.exit(0)
})().catch(err => {
  console.error(`\n${C.red}FATAL:${C.reset}`, err)
  process.exit(1)
})
