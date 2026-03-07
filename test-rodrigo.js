/**
 * test-rodrigo.js — Replay of RODRIGO MALDONADO's real conversation
 *
 * The bug: customer sent "...a la dirección Jorge Juan y Mariana de Jesús..."
 * in a fresh message BEFORE the bot asked for address → no geocoding happened
 * → bot replied "Envío: A confirmar por un asesor" + HANDOFF.
 *
 * The fix: proactive geocoding branch detects "a la dirección" keyword and
 * geocodes immediately, so the bot knows the zone on the next turn.
 *
 * Run:  node test-rodrigo.js
 */

const path = require('path')
require('dotenv').config({ path: path.resolve(__dirname, '.env'), override: true })

delete process.env.ZOHO_CLIENT_ID   // disable Zoho — don't pollute CRM

const { processMessage } = require('./src/agent')
const { getCustomerAddress }        = require('./src/memory')
const { createClient }              = require('@supabase/supabase-js')
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY)

const TEST_PHONE = '593000099002'
const TEST_NAME  = 'Rodrigo Maldonado TEST'

// ── Colours ──────────────────────────────────────────────────────────────────
const C = {
  reset: '\x1b[0m', bold: '\x1b[1m',
  cyan: '\x1b[36m', green: '\x1b[32m', yellow: '\x1b[33m',
  red: '\x1b[31m',  grey: '\x1b[90m',  blue: '\x1b[34m',
}

const results = []
function pass(label) {
  results.push({ label, ok: true })
  origLog(`  ${C.green}✓${C.reset} ${label}`)
}
function fail(label, reason = '') {
  results.push({ label, ok: false, reason })
  origLog(`  ${C.red}✗${C.reset} ${label}${reason ? ` — ${C.yellow}${reason}${C.reset}` : ''}`)
}

// ── Log interceptor ───────────────────────────────────────────────────────────
let capturedLogs = []
const origLog  = console.log.bind(console)
const origWarn = console.warn.bind(console)
function startCapture() { capturedLogs = [] }
function interceptLog(level, ...args) {
  const line = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ')
  capturedLogs.push(line)
  if (level === 'log') origLog(...args)
  else origWarn(...args)
}
console.log  = (...a) => interceptLog('log',  ...a)
console.warn = (...a) => interceptLog('warn', ...a)
function logged(s) { return capturedLogs.some(l => l.includes(s)) }

// ── send helper ───────────────────────────────────────────────────────────────
async function send(label, message, { expectInLog = [], expectNotInLog = [], expectInReply = [], expectNotInReply = [] } = {}) {
  console.log  = (...a) => interceptLog('log',  ...a)
  console.warn = (...a) => interceptLog('warn', ...a)
  startCapture()

  origLog(`\n${C.cyan}${C.bold}[${label}]${C.reset} ${C.cyan}Customer:${C.reset} ${JSON.stringify(message.substring(0, 120))}`)
  const { reply, needsHandoff, needsPaymentHandoff } = await processMessage(TEST_PHONE, message, TEST_NAME)
  origLog(`${C.blue}        Bot:${C.reset} ${reply.substring(0, 200)}${reply.length > 200 ? '…' : ''}`)
  if (needsPaymentHandoff) origLog(`${C.yellow}        ⚡ HANDOFF_PAYMENT${C.reset}`)
  else if (needsHandoff)   origLog(`${C.yellow}        ⚡ HANDOFF${C.reset}`)

  for (const s of expectInLog)
    logged(s) ? pass(`"${s}" in logs`) : fail(`"${s}" in logs`, 'not found')
  for (const s of expectNotInLog)
    !logged(s) ? pass(`"${s}" NOT in logs`) : fail(`"${s}" NOT in logs`, 'was found (unexpected)')
  for (const s of expectInReply)
    reply.includes(s) ? pass(`"${s}" in reply`) : fail(`"${s}" in reply`, `got: "${reply.substring(0,120)}"`)
  for (const s of expectNotInReply)
    !reply.includes(s) ? pass(`"${s}" NOT in reply`) : fail(`"${s}" NOT in reply`, `found in: "${reply.substring(0,120)}"`)

  return { reply, needsHandoff, needsPaymentHandoff }
}

