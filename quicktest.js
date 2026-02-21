const path = require('path')
require('dotenv').config({ path: path.resolve(__dirname, '.env'), override: true })
const { processMessage } = require('./src/agent')

async function test() {

  console.log('\n=== Test A: Plato fuerte → upsell juice ===')
  const r1 = await processMessage('593000000081', 'Hola! quiero un Churrasco de Carne')
  console.log('Bot:', r1.reply)

  console.log('\n=== Test A2: Customer says no to juice → continue flow ===')
  const r1b = await processMessage('593000000081', 'no gracias, solo el churrasco')
  console.log('Bot:', r1b.reply)

  console.log('\n=== Test B: Almuerzo only → NO upsell ===')
  const r2 = await processMessage('593000000082', 'quiero un almuerzo del lunes')
  console.log('Bot:', r2.reply)

  console.log('\n=== Test C: Sopa de carta → upsell juice ===')
  const r3 = await processMessage('593000000083', 'me da una Sopa de Quinoa')
  console.log('Bot:', r3.reply)

  console.log('\n=== Test D: Plato + already has bebida → NO upsell ===')
  const r4 = await processMessage('593000000084', 'quiero un Pollo BBQ y un Jugo Natural')
  console.log('Bot:', r4.reply)
}

test().catch(console.error)
