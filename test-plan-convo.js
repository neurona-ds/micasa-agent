/**
 * test-plan-convo.js — End-to-end plan conversation through processMessage.
 * Verifies: Claude calls quote_plan, presents the per-delivery breakdown,
 * hands off in the same message, and does NOT send bank details or ask
 * "¿Confirmas tu pedido?". Uses a dedicated TEST_PHONE; Zoho disabled.
 * Run: node test-plan-convo.js
 */
const path = require('path')
require('dotenv').config({ path: path.resolve(__dirname, '.env'), override: true })
delete process.env.ZOHO_CLIENT_ID // disable Zoho for this run

const { processMessage } = require('./src/agent')
const { createClient } = require('@supabase/supabase-js')
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY)

const TEST_PHONE = '593000088000'
const TEST_NAME  = 'PLAN TEST'

async function reset() {
  await supabase.from('customers').upsert({
    phone: TEST_PHONE, name: TEST_NAME, bot_paused: false,
    last_delivery_address: null, last_delivery_zone: null, last_delivery_distance_km: null,
    pending_order: null, last_location_pin: null, last_location_url: null,
    current_session_id: null, session_last_activity_at: null
  }, { onConflict: 'phone' })
  await supabase.from('conversations').delete().eq('customer_phone', TEST_PHONE)
}

async function send(msg) {
  console.log('\n\x1b[36m▶ CLIENTE:\x1b[0m ' + msg)
  const r = await processMessage(TEST_PHONE, msg, TEST_NAME)
  console.log('\x1b[32m◀ BOT:\x1b[0m ' + r.reply + (r.needsHandoff ? '  \x1b[33m[HANDOFF]\x1b[0m' : ''))
  return r
}

;(async () => {
  await reset()
  await send('Hola, quiero un plan semanal de almuerzos a domicilio')
  await send('1 por día está bien')
  const last = await send('Mi dirección es Carlos Montufar 614 y Fernando Ayarza')

  // last reply may already be the breakdown; if bot asked turno, answer and re-send
  let final = last
  if (!/TOTAL/i.test(last.reply)) {
    final = await send('2:30 a 3:30')
  }

  // ── Assertions ──────────────────────────────────────────────────────────────
  const text = final.reply
  const checks = {
    'shows TOTAL $38.75':            /TOTAL[^\n]*38\.75/i.test(text),
    'shows per-delivery shipping':   /Env[ií]o[^\n]*×\s*5/i.test(text) || /×\s*5\s*entregas/i.test(text),
    'hands off':                     final.needsHandoff === true,
    'NO bank details':               !/Pichincha|Produbanco|Cuenta:|transferencia.*\d{6}/i.test(text),
    'NO "Confirmas tu pedido"':      !/Confirmas tu pedido/i.test(text),
    'no payment handoff':            final.needsPaymentHandoff !== true
  }
  console.log('\n' + '='.repeat(56))
  let pass = true
  for (const [k, v] of Object.entries(checks)) {
    console.log(`  ${v ? '\x1b[32m✓' : '\x1b[31m✗'}\x1b[0m ${k}`)
    if (!v) pass = false
  }
  console.log('='.repeat(56))
  console.log(pass ? '\x1b[32mALL CHECKS PASSED\x1b[0m' : '\x1b[31mSOME CHECKS FAILED — review reply above\x1b[0m')
  process.exit(pass ? 0 : 1)
})().catch(e => { console.error('TEST ERROR:', e); process.exit(1) })