// ── MAIN ──────────────────────────────────────────────────────────────────────
;(async () => {
  origLog(`\n${C.bold}${'═'.repeat(64)}${C.reset}`)
  origLog(`${C.bold}  Micasa Bot — Rodrigo Maldonado Proactive Geocoding Test${C.reset}`)
  origLog(`${C.bold}${'═'.repeat(64)}${C.reset}`)

  // Full reset
  await supabase.from('customers').upsert({
    phone: TEST_PHONE, name: TEST_NAME,
    pending_order: null, last_delivery_address: null,
    last_delivery_zone: null, last_delivery_distance_km: null,
    last_location_pin: null, last_location_url: null,
    current_session_id: null, session_last_activity_at: null, bot_paused: false
  }, { onConflict: 'phone' })
  await supabase.from('conversations').delete().eq('customer_phone', TEST_PHONE)
  origLog(`${C.grey}  [setup] Full reset done${C.reset}`)

  // ── Step 1 — Rodrigo's EXACT opening message with embedded address ────────
  origLog(`\n${C.bold}── STEP 1: First message with "a la dirección" ─────────────────${C.reset}`)
  origLog(`${C.grey}  (Real message sent by Rodrigo Maldonado on 2026-03-xx)${C.reset}`)
  await send('1/3',
    'Buenos días quisiera por favor pedirle para el domingo dos fanescas con pescado a la dirección Jorge Juan y Mariana de Jesús frente a la panadería Jansel y Gretel, podría por favor mandarme los datos para hacerle la transferencia en la noche, gracias',
    {
      expectInLog: [
        '[proactive-geocode] Address keyword detected',  // regex must fire
      ],
      expectNotInLog: [
        '[proactive-geocode] Geocoding failed',  // geocoder must reach Google (low-conf is OK)
      ],
    }
  )

  // Check DB: raw address must be persisted even when geocode is low-confidence (intersection only).
  // Zone may or may not be set depending on geocode confidence — both are acceptable here.
  origLog(`\n${C.grey}  Checking DB after step 1…${C.reset}`)
  const geo1 = await getCustomerAddress(TEST_PHONE).catch(() => null)
  origLog(`${C.grey}  DB → address="${geo1?.address}" zone=${geo1?.zone} dist=${geo1?.distanceKm}km${C.reset}`)
  geo1?.address
    ? pass(`DB: raw address saved — "${geo1.address.substring(0, 60)}"`)
    : fail(`DB: raw address saved`, 'last_delivery_address is null — address was lost')
  // Zone is a bonus (only set if geocode returned ROOFTOP/RANGE_INTERPOLATED for the intersection)
  origLog(`${C.grey}  (Zone ${geo1?.zone || 'not set'} — OK either way for landmark-only intersection)${C.reset}`)

  // ── Step 2 — Customer confirms delivery ──────────────────────────────────
  origLog(`\n${C.bold}── STEP 2: "Domicilio por favor" ───────────────────────────────${C.reset}`)
  const { reply: step2reply, needsHandoff: step2handoff } = await send('2/3', 'Domicilio por favor', {
    expectNotInReply: ['A confirmar por un asesor', 'asesor confirmará'],
    expectNotInLog:   ['NO-ZONE safety net injected'],
  })
  origLog(`${C.grey}  Full reply:\n${step2reply}${C.reset}`)

  // Bot should ask for house number / building name (the new SISTEMA tag fires here)
  const asksForHouseNumber = /número|edificio|casa|complemento|completa/i.test(step2reply)
  asksForHouseNumber
    ? pass('Bot asks for house number / building name naturally')
    : fail('Bot asks for house number', `got: "${step2reply.substring(0,160)}"`)

  !step2handoff
    ? pass('No HANDOFF at step 2')
    : fail('No HANDOFF at step 2', 'bot escalated before getting house number')

  // ── Step 3 — Customer gives just the house number ────────────────────────
  origLog(`\n${C.bold}── STEP 3: Customer responds with just "E27-48" ────────────────${C.reset}`)
  const { reply: step3reply, needsHandoff: step3handoff } = await send('3/4', 'E27-48', {
    // The supplement combination + re-geocode must fire
    expectInLog:    ['[address-supplement] Re-geocoding combined'],
    // Geocoding must reach Google (low-conf is acceptable for a fake test number)
    expectNotInLog: ['[address-supplement] Geocoding failed'],
  })
  origLog(`${C.grey}  Full reply:\n${step3reply}${C.reset}`)

  // DB: combined address should be saved (zone is set only if geocode was ROOFTOP;
  // a fake test number like "E27-48" returns GEOMETRIC_CENTER → raw saved, zone null).
  origLog(`\n${C.grey}  Checking DB after step 3…${C.reset}`)
  const geo3 = await getCustomerAddress(TEST_PHONE).catch(() => null)
  origLog(`${C.grey}  DB → address="${geo3?.address}" zone=${geo3?.zone} dist=${geo3?.distanceKm}km${C.reset}`)
  geo3?.address?.includes('E27-48')
    ? pass(`DB: combined address saved — "${geo3.address.substring(0, 70)}"`)
    : fail(`DB: combined address saved`, `address is "${geo3?.address}"`)
  origLog(`${C.grey}  (Zone ${geo3?.zone || 'not set'} — expected null for fake test number "E27-48")${C.reset}`)

  // ── Step 4 — Bot should now give a concrete delivery cost ────────────────
  origLog(`\n${C.bold}── STEP 4: Summary with real delivery cost ─────────────────────${C.reset}`)
  const hasDeliveryCost = /\$\s*\d+[\.,]\d{2}/.test(step3reply) || /envío.*\$\d/i.test(step3reply)
  hasDeliveryCost
    ? pass('Reply contains concrete delivery cost after house number provided')
    : fail('Reply contains delivery cost', `got: "${step3reply.substring(0,200)}"`)
  !step3handoff
    ? pass('No HANDOFF — bot resolved delivery cost autonomously')
    : fail('No HANDOFF after supplement', 'bot still escalated for delivery cost')

  // ── Summary ──────────────────────────────────────────────────────────────
  console.log  = origLog
  console.warn = origWarn

  const total  = results.length
  const passed = results.filter(r => r.ok).length
  const failed = results.filter(r => !r.ok)

  origLog(`\n${C.bold}${'═'.repeat(64)}${C.reset}`)
  origLog(`${C.bold}  Results: ${passed}/${total} passed${C.reset}`)
  if (failed.length) {
    origLog(`\n${C.red}${C.bold}  Failed assertions:${C.reset}`)
    failed.forEach(f => origLog(`    ${C.red}✗${C.reset} ${f.label}${f.reason ? ` — ${f.reason}` : ''}`))
  } else {
    origLog(`\n${C.green}${C.bold}  ✅ All assertions passed! Proactive geocoding + supplement flow working.${C.reset}`)
  }
  origLog(`${C.bold}${'═'.repeat(64)}${C.reset}\n`)
  process.exit(failed.length > 0 ? 1 : 0)
})().catch(err => {
  console.error = origWarn
  origWarn(`\n${C.red}FATAL:${C.reset}`, err)
  process.exit(1)
})
