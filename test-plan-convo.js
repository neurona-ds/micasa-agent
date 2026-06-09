/**
 * test-plan-convo.js — End-to-end plan flow through processMessage, now mirroring
 * a regular almuerzo order: summary → "¿Confirmas tu pedido?" → bank details →
 * comprobante → creates a Zoho DEAL (not Planificacion_de_Entregas).
 *
 * All Zoho HTTP writes are intercepted — NO real CRM records are created.
 * Run: node test-plan-convo.js
 */
const path = require('path')
require('dotenv').config({ path: path.resolve(__dirname, '.env'), override: true })

// ── Intercept Zoho CRM writes (let OAuth + reads through) ───────────────────
const axios = require('axios')
const realPost = axios.post.bind(axios)
const zohoPosts = []
axios.post = async (url, body, cfg) => {
  if (url.includes('/oauth/')) return realPost(url, body, cfg)
  if (url.includes('/crm/v2/')) {
    const module = url.split('/crm/v2/')[1]
    zohoPosts.push({ module, record: body?.data?.[0] })
    return { data: { data: [{ code: 'SUCCESS', details: { id: 'DRYRUN_' + module } }] } }
  }
  return realPost(url, body, cfg)
}

const { processMessage, triggerZohoOnPayment } = require('./src/agent')
const { getPendingOrder } = require('./src/memory')
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
  console.log('\x1b[32m◀ BOT:\x1b[0m ' + r.reply.slice(0, 500) + (r.needsHandoff ? '  \x1b[33m[HANDOFF]\x1b[0m' : ''))
  return r
}

;(async () => {
  await reset()
  await send('Hola, quiero un plan semanal de almuerzos a domicilio')
  await send('1 por día, turno de 2:30')
  let summary = await send('Carlos Montufar 614 y Fernando Ayarza')
  if (!/TOTAL/i.test(summary.reply)) summary = await send('2:30 a 3:30')

  const confirm = await send('Sí, confirmo')
  // Read snapshot after confirm (savePendingOrder is non-blocking; settled by now).
  const pend = await getPendingOrder(TEST_PHONE)

  // Simulate the customer sending the payment screenshot → Zoho fires.
  console.log('\n\x1b[36m▶ [comprobante image received] → triggerZohoOnPayment\x1b[0m')
  await triggerZohoOnPayment(TEST_PHONE, TEST_NAME)
  await new Promise(r => setTimeout(r, 1500)) // let non-blocking Zoho call resolve

  const dealPost = zohoPosts.find(p => p.module === 'Deals')
  const peName = zohoPosts.find(p => p.module && p.module.includes('Planificacion'))

  // ── Assertions ──────────────────────────────────────────────────────────────
  const checks = {
    'summary shows TOTAL $38.75':         /TOTAL[^\n]*38\.75/i.test(summary.reply),
    'summary asks "Confirmas tu pedido"': /Confirmas tu pedido/i.test(summary.reply),
    'NO handoff at quote stage':          summary.needsHandoff === false,
    'pending_order.orderType === plan':   pend?.orderType === 'plan',
    'pending_order.total === 38.75':      pend?.total === 38.75,
    'pending_order.cantidad === 5':       pend?.cantidad === 5,
    'confirm → bank details sent':        /Pichincha|Produbanco|transferir/i.test(confirm.reply),
    'Zoho wrote a DEAL':                  !!dealPost,
    'Deal Stage = Pendiente de Pago':     dealPost?.record?.Stage === 'Pendiente de Pago',
    'Deal Amount = 38.75':                dealPost?.record?.Amount === 38.75,
    'Deal Tipo_de_Plan = Plan Semanal 5': dealPost?.record?.Tipo_de_Plan === 'Plan Semanal 5',
    'Deal Almuerzos_Comprados = 5':       dealPost?.record?.Almuerzos_Comprados === 5,
    'did NOT write a Planificacion rec':  !peName
  }
  console.log('\n' + '='.repeat(56))
  let pass = true
  for (const [k, v] of Object.entries(checks)) {
    console.log(`  ${v ? '\x1b[32m✓' : '\x1b[31m✗'}\x1b[0m ${k}`)
    if (!v) pass = false
  }
  console.log('='.repeat(56))
  console.log(pass ? '\x1b[32mALL CHECKS PASSED\x1b[0m' : '\x1b[31mSOME CHECKS FAILED\x1b[0m')
  process.exit(pass ? 0 : 1)
})().catch(e => { console.error('TEST ERROR:', e); process.exit(1) })
