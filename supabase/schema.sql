-- =====================================================================
-- GOWES — skema database (jalankan di SQL Editor Supabase project Ayyubi)
-- Semua tabel berawalan gowes_ supaya tidak bentrok dengan tabel Ayyubi.
-- RLS aktif TANPA policy: anon/publik tidak bisa baca-tulis sama sekali.
-- Semua akses lewat Edge Function "gowes" (memakai service role).
-- =====================================================================

create table if not exists public.gowes_bikes (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  note        text,
  is_default  boolean not null default false,
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

create table if not exists public.gowes_rides (
  id           bigint primary key,          -- activityId Garmin (negatif = impor manual .FIT)
  name         text,
  type_key     text,
  start_time   timestamptz,
  start_local  timestamp,                    -- jam lokal sesuai Garmin (untuk tampilan & pengelompokan)
  distance_m   double precision,
  duration_s   double precision,
  moving_s     double precision,
  elapsed_s    double precision,
  elev_gain    double precision,
  elev_loss    double precision,
  avg_speed    double precision,             -- m/s
  max_speed    double precision,             -- m/s
  avg_hr       double precision,
  max_hr       double precision,
  avg_cad      double precision,
  avg_power    double precision,
  max_power    double precision,
  norm_power   double precision,
  calories     double precision,
  avg_temp     double precision,
  max_temp     double precision,
  location     text,
  start_lat    double precision,
  start_lng    double precision,
  bike_id      uuid references public.gowes_bikes(id) on delete set null,
  note         text,
  event        jsonb,                        -- {"cot_h":22,"target_km":300,"label":"ROJ Ultra 300"}
  analysis     jsonb,                        -- hasil analisis FIT (berhenti, segmen, lap, best effort, HR)
  analyzed_at  timestamptz,
  source       text not null default 'garmin',
  raw          jsonb,                        -- ringkasan asli dari Garmin
  synced_at    timestamptz not null default now()
);
create index if not exists gowes_rides_start_idx on public.gowes_rides (start_time desc);
create index if not exists gowes_rides_bike_idx  on public.gowes_rides (bike_id, start_time);

create table if not exists public.gowes_streams (
  ride_id  bigint primary key references public.gowes_rides(id) on delete cascade,
  data     jsonb not null
);

create table if not exists public.gowes_parts (
  id            uuid primary key default gen_random_uuid(),
  bike_id       uuid not null references public.gowes_bikes(id) on delete cascade,
  name          text not null,               -- "Rantai", "Ban belakang", ...
  kind          text,
  installed_at  date not null default current_date,
  offset_km     double precision not null default 0, -- km yang sudah dipakai sebelum dicatat
  limit_km      double precision,
  active        boolean not null default true,
  replaced_at   date,
  note          text,
  created_at    timestamptz not null default now()
);

create table if not exists public.gowes_kv (
  key         text primary key,
  value       jsonb,
  updated_at  timestamptz not null default now()
);

create table if not exists public.gowes_sync_log (
  id      bigserial primary key,
  at      timestamptz not null default now(),
  source  text,
  result  jsonb
);

alter table public.gowes_bikes    enable row level security;
alter table public.gowes_rides    enable row level security;
alter table public.gowes_streams  enable row level security;
alter table public.gowes_parts    enable row level security;
alter table public.gowes_kv       enable row level security;
alter table public.gowes_sync_log enable row level security;
-- (sengaja tidak ada CREATE POLICY)

-- Sepeda awal (ubah namanya nanti di menu Garasi)
insert into public.gowes_bikes (name, note, is_default)
select 'Sepeda besi', 'Ban 700x45', true
where not exists (select 1 from public.gowes_bikes);

-- =====================================================================
-- SINKRON OTOMATIS TIAP JAM (opsional tapi disarankan)
-- 1) Aktifkan extension pg_cron dan pg_net (Database → Extensions).
-- 2) Ganti <CRON_SECRET> (sama dengan secret GOWES_CRON_SECRET), hapus tanda -- lalu jalankan blok di bawah.
-- =====================================================================
-- select cron.schedule(
--   'gowes-sync-hourly',
--   '17 * * * *',
--   $$
--   select net.http_post(
--     url     := 'https://alkpmwowhlyffdwfvyeu.supabase.co/functions/v1/gowes',
--     headers := jsonb_build_object('Content-Type','application/json','x-cron-secret','<CRON_SECRET>'),
--     body    := '{"action":"sync"}'::jsonb,
--     timeout_milliseconds := 120000
--   );
--   $$
-- );
-- Untuk menghapus jadwal: select cron.unschedule('gowes-sync-hourly');
