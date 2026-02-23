-- ============================================================
-- almuerzo_delivery_tiers
-- Delivery pricing for ALMUERZO-only orders, based on quantity
-- + zone (distance from restaurant).
--
-- Rules:
--   - Pure almuerzo orders → use this table
--   - Mixed (almuerzo + carta) or pure carta → use delivery_tiers
--     on the combined order total
-- ============================================================

create table if not exists almuerzo_delivery_tiers (
  id                 serial primary key,
  zone_number        integer        not null,
  min_qty            integer        not null default 1,   -- minimum # of almuerzos
  max_qty            integer,                             -- null = no upper limit (e.g. 2+)
  delivery_price     numeric(10,2)  not null default 0,
  is_free            boolean        not null default false,
  requires_approval  boolean        not null default false,
  sort_order         integer        not null default 0,
  created_at         timestamptz    default now()
);

-- Unique constraint: one row per zone + qty range
create unique index if not exists almuerzo_delivery_tiers_zone_qty
  on almuerzo_delivery_tiers (zone_number, min_qty);

-- ============================================================
-- DATA
-- Zone 1 (0–2 km):   1 almuerzo = $0.50 | 2+ = GRATIS
-- Zone 2 (2–4 km):   1 almuerzo = $1.50 | 2+ = $1.00
-- Zone 3 (4–6 km):   1 almuerzo = $2.50 | 2+ = $2.00
-- Zone 4 (6+ km):    always escalate to supervisor
-- ============================================================

insert into almuerzo_delivery_tiers
  (zone_number, min_qty, max_qty, delivery_price, is_free, requires_approval, sort_order)
values
  -- Zone 1
  (1, 1, 1,    0.50, false, false, 10),
  (1, 2, null, 0.00, true,  false, 20),

  -- Zone 2
  (2, 1, 1,    1.50, false, false, 30),
  (2, 2, null, 1.00, false, false, 40),

  -- Zone 3
  (3, 1, 1,    2.50, false, false, 50),
  (3, 2, null, 2.00, false, false, 60),

  -- Zone 4 — always needs supervisor approval
  (4, 1, null, 0.00, false, true,  70)

on conflict (zone_number, min_qty) do update
  set delivery_price    = excluded.delivery_price,
      is_free           = excluded.is_free,
      requires_approval = excluded.requires_approval,
      sort_order        = excluded.sort_order;
