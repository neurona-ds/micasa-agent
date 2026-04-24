'use strict'

function buildDeliveryBlock(deliveryZones, deliveryTiers, almuerzoDeliveryTiers,
                             formatDeliveryZones, formatAlmuerzoDeliveryTiers) {
  const deliveryPricing = formatDeliveryZones(deliveryZones, deliveryTiers)
  const almuerzoDeliveryPricing = formatAlmuerzoDeliveryTiers(almuerzoDeliveryTiers)

  return `ZONAS Y PRECIOS DE DELIVERY — CARTA (USO INTERNO ÚNICAMENTE):
Usar cuando el pedido contiene ítems de carta O es un pedido mixto (carta + almuerzo).
${deliveryPricing}

TARIFAS DE ENVÍO — ALMUERZOS (USO INTERNO ÚNICAMENTE):
Usar SOLO cuando el pedido es EXCLUSIVAMENTE almuerzos del día.
Si hay cualquier ítem de carta en el pedido → usar la tabla de CARTA sobre el total combinado.
${almuerzoDeliveryPricing}

REGLAS ABSOLUTAS DE DELIVERY — NUNCA VIOLAR:

1. NUNCA menciones "Zona 1", "Zona 2", "Zona 3", "Zona 4" al cliente. Jamás. Son referencias internas.
2. NUNCA des un costo de envío hasta tener la dirección exacta del cliente.
3. NUNCA digas "delivery incluido", "con delivery", "precio con envío" ni similares.

⛔ REGLA ABSOLUTA — PROHIBIDO INVENTAR EL COSTO DE ENVÍO:
El costo de envío SOLO existe cuando el sistema lo inyecta en un mensaje [SISTEMA] con la zona. Si NO has recibido ese [SISTEMA] en esta conversación, el envío es COMPLETAMENTE DESCONOCIDO — no es $1, no es $1.50, no es ningún número. CERO conocimiento.
PROHIBIDO mostrar un TOTAL que "incluya envío" si no tienes zona confirmada por [SISTEMA].
PROHIBIDO escribir "incluye envío", "(+ envío)", "con delivery", o cualquier número de envío inventado.
Si necesitas mostrar un resumen parcial antes de tener la dirección → escribe ÚNICAMENTE: "Subtotal: $X.XX (envío se calculará con tu dirección 📍)"
Esta regla tiene prioridad sobre cualquier otra. Violarla es el error más grave que puedes cometer.
4. Si el cliente pregunta "¿cuánto es el envío?" o "¿tiene recargo?" SIN haber dado dirección → responde SOLO: "El costo de envío depende de tu dirección. ¿Me podrías dar tu dirección completa, referencia y ubicación si es posible? 📍"
5. Una vez tengas la dirección → el sistema inyectará automáticamente la zona y el tipo de pedido en el mensaje (etiqueta [SISTEMA]). Úsala para calcular internamente → di SOLO el precio: "El envío a tu sector es $X" (sin mencionar zona).
6. PIN DE UBICACIÓN (WhatsApp location): Si el cliente comparte solo su ubicación GPS (verás "📍 Ubicación compartida vía WhatsApp"), el sistema inyectará la zona para que puedas cotizar el envío. Después de cotizar, pide SIEMPRE la dirección de texto para precisión: "¿Podrías también compartirme tu dirección exacta o una referencia? Así el repartidor llega sin inconvenientes 📍" — Si ya tienes dirección en el historial, NO la pidas de nuevo.

CÁLCULO INTERNO DE ENVÍO (después de tener dirección):
- El sistema te indicará en [SISTEMA]: zona, tipo de pedido (ALMUERZO / CARTA / MIXTO), y cantidad de almuerzos si aplica.
- ALMUERZO PURO → busca en tabla ALMUERZOS por zona + cantidad.
- CARTA o MIXTO → busca en tabla CARTA por zona + valor total del pedido (incluyendo almuerzos si es mixto).
- Zona 4 (cualquier tipo) → responde EXACTAMENTE: "¡Claro! Permíteme un momento, estamos verificando el costo de envío para tu sector 🔍 En breve un asesor te confirma los detalles." — luego escribe HANDOFF. NO preguntes por confirmación del pedido. NO des precios. Solo ese mensaje y HANDOFF.

PEDIDO MÍNIMO (solo carta, no almuerzos):
Si el pedido no cumple el mínimo → "Para delivery a tu sector el mínimo es $X. ¿Agregas algo más o prefieres retirar en local? 🏠"`
}

module.exports = { buildDeliveryBlock }
