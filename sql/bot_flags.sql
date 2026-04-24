create table if not exists bot_flags (
  phone text primary key,
  geocode_clarification_pending boolean default false,
  house_number_pending boolean default false,
  updated_at timestamptz default now()
);

create index if not exists bot_flags_updated_at_idx on bot_flags(updated_at);
