const path = require('path')
require('dotenv').config({ path: path.resolve(__dirname, '../.env'), override: true })
const { createClient } = require('@supabase/supabase-js')

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
)

// Save a message to the conversation history
async function saveMessage(customerPhone, role, message) {
  const { error } = await supabase
    .from('conversations')
    .insert({ customer_phone: customerPhone, role, message })

  if (error) console.error('Error saving message:', error)
}

// Get last 20 messages for a customer (newest first, then reversed to chronological order)
async function getHistory(customerPhone) {
  const { data, error } = await supabase
    .from('conversations')
    .select('role, message')
    .eq('customer_phone', customerPhone)
    .order('timestamp', { ascending: false })
    .limit(20)

  if (error) {
    console.error('Error fetching history:', error)
    return []
  }

  // Reverse so messages are in chronological order (oldest → newest)
  return (data || []).reverse()
}

// Save or update customer info
async function upsertCustomer(phone, name = null) {
  const { error } = await supabase
    .from('customers')
    .upsert({ phone, name }, { onConflict: 'phone' })

  if (error) console.error('Error upserting customer:', error)
}

// Get system prompt from config table
async function getSystemPrompt() {
  const { data, error } = await supabase
    .from('config')
    .select('value')
    .eq('key', 'system_prompt')
    .single()

  if (error) {
    console.error('Error fetching system prompt:', error)
    return null
  }

  return data.value
}

// Get a single config value by key
async function getConfig(key) {
  const { data, error } = await supabase
    .from('config')
    .select('value')
    .eq('key', key)
    .single()

  if (error) {
    console.error(`Error fetching config key "${key}":`, error)
    return null
  }

  return data.value
}

// Get all config keys at once, returns a key/value object
async function getAllConfig() {
  const { data, error } = await supabase
    .from('config')
    .select('key, value')

  if (error) {
    console.error('Error fetching all config:', error)
    return {}
  }

  return data.reduce((acc, row) => {
    acc[row.key] = row.value
    return acc
  }, {})
}

// Get all available products grouped by category
async function getProducts() {
  const { data, error } = await supabase
    .from('products')
    .select('name, description, price, category')
    .eq('available', true)
    .order('category')
    .order('sort_order')

  if (error) {
    console.error('Error fetching products:', error)
    return []
  }

  return data
}

// Get all available delivery zones with neighborhood info
async function getDeliveryZones() {
  const { data, error } = await supabase
    .from('delivery_zones')
    .select('zone_number, label, price, min_order, neighborhoods, requires_approval')
    .eq('available', true)
    .order('sort_order')

  if (error) {
    console.error('Error fetching delivery zones:', error)
    return []
  }

  return data
}

// Get delivery tiers (order-value based pricing per zone)
async function getDeliveryTiers() {
  const { data, error } = await supabase
    .from('delivery_tiers')
    .select('zone_number, order_min, order_max, delivery_price')
    .order('zone_number')
    .order('sort_order')

  if (error) {
    console.error('Error fetching delivery tiers:', error)
    return []
  }

  return data
}

// Auto-advance cycle every Monday, updates config if a new week has started
async function advanceCycleIfNeeded() {
  try {
    const { data, error } = await supabase
      .from('config')
      .select('key, value')
      .in('key', ['current_cycle', 'cycle_last_updated', 'almuerzo_cycle_count'])

    if (error) throw error

    const cfg = data.reduce((acc, row) => { acc[row.key] = row.value; return acc }, {})

    const cycleCount = parseInt(cfg.almuerzo_cycle_count || '5')
    const currentCycle = parseInt(cfg.current_cycle || '1')
    const lastUpdated = cfg.cycle_last_updated ? new Date(cfg.cycle_last_updated) : null

    // Calculate most recent Monday
    const now = new Date()
    const dayOfWeek = now.getDay() // 0=Sun, 1=Mon...
    const daysSinceMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1
    const thisMonday = new Date(now)
    thisMonday.setDate(now.getDate() - daysSinceMonday)
    thisMonday.setHours(0, 0, 0, 0)

    // If last update was before this Monday, advance the cycle
    if (!lastUpdated || lastUpdated < thisMonday) {
      const newCycle = (currentCycle % cycleCount) + 1
      const newDate = thisMonday.toISOString().split('T')[0]

      await supabase.from('config').upsert([
        { key: 'current_cycle', value: String(newCycle) },
        { key: 'cycle_last_updated', value: newDate }
      ], { onConflict: 'key' })

      console.log(`Cycle auto-advanced: C${currentCycle} → C${newCycle} (week of ${newDate})`)
      return newCycle
    }

    return currentCycle
  } catch (e) {
    console.error('Error advancing cycle:', e.message)
    return null
  }
}

// Get full week almuerzo menu for current cycle (all 5 days)
async function getWeekAlmuerzos(currentCycle) {
  try {
    const { data, error } = await supabase
      .from('almuerzos')
      .select('day_of_week, soup, main')
      .eq('cycle', currentCycle)
      .eq('available', true)
      .order('day_of_week')

    if (error) {
      console.error('Error fetching week almuerzos:', error.message)
      return []
    }

    return data
  } catch (e) {
    console.error('Error in getWeekAlmuerzos:', e.message)
    return []
  }
}

// Get all active payment methods
async function getPaymentMethods() {
  const { data, error } = await supabase
    .from('payment_methods')
    .select('bank, account_type, account_number, account_holder, cedula')
    .eq('available', true)
    .order('sort_order')

  if (error) {
    console.error('Error fetching payment methods:', error)
    return []
  }

  return data
}

// Check if bot is paused for a customer
async function isBotPaused(phone) {
  const { data, error } = await supabase
    .from('customers')
    .select('bot_paused')
    .eq('phone', phone)
    .single()

  if (error || !data) return false
  return data.bot_paused === true
}

// Pause bot for a customer (human takeover)
async function pauseBot(phone) {
  const { error } = await supabase
    .from('customers')
    .update({ bot_paused: true })
    .eq('phone', phone)

  if (error) console.error('Error pausing bot:', error)
}

// Resume bot for a customer
async function resumeBot(phone) {
  const { error } = await supabase
    .from('customers')
    .update({ bot_paused: false })
    .eq('phone', phone)

  if (error) console.error('Error resuming bot:', error)
}

module.exports = {
  saveMessage,
  getHistory,
  upsertCustomer,
  getSystemPrompt,
  getConfig,
  getAllConfig,
  getProducts,
  getDeliveryZones,
  getDeliveryTiers,
  advanceCycleIfNeeded,
  getWeekAlmuerzos,
  getPaymentMethods,
  isBotPaused,
  pauseBot,
  resumeBot
}