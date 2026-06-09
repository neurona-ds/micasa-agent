'use strict'
// Standalone test for computePlanQuote — validates plan math against the LIVE
// pricing API. Writes nothing to Zoho. Run: node test-plan.js
const path = require('path')
require('dotenv').config({ path: path.resolve(__dirname, '.env'), override: true })
const { computePlanQuote, formatPlanBreakdown } = require('./src/tools/plan')

const ADDRESS = 'Carlos Montufar 614 y Fernando Ayarza' // Xime P.'s real address (Zone 2)

const CASES = [
  { label: "Xime's case: Plan Semanal 5, 1/día × 5 días", totalLunches: 5,  lunchesPerDay: 1 },
  { label: 'Plan Mensual 20, 1/día × 20 días',            totalLunches: 20, lunchesPerDay: 1 },
  { label: 'Plan 20, 4/día × 5 días (multi-lunch/day)',   totalLunches: 20, lunchesPerDay: 4 },
  { label: 'Plan 10, 2/día × 5 días',                     totalLunches: 10, lunchesPerDay: 2 },
  { label: 'Edge: 5 lunches, 2/día (non-uniform)',        totalLunches: 5,  lunchesPerDay: 2 }
]

;(async () => {
  for (const c of CASES) {
    console.log('\n' + '='.repeat(64))
    console.log(c.label)
    console.log('-'.repeat(64))
    const q = await computePlanQuote({
      totalLunches: c.totalLunches,
      lunchesPerDay: c.lunchesPerDay,
      address: ADDRESS
    })
    if (!q.ok) {
      console.log(`  ✗ ok=false  error=${q.error}\n  ${q.message}`)
      continue
    }
    console.log(`  zone=${q.zone}  perDayDelivery=$${q.perDayDelivery}  days=${q.days}`)
    console.log(`  food=$${q.foodTotal}  shipping=$${q.shippingTotal}  TOTAL=$${q.grandTotal}`)
    console.log('\n  ── customer-facing breakdown ──')
    console.log(formatPlanBreakdown(q).split('\n').map(l => '  ' + l).join('\n'))
  }
  console.log('\n' + '='.repeat(64))
})().catch(e => console.error('TEST ERROR:', e))
