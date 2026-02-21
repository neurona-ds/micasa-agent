const path = require('path')
require('dotenv').config({ path: path.resolve(__dirname, '.env'), override: true })
const readline = require('readline')
const { processMessage } = require('./src/agent')

const TEST_PHONE = process.argv[2] || '593000000001'
const TEST_NAME = process.argv[3] || 'Cliente Test'

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
})

console.log('\n========================================')
console.log('  Micasa Restaurante — Chat Test CLI')
console.log('========================================')
console.log(`Customer : ${TEST_NAME}`)
console.log(`Phone    : ${TEST_PHONE}`)
console.log('Type a message and press Enter. Ctrl+C to exit.')
console.log('----------------------------------------\n')

function prompt() {
  rl.question('You: ', async (input) => {
    const text = input.trim()
    if (!text) return prompt()

    try {
      const { reply, needsHandoff, needsPaymentHandoff } = await processMessage(
        TEST_PHONE,
        text,
        TEST_NAME
      )

      console.log(`\nSofia: ${reply}`)

      if (needsPaymentHandoff) {
        console.log('  ⚡ [HANDOFF_PAYMENT triggered — would route to human agent]')
      } else if (needsHandoff) {
        console.log('  ⚡ [HANDOFF triggered — would route to human agent]')
      }

      console.log()
    } catch (err) {
      console.error('Error:', err.message)
    }

    prompt()
  })
}

prompt()
