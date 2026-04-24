'use strict'
const path = require('path')
require('dotenv').config({ path: path.resolve(__dirname, '../../.env'), override: true })
const { createClient } = require('@supabase/supabase-js')

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
)

const DEFAULTS = {
  geocode_clarification_pending: false,
  house_number_pending: false
}

async function getFlags(phone) {
  try {
    const { data, error } = await supabase
      .from('bot_flags')
      .select('geocode_clarification_pending, house_number_pending')
      .eq('phone', phone)
      .single()
    if (error || !data) return { ...DEFAULTS }
    return data
  } catch {
    return { ...DEFAULTS }
  }
}

async function setFlag(phone, key, value) {
  try {
    await supabase.from('bot_flags').upsert(
      { phone, [key]: value, updated_at: new Date().toISOString() },
      { onConflict: 'phone' }
    )
  } catch (e) {
    console.warn(`[flags] setFlag failed (${key}=${value}):`, e.message)
  }
}

async function clearFlags(phone) {
  try {
    await supabase.from('bot_flags').upsert(
      {
        phone,
        geocode_clarification_pending: false,
        house_number_pending: false,
        updated_at: new Date().toISOString()
      },
      { onConflict: 'phone' }
    )
  } catch (e) {
    console.warn('[flags] clearFlags failed:', e.message)
  }
}

module.exports = { getFlags, setFlag, clearFlags }
