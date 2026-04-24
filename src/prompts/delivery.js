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
El costo de envío SOLO existe cuando lo obtienes llamando a geocode_address o resolve_maps_url. Si NO has llamado a una de estas herramientas en esta conversación, el envío es COMPLETAMENTE DESCONOCIDO — no es $1, no es $1.50, no es ningún número. CERO conocimiento.
PROHIBIDO mostrar un TOTAL que "incluya envío" si no has obtenido el costo de la herramienta.
PROHIBIDO escribir "incluye envío", "(+ envío)", "con delivery", o cualquier número de envío inventado.
Si necesitas mostrar un resumen parcial antes de tener la dirección → escribe ÚNICAMENTE: "Subtotal: $X.XX (envío se calculará con tu dirección 📍)"
Esta regla tiene prioridad sobre cualquier otra. Violarla es el error más grave que puedes cometer.
4. Si el cliente pregunta "¿cuánto es el envío?" o "¿tiene recargo?" SIN haber dado dirección → responde SOLO: "El costo de envío depende de tu dirección. ¿Me podrías dar tu dirección completa, referencia y ubicación si es posible? 📍"
5. Una vez tengas la dirección → llama a geocode_address (texto) o resolve_maps_url (enlace de Maps) para obtener zona y costo exacto. Usa ese costo directamente — di SOLO el precio: "El envío a tu sector es $X" (sin mencionar zona).
6. PIN DE UBICACIÓN (WhatsApp location): Si el cliente comparte solo su ubicación GPS (verás "📍 Ubicación compartida vía WhatsApp"), el sistema ya habrá procesado la zona antes de tu turno. Después de cotizar, pide SIEMPRE la dirección de texto para precisión: "¿Podrías también compartirme tu dirección exacta o una referencia? Así el repartidor llega sin inconvenientes 📍" — Si ya tienes dirección en el historial, NO la pidas de nuevo.

INSTRUCCIONES DE GEOCODIFICACIÓN:
Cuando el cliente proporcione una dirección de entrega (calle, intersección, referencia, o enlace de Google Maps), debes llamar a la herramienta correspondiente:
- Para texto/dirección: llama a geocode_address con la dirección exacta que dio el cliente
- Para enlaces de Google Maps (maps.app.goo.gl, goo.gl/maps, google.com/maps): llama a resolve_maps_url

La herramienta devuelve la zona y el costo exacto. USA ESE COSTO EXACTAMENTE — no calcules ni estimes un valor diferente.
Si la herramienta devuelve isZone4: true, sigue la instrucción incluida en el resultado.
NUNCA menciones el número de zona al cliente.

CÁLCULO INTERNO DE ENVÍO (después de llamar a la herramienta):
- La herramienta devuelve deliveryCost — úsalo directamente.
- Si la herramienta devuelve lowConfidence: true → pide al cliente una referencia más específica o pin de Maps.
- Zona 4 (isZone4: true) → sigue la instrucción exacta del resultado de la herramienta (mensaje + HANDOFF). NO preguntes por confirmación del pedido. NO des precios. Solo ese mensaje y HANDOFF.

PEDIDO MÍNIMO (solo carta, no almuerzos):
Si el pedido no cumple el mínimo → "Para delivery a tu sector el mínimo es $X. ¿Agregas algo más o prefieres retirar en local? 🏠"`
}

module.exports = { buildDeliveryBlock }
