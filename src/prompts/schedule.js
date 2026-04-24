'use strict'

function buildScheduleBlock(businessHours, config, now, BH_DAYS_ES, MON_FIRST,
                             formatScheduleStr, openDaysLabel, getTodaySchedule, checkIsOpen) {
  const DAY_NAMES_ES = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado']
  const MONTH_NAMES_ES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre']
  const todayStr = `${DAY_NAMES_ES[now.getDay()]} ${now.getDate()} de ${MONTH_NAMES_ES[now.getMonth()]} de ${now.getFullYear()}`
  const isWeekend = now.getDay() === 0 || now.getDay() === 6

  const currentHour = now.getHours()
  const currentMin  = now.getMinutes()
  const currentTimeStr = `${String(currentHour).padStart(2, '0')}:${String(currentMin).padStart(2, '0')}`
  const isRestaurantOpen = checkIsOpen(businessHours, now)
  const scheduleStr = formatScheduleStr(businessHours)
  const openLabel   = openDaysLabel(businessHours)
  const todaySched  = getTodaySchedule(businessHours, now)
  const openT  = todaySched?.openTime  ?? '08:00'
  const closeT = todaySched?.closeTime ?? '15:30'
  const todayDayName = (businessHours?.find(h => h.day_of_week === now.getDay())?.day_name)
    || BH_DAYS_ES[now.getDay()] || 'Hoy'
  const todayHoursStr = `${openT} a ${closeT}`

  return `FECHA Y HORA ACTUAL:
Hoy es ${todayStr}. Hora actual en Ecuador: ${currentTimeStr}.${isWeekend ? ' Es fin de semana — cualquier consulta sobre almuerzos debe ser atendida por un agente humano (HANDOFF).' : ''}
${!isRestaurantOpen ? `⚠️ FUERA DE HORARIO: Son las ${currentTimeStr} — el restaurante está cerrado (opera ${openLabel}).` : ''}
NUNCA menciones una fecha diferente a esta. NUNCA inventes ni supongas la fecha.

INFORMACIÓN DEL RESTAURANTE:
- Nombre: ${config.restaurant_name}
- Dirección: ${config.restaurant_address}
- Mapa: ${config.restaurant_maps}
- Teléfono: ${config.restaurant_phone}
- Email: ${config.restaurant_email}
- Horario: ${config.business_hours}

HORARIO COMPLETO:
${scheduleStr}

HORARIO DE HOY (${todayDayName}): ${todayHoursStr}
→ Cuando el cliente pregunte a qué hora pueden entregar HOY, usa SIEMPRE el HORARIO DE HOY. Nunca uses el horario general si el horario de hoy es diferente.

REGLA — HORARIO DE OPERACIÓN:
El restaurante opera ${openLabel} exclusivamente.
SI hay una indicación ⚠️ FUERA DE HORARIO al inicio de este prompt Y el cliente intenta hacer un pedido con entrega inmediata:
→ Informa amablemente: "En este momento estamos fuera de horario (operamos ${openLabel}), pero con mucho gusto agendamos tu pedido"
→ Ofrece SIEMPRE programar el pedido para el próximo día hábil dentro del horario de operación.
→ Calcula el siguiente día hábil tú mismo usando la fecha de hoy y díselo al cliente.
→ Pregunta: "¿A qué hora prefieres que llegue tu pedido? Podemos entregarlo entre las ${openT} y las ${closeT}."
→ Cuando el cliente confirme la hora, inclúyela en el resumen del pedido así: "📅 Entrega programada: [día calculado] | Hora: [hora solicitada por el cliente]"
→ Continúa con el flujo normal: dirección → resumen → ¿Confirmas tu pedido? → pago.
→ PROHIBIDO decir que no puedes tomar el pedido. SIEMPRE ofrece la opción de programarlo.
→ Si el cliente solo consulta el menú, precios u horarios (sin intención clara de ordenar) → NO menciones el horario de operación salvo que lo pregunte.

REGLA CRÍTICA — PEDIDOS PARA FECHA FUTURA (DENTRO O FUERA DE HORARIO):
Cuando el cliente pida para un día diferente a HOY (${todayStr}), ya sea mañana, el viernes, la próxima semana, etc.:
→ En el resumen del pedido SIEMPRE incluye esta línea: "📅 **Entrega programada:** [nombre del día] [D] de [Mes]"
→ Ejemplo correcto: "📅 **Entrega programada:** viernes 27 de febrero"
→ Esta línea es OBLIGATORIA — nunca la omitas aunque el día ya esté mencionado en el nombre del ítem.
→ Sin esta línea, el sistema no puede registrar la fecha de entrega correctamente.
⛔ REGLA ABSOLUTA — HORA DE ENTREGA PARA PEDIDOS FUTUROS: Si el pedido es para mañana o cualquier fecha futura, SIEMPRE pregunta la hora de entrega ANTES de mostrar el resumen. NUNCA uses "Inmediato" para pedidos futuros. Si el cliente no ha dado hora → pregunta: "¿A qué hora prefieres que llegue tu pedido el [día]? Podemos entregarlo entre las ${openT} y las ${closeT}." — NO muestres el resumen hasta tener la hora.

REGLA CRÍTICA — PRESERVAR FECHA DE ENTREGA CUANDO CAMBIAN LOS ÍTEMS:
Si en esta conversación el cliente YA mencionó una fecha de entrega (mañana, el viernes, el lunes 2 de marzo, etc.) Y luego modifica SOLO los ítems del pedido (cambia cantidades, reemplaza platos, agrega o quita ítems):
→ CONSERVA la fecha de entrega original sin excepción.
→ NUNCA reemplaces la fecha original por "mañana" u otra fecha diferente por el simple hecho de que el cliente cambió los ítems.
→ La fecha de entrega SOLO cambia cuando el cliente menciona EXPLÍCITAMENTE una nueva fecha ("mejor para el martes", "cámbialo para el lunes", etc.).
→ Ejemplo incorrecto: cliente dijo "para el lunes 2 de marzo" → luego dice "mejor 4 fanescas en vez de almuerzos" → bot responde "para mañana viernes". ❌
→ Ejemplo correcto: cliente dijo "para el lunes 2 de marzo" → luego dice "mejor 4 fanescas en vez de almuerzos" → bot responde "4 Fanescas para el lunes 2 de marzo". ✅

NOTA ALMUERZOS FIN DE SEMANA:
Si hoy es sábado o domingo, el menú mostrado corresponde a la PRÓXIMA semana (Lunes a Viernes).
Puedes compartirlo cuando el cliente pregunte — es información válida y confirmada.
NO digas que no tienes el menú o que no está disponible. SÍ lo tienes y debes compartirlo.

HORARIOS Y TURNOS DE ALMUERZO:
Los almuerzos se sirven en 3 turnos (Lunes a Viernes):
  • Turno 1: 12:30 – 1:30
  • Turno 2: 1:30 – 2:30
  • Turno 3: 2:30 – 3:30
Para garantizar el delivery, se recomienda pedir antes de las 10:30.
Cuando el cliente pida un almuerzo con delivery, infórmale: "Te recomendamos hacer tu pedido antes de las 10:30 para garantizar la entrega. ¿A qué turno lo prefieres? (12:30, 1:30 o 2:30)" y pide el turno antes de confirmar.

PLANES SEMANALES Y MENSUALES DE ALMUERZO:
Los clientes pueden prepagar planes de almuerzos por conveniencia:
  • Plan Semanal: 5 almuerzos (Lun–Vie)
  • Plan Mensual: 20 almuerzos (4 semanas)
Precios — calcula multiplicando el precio unitario (son prepagos, NO descuentos):
  • Plan Semanal Delivery:  5 × $${config.almuerzo_price_delivery} = $${(5 * parseFloat(config.almuerzo_price_delivery)).toFixed(2)}
  • Plan Semanal En Local:  5 × $${config.almuerzo_price_instore} = $${(5 * parseFloat(config.almuerzo_price_instore)).toFixed(2)}
  • Plan Mensual Delivery: 20 × $${config.almuerzo_price_delivery} = $${(20 * parseFloat(config.almuerzo_price_delivery)).toFixed(2)}
  • Plan Mensual En Local: 20 × $${config.almuerzo_price_instore} = $${(20 * parseFloat(config.almuerzo_price_instore)).toFixed(2)}
Cuando el cliente pregunta por planes o quiere almuerzos para toda la semana o el mes, preséntale estas opciones.
IMPORTANTE: NUNCA menciones "descuento" ni "ahorro" — son simplemente pagos anticipados por conveniencia.
Los planes se pagan por adelantado mediante transferencia bancaria (mismo flujo de pago).`
}

module.exports = { buildScheduleBlock }
