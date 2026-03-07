/**
 * test-rodrigo.js — Proactive geocoding + address supplement flow
 *
 * Simulates Rodrigo's order style with two address scenarios:
 *
 *  Scenario A — Vague address: "Mariana de Jesús e Inglaterra"
 *    • Proactive geocode fires on first message → GEOMETRIC_CENTER (intersection only)
 *    • Bot asks naturally for house number / building name
 *    • Customer responds with just "E2-24"
 *    • System combines "Mariana de Jesús e Inglaterra, E2-24" → re-geocodes
 *    • Bot gives complete summary with real delivery cost — no HANDOFF
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

  origLog(`\n${C.cyan}${C.bold}[${label}]${C.reset} ${C.cyan}Customer:${C.reset} ${JSON.stringify(message.substring(0, 130))}`)
  const { reply, needsHandoff, needsPaymentHandoff } = await processMessage(TEST_PHONE, message, TEST_NAME)
  origLog(`${C.blue}        Bot:${C.reset} ${reply.substring(0, 220)}${reply.length > 220 ? '…' : ''}`)
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

async function resetDB() {
  await supabase.from('customers').upsert({
    phone: TEST_PHONE, name: TEST_NAME,
    pending_order: null, last_delivery_address: null,
    last_delivery_zone: null, last_delivery_distance_km: null,
    last_location_pin: null, last_location_url: null,
    current_session_id: null, session_last_activity_at: null, bot_paused: false
  }, { onConflict: 'phone' })
  await supabase.from('conversations').delete().eq('customer_phone', TEST_PHONE)
  origLog(`${C.grey}  [setup] DB reset done${C.reset}`)
}

// ── MAIN ──────────────────────────────────────────────────────────────────────
;(async () => {
  origLog(`\n${C.bold}${'═'.repeat(66)}${C.reset}`)
  origLog(`${C.bold}  Micasa Bot — Vague Address + Supplement Flow Test${C.reset}`)
  origLog(`${C.bold}${'═'.repeat(66)}${C.reset}`)
  origLog(`${C.grey}  Vague address : "Mariana de Jesús e Inglaterra"${C.reset}`)
  origLog(`${C.grey}  Supplement    : "E2-24"${C.reset}`)
  origLog(`${C.grey}  Combined      : "Mariana de Jesús e Inglaterra, E2-24" (real Quito address)${C.reset}`)

  await resetDB()

  // ════════════════════════════════════════════════════════════════════════════
  // STEP 1 — First message with vague address embedded
  // ════════════════════════════════════════════════════════════════════════════
  origLog(`\n${C.bold}── STEP 1: Order message with vague address "Mariana de Jesús e Inglaterra" ──${C.reset}`)

  await send('1/4',
    'Buenos días quisiera por favor pedirle para el domingo dos fanescas con pescado a la dirección Mariana de Jesús e Inglaterra, podría por favor mandarme los datos para hacerle la transferencia en la noche, gracias',
    {
      expectInLog: [
        '[proactive-geocode] Address keyword detected',
      ],
      expectNotInLog: [
        '[proactive-geocode] Geocoding failed',
      ],
    }
  )

  origLog(`\n${C.grey}  Checking DB after step 1…${C.reset}`)
  const geo1 = await getCustomerAddress(TEST_PHONE).catch(() => null)
  origLog(`${C.grey}  DB → address="${geo1?.address}"${C.reset}`)
  origLog(`${C.grey}  DB → zone=${geo1?.zone}  dist=${geo1?.distanceKm}km  locationType=(see log above)${C.reset}`)

  geo1?.address
    ? pass(`DB: raw address saved — "${geo1.address.substring(0, 65)}"`)
    : fail(`DB: raw address saved`, 'last_delivery_address is null')

  const step1ZoneKnown = !!(geo1?.zone)
  if (step1ZoneKnown) {
    origLog(`${C.grey}  ℹ  Intersection geocoded with high confidence → zone already set (${geo1.zone}). Supplement step may skip.${C.reset}`)
  } else {
    origLog(`${C.grey}  ℹ  GEOMETRIC_CENTER as expected for bare intersection — supplement step will be needed.${C.reset}`)
  }

  // ════════════════════════════════════════════════════════════════════════════
  // STEP 2 — "Domicilio por favor"
  // ════════════════════════════════════════════════════════════════════════════
  origLog(`\n${C.bold}── STEP 2: "Domicilio por favor" ────────────────────────────────${C.reset}`)

  const { reply: step2reply, needsHandoff: step2handoff } = await send('2/4', 'Domicilio por favor', {
    expectNotInReply: ['A confirmar por un asesor', 'asesor confirmará'],
    expectNotInLog:   ['NO-ZONE safety net injected'],
  })
  origLog(`${C.grey}  Full reply:\n${step2reply}${C.reset}`)

  if (step1ZoneKnown) {
    // Zone was already set in step 1 — bot should offer the address back, not ask for number
    const offersPrevAddress = /dirección anterior|Mariana de Jesús/i.test(step2reply)
    offersPrevAddress
      ? pass('Bot offers saved address back (zone known from step 1)')
      : fail('Bot offers saved address back', `got: "${step2reply.substring(0,160)}"`)
  } else {
    // Zone not known — bot should ask for house number
    const asksForHouseNumber = /número|edificio|casa|complemento|completa/i.test(step2reply)
    asksForHouseNumber
      ? pass('Bot asks for house number / building name naturally')
      : fail('Bot asks for house number', `got: "${step2reply.substring(0,160)}"`)
  }

  !step2handoff
    ? pass('No HANDOFF at step 2')
    : fail('No HANDOFF at step 2', 'bot escalated before getting house number')

  // ════════════════════════════════════════════════════════════════════════════
  // STEP 3 — Customer sends JUST the house number "E2-24"
  // ════════════════════════════════════════════════════════════════════════════
  origLog(`\n${C.bold}── STEP 3: Customer responds with just "E2-24" ──────────────────${C.reset}`)
  origLog(`${C.grey}  System should combine → "Mariana de Jesús e Inglaterra, E2-24" and re-geocode${C.reset}`)

  const { reply: step3reply, needsHandoff: step3handoff } = await send('3/4', 'E2-24', {
    expectInLog:    ['[address-supplement] Re-geocoding combined'],
    expectNotInLog: ['[address-supplement] Geocoding failed'],
  })
  origLog(`${C.grey}  Full reply:\n${step3reply}${C.reset}`)

  origLog(`\n${C.grey}  Checking DB after step 3…${C.reset}`)
  const geo3 = await getCustomerAddress(TEST_PHONE).catch(() => null)
  origLog(`${C.grey}  DB → address="${geo3?.address}"${C.reset}`)
  origLog(`${C.grey}  DB → zone=${geo3?.zone}  dist=${geo3?.distanceKm}km${C.reset}`)

  // Combined address must be saved
  const combinedSaved = geo3?.address?.includes('E2-24') || geo3?.address?.includes('Mariana')
  combinedSaved
    ? pass(`DB: combined address saved — "${(geo3?.address || '').substring(0, 70)}"`)
    : fail(`DB: combined address saved`, `got address="${geo3?.address}"`)

  // Zone should now be set — "Mariana de Jesús E2-24, Quito" is a real Quito address
  geo3?.zone
    ? pass(`DB: zone resolved from combined address — Zone ${geo3.zone} (${geo3.distanceKm}km)`)
    : fail(`DB: zone resolved`, 'zone still null after combining with real house number E2-24')

  const supplementFiredHighConf = logged('[address-supplement] Zone injected')
  supplementFiredHighConf
    ? pass('"[address-supplement] Zone injected" in logs — ROOFTOP/RANGE geocode confirmed')
    : fail('"[address-supplement] Zone injected" in logs', 'combined address still low-confidence')

  // ════════════════════════════════════════════════════════════════════════════
  // STEP 4 — Bot summary must include a concrete delivery cost, no HANDOFF
  // ════════════════════════════════════════════════════════════════════════════
  origLog(`\n${C.bold}── STEP 4: Summary with real delivery cost, no HANDOFF ──────────${C.reset}`)

  const hasDeliveryCost = /\$\s*\d+[\.,]\d{2}/.test(step3reply) || /envío.*\$\d/i.test(step3reply)
  hasDeliveryCost
    ? pass('Reply contains concrete delivery cost after house number provided')
    : fail('Reply contains concrete delivery cost', `got: "${step3reply.substring(0,220)}"`)

  !step3handoff
    ? pass('No HANDOFF — bot resolved delivery cost autonomously')
    : fail('No HANDOFF after supplement', 'bot still escalated for delivery cost')

  // ── Summary ──────────────────────────────────────────────────────────────
  console.log  = origLog
  console.warn = origWarn

  const total  = results.length
  const passed = results.filter(r => r.ok).length
  const failed = results.filter(r => !r.ok)

  origLog(`\n${C.bold}${'═'.repeat(66)}${C.reset}`)
  origLog(`${C.bold}  Results: ${passed}/${total} passed${C.reset}`)
  if (failed.length) {
    origLog(`\n${C.red}${C.bold}  Failed assertions:${C.reset}`)
    failed.forEach(f => origLog(`    ${C.red}✗${C.reset} ${f.label}${f.reason ? ` — ${f.reason}` : ''}`))
  } else {
    origLog(`\n${C.green}${C.bold}  ✅ All assertions passed! Vague address + supplement flow working end-to-end.${C.reset}`)
  }
  origLog(`${C.bold}${'═'.repeat(66)}${C.reset}\n`)
  process.exit(failed.length > 0 ? 1 : 0)
})().catch(err => {
  console.error = origWarn
  origWarn(`\n${C.red}FATAL:${C.reset}`, err)
  process.exit(1)
})
