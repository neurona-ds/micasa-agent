'use strict'
const { getDeliveryQuote } = require('./micasaEnvios')
const { getAllConfig } = require('../memory')

/**
 * Compute a prepaid lunch-plan quote.
 *
 * A plan = `totalLunches` lunches delivered UNIFORMLY across `days` delivery days,
 * with `lunchesPerDay` lunches dropped per delivery. Shipping is charged PER
 * delivery day — each day's drop is quoted at `lunchesPerDay` (which is the only
 * place a multi-lunch discount legitimately applies, e.g. 4 lunches in one trip),
 * then summed across all delivery days.
 *
 * This is the single source of truth for plan math. The WhatsApp bot calls it to
 * present a breakdown to the customer; later, the same result object will feed the
 * Zoho Deal record (Almuerzos_Comprados, Amount, etc.). It writes NOTHING to Zoho.
 *
 * Uniform-plan simplification (confirmed business rule): same address, same turno,
 * same lunches-per-day every delivery → every day's delivery cost is identical, so
 * we quote ONE representative day and multiply by `days`.
 *
 * @param {Object}  p
 * @param {number}  p.totalLunches    total lunches in the plan (5, 20, or any N ≥ 1)
 * @param {number} [p.lunchesPerDay]  lunches per delivery day (default 1)
 * @param {string}  p.address         text address or Google Maps URL
 * @param {number} [p.unitPrice]      almuerzo delivery unit price; falls back to config
 * @returns {Promise<Object>} breakdown — see shape below. Always has `ok: boolean`.
 */
async function computePlanQuote({ totalLunches, lunchesPerDay = 1, address, unitPrice }) {
  totalLunches  = Number(totalLunches)
  lunchesPerDay = Number(lunchesPerDay) || 1

  // ── Validation ──────────────────────────────────────────────────────────────
  if (!Number.isFinite(totalLunches) || totalLunches < 1) {
    return { ok: false, error: 'INVALID_TOTAL', message: 'La cantidad total de almuerzos no es válida.' }
  }
  if (lunchesPerDay < 1) lunchesPerDay = 1
  if (lunchesPerDay > totalLunches) {
    return { ok: false, error: 'PER_DAY_EXCEEDS_TOTAL', message: 'Los almuerzos por día no pueden superar el total del plan.' }
  }
  // Uniform distribution requires an even split.
  if (totalLunches % lunchesPerDay !== 0) {
    return {
      ok: false,
      error: 'NON_UNIFORM',
      message: `No se pueden repartir ${totalLunches} almuerzos en grupos iguales de ${lunchesPerDay} por día. Pide al cliente que aclare cuántos por día.`
    }
  }
  const days = totalLunches / lunchesPerDay

  // ── Unit price ──────────────────────────────────────────────────────────────
  if (unitPrice == null) {
    const config = await getAllConfig().catch(() => ({}))
    unitPrice = parseFloat(config.almuerzo_price_delivery || '5.50')
  }

  // ── Per-day delivery cost (uniform → quote one representative delivery) ──────
  const quote = await getDeliveryQuote({
    address,
    orderType: 'almuerzo',
    almuerzoQty: lunchesPerDay,
    subtotal: lunchesPerDay * unitPrice
  })

  if (!quote) {
    return { ok: false, error: 'GEOCODE_FAILED', message: 'No se pudo geocodificar la dirección. Pide una referencia más específica o un pin de Maps.' }
  }
  if (quote.ok === false) {
    const isZone4 = quote.zone === 4 || quote.error === 'ZONE_4_HANDOFF'
    return {
      ok: false,
      error: quote.error || 'QUOTE_ERROR',
      zone: quote.zone ?? null,
      isZone4,
      minOrder: quote.min_order ?? null,
      message: isZone4
        ? 'Dirección fuera del rango de entrega (Zona 4) — requiere cotización manual de un asesor.'
        : (quote.error === 'BELOW_MIN_ORDER'
            ? `El pedido mínimo para este sector es de $${quote.min_order}.`
            : 'No se pudo determinar la zona de entrega para esta dirección.')
    }
  }

  const perDayDelivery = Number(quote.delivery_gross ?? 0)
  const foodTotal     = round2(totalLunches * unitPrice)
  const shippingTotal = round2(perDayDelivery * days)
  const grandTotal    = round2(foodTotal + shippingTotal)

  return {
    ok: true,
    // plan shape
    totalLunches,
    lunchesPerDay,
    days,
    unitPrice: round2(unitPrice),
    // geo
    zone: quote.zone,
    distanceKm: quote.distance_km ?? null,
    perDayDelivery: round2(perDayDelivery),
    // money
    foodTotal,
    shippingTotal,
    grandTotal
  }
}

/**
 * Render a WhatsApp-friendly Spanish breakdown of a successful plan quote.
 * Intentionally does NOT include "¿Confirmas tu pedido?" — plans are finalized by
 * a human, so the bot presents this and then hands off.
 */
function formatPlanBreakdown(q) {
  const perDayLabel = q.lunchesPerDay > 1
    ? `${q.lunchesPerDay} almuerzos/día`
    : `1 almuerzo/día`
  const diasLabel     = q.days === 1 ? 'día' : 'días'
  const entregaLabel  = q.days === 1 ? 'entrega' : 'entregas'
  return [
    `🍱 *Plan de ${q.totalLunches} almuerzos* (${perDayLabel} × ${q.days} ${diasLabel})`,
    ``,
    `Almuerzos: ${q.totalLunches} × $${q.unitPrice.toFixed(2)} = $${q.foodTotal.toFixed(2)}`,
    `Envío: $${q.perDayDelivery.toFixed(2)} × ${q.days} ${entregaLabel} = $${q.shippingTotal.toFixed(2)}`,
    `*TOTAL: $${q.grandTotal.toFixed(2)}*`
  ].join('\n')
}

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100
}

module.exports = { computePlanQuote, formatPlanBreakdown }
