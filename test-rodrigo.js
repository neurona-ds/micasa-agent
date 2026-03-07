/**
 * test-rodrigo.js — Proactive geocoding + address supplement flow
 *
 * Three scenarios testing all reply formats after the bot asks for a house number:
 *
 *  Scenario A — Short code reply: "E2-24"
 *    • Direct geocode of bare code fails → combined with base → ROOFTOP
 *    • Logs: [house-number-reply] Combined geocode succeeded
 *
 *  Scenario B — Partial address reply: "Mariana de Jesús E2-24"
 *    • Direct geocode of partial address → ROOFTOP directly
 *    • Logs: [house-number-reply] Direct geocode succeeded
 *
 *  Scenario C — Full address reply: "Av. Mariana de Jesús E2-24 y 6 de Diciembre"
 *    • Direct geocode of full address → ROOFTOP directly
 *    • Logs: [house-number-reply] Direct geocode succeeded
 *
 * All scenarios share the same preamble:
 *   Step 1: Order message with vague address "Mariana de Jesús e Inglaterra"
 *            → proactive geocode fires → GEOMETRIC_CENTER → raw address saved
 *   Step 2: "Domicilio por favor" → bot asks for house number / building name
 *   Step 3: Customer replies with the supplement (varies by scenario)
 *            → zone resolved → delivery cost in reply → no HANDOFF
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
  magenta: '\x1b[35m',
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

// ── Shared scenario runner ────────────────────────────────────────────────────
// Each scenario: Step1 (order + vague address) → Step2 (delivery) → Step3 (supplement)
// expectedPath: 'combined' (short code → direct fails → combined) | 'direct' (partial/full)
async function runScenario(label, supplementMsg, expectedPath) {
  origLog(`\n${C.magenta}${C.bold}${'─'.repeat(66)}${C.reset}`)
  origLog(`${C.magenta}${C.bold}  Scenario ${label}: supplement = ${JSON.stringify(supplementMsg)}${C.reset}`)
  origLog(`${C.magenta}${C.bold}  Expected path: ${expectedPath}${C.reset}`)
  origLog(`${C.magenta}${C.bold}${'─'.repeat(66)}${C.reset}`)

  await resetDB()

  // ── Step 1: Order message with vague address embedded ──────────────────────
  origLog(`\n${C.bold}── ${label}/S1: Order message with vague address ──${C.reset}`)

  await send(`${label}/S1`,
    'Buenos días quisiera por favor pedirle para el domingo dos fanescas con pescado a la dirección Mariana de Jesús e Inglaterra, podría por favor mandarme los datos para hacerle la transferencia en la noche, gracias',
    {
      expectInLog: ['[proactive-geocode] Address keyword detected'],
      expectNotInLog: ['[proactive-geocode] Geocoding failed'],
    }
  )

  origLog(`\n${C.grey}  Checking DB after ${label}/S1…${C.reset}`)
  const geo1 = await getCustomerAddress(TEST_PHONE).catch(() => null)
  origLog(`${C.grey}  DB → address="${geo1?.address}"${C.reset}`)
  origLog(`${C.grey}  DB → zone=${geo1?.zone}  dist=${geo1?.distanceKm}km${C.reset}`)

  geo1?.address
    ? pass(`${label}: DB raw address saved — "${geo1.address.substring(0, 65)}"`)
    : fail(`${label}: DB raw address saved`, 'last_delivery_address is null')

  const step1ZoneKnown = !!(geo1?.zone)
  if (step1ZoneKnown) {
    origLog(`${C.grey}  ℹ  Intersection geocoded high-conf → zone already set (${geo1.zone}). House-number step may skip.${C.reset}`)
  } else {
    origLog(`${C.grey}  ℹ  GEOMETRIC_CENTER as expected — house-number supplement step will be needed.${C.reset}`)
  }

  // ── Step 2: "Domicilio por favor" ─────────────────────────────────────────
  origLog(`\n${C.bold}── ${label}/S2: "Domicilio por favor" ──${C.reset}`)

  const { reply: step2reply, needsHandoff: step2handoff } = await send(`${label}/S2`, 'Domicilio por favor', {
    expectNotInReply: ['A confirmar por un asesor', 'asesor confirmará'],
    expectNotInLog:   ['NO-ZONE safety net injected'],
  })
  origLog(`${C.grey}  Full reply:\n${step2reply}${C.reset}`)

  if (step1ZoneKnown) {
    const offersPrevAddress = /dirección anterior|Mariana de Jesús/i.test(step2reply)
    offersPrevAddress
      ? pass(`${label}: Bot offers saved address back (zone known from S1)`)
      : fail(`${label}: Bot offers saved address back`, `got: "${step2reply.substring(0,160)}"`)
  } else {
    const asksForHouseNumber = /número|edificio|casa|complemento|completa/i.test(step2reply)
    asksForHouseNumber
      ? pass(`${label}: Bot asks for house number / building name naturally`)
      : fail(`${label}: Bot asks for house number`, `got: "${step2reply.substring(0,160)}"`)
  }

  !step2handoff
    ? pass(`${label}: No HANDOFF at S2`)
    : fail(`${label}: No HANDOFF at S2`, 'bot escalated before getting house number')

  // ── Step 3: Customer replies with the supplement ──────────────────────────
  origLog(`\n${C.bold}── ${label}/S3: Customer replies with ${JSON.stringify(supplementMsg)} ──${C.reset}`)
  if (expectedPath === 'combined') {
    origLog(`${C.grey}  Expected: direct fails → combined "${geo1?.address || 'Mariana de Jesús e Inglaterra'}, ${supplementMsg}"${C.reset}`)
  } else {
    origLog(`${C.grey}  Expected: direct geocode of "${supplementMsg}" → ROOFTOP${C.reset}`)
  }

  const step3Expectations = {
    expectInLog:    ['[house-number-reply] Geocoding response'],
    expectNotInLog: ['[address-supplement] Re-geocoding combined'],  // should NOT fall back to old supplement path
  }
  if (expectedPath === 'combined') {
    step3Expectations.expectInLog.push('[house-number-reply] Combined geocode succeeded')
    step3Expectations.expectNotInLog.push('[house-number-reply] Both geocodes low-conf')
  } else {
    step3Expectations.expectInLog.push('[house-number-reply] Direct geocode succeeded')
    step3Expectations.expectNotInLog.push('[house-number-reply] Direct low-conf/null')
  }

  const { reply: step3reply, needsHandoff: step3handoff } = await send(`${label}/S3`, supplementMsg, step3Expectations)
  origLog(`${C.grey}  Full reply:\n${step3reply}${C.reset}`)

  origLog(`\n${C.grey}  Checking DB after ${label}/S3…${C.reset}`)
  const geo3 = await getCustomerAddress(TEST_PHONE).catch(() => null)
  origLog(`${C.grey}  DB → address="${geo3?.address}"${C.reset}`)
  origLog(`${C.grey}  DB → zone=${geo3?.zone}  dist=${geo3?.distanceKm}km${C.reset}`)

  // Address must include something recognizable from the supplement or base
  const addressSaved = geo3?.address?.includes('E2-24') ||
    geo3?.address?.toLowerCase().includes('mariana') ||
    geo3?.address?.toLowerCase().includes('6 de diciembre')
  addressSaved
    ? pass(`${label}: DB address saved after supplement — "${(geo3?.address || '').substring(0, 70)}"`)
    : fail(`${label}: DB address saved after supplement`, `got address="${geo3?.address}"`)

  // Zone must now be set
  geo3?.zone
    ? pass(`${label}: DB zone resolved — Zone ${geo3.zone} (${geo3.distanceKm}km)`)
    : fail(`${label}: DB zone resolved`, 'zone still null after supplement reply')

  // Reply must contain a concrete delivery cost
  const hasDeliveryCost = /\$\s*\d+[\.,]\d{2}/.test(step3reply) || /envío.*\$\d/i.test(step3reply)
  hasDeliveryCost
    ? pass(`${label}: Reply contains concrete delivery cost`)
    : fail(`${label}: Reply contains concrete delivery cost`, `got: "${step3reply.substring(0,220)}"`)

  !step3handoff
    ? pass(`${label}: No HANDOFF — bot resolved delivery cost autonomously`)
    : fail(`${label}: No HANDOFF after supplement`, 'bot still escalated for delivery cost')
}

// ── MAIN ──────────────────────────────────────────────────────────────────────
;(async () => {
  origLog(`\n${C.bold}${'═'.repeat(66)}${C.reset}`)
  origLog(`${C.bold}  Micasa Bot — House Number Reply Flow — All 3 Formats${C.reset}`)
  origLog(`${C.bold}${'═'.repeat(66)}${C.reset}`)
  origLog(`${C.grey}  Vague base address: "Mariana de Jesús e Inglaterra" (GEOMETRIC_CENTER)${C.reset}`)
  origLog(`${C.grey}  Scenario A: short code    → "E2-24"${C.reset}`)
  origLog(`${C.grey}  Scenario B: partial addr  → "Mariana de Jesús E2-24"${C.reset}`)
  origLog(`${C.grey}  Scenario C: full address  → "Av. Mariana de Jesús E2-24 y 6 de Diciembre"${C.reset}`)

  // ── Scenario A: short code "E2-24" → direct fails → combined succeeds ────
  await runScenario('A', 'E2-24', 'combined')

  // ── Scenario B: partial address → direct geocode succeeds ─────────────────
  await runScenario('B', 'Mariana de Jesús E2-24', 'direct')

  // ── Scenario C: full address → direct geocode succeeds ────────────────────
  await runScenario('C', 'Av. Mariana de Jesús E2-24 y 6 de Diciembre', 'direct')

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
    origLog(`\n${C.green}${C.bold}  ✅ All assertions passed! All 3 reply formats working end-to-end.${C.reset}`)
  }
  origLog(`${C.bold}${'═'.repeat(66)}${C.reset}\n`)
  process.exit(failed.length > 0 ? 1 : 0)
})().catch(err => {
  console.error = origWarn
  origWarn(`\n${C.red}FATAL:${C.reset}`, err)
  process.exit(1)
})
