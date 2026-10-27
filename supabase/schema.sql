-- Run in Supabase SQL editor.
-- Auth: email/password (Dashboard > Authentication). The app requires a signed-in user.

-- 1) Private scan history (only the owner can read it)
create table public.scans (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  crop        text,
  disease     text,                       -- null = healthy
  confidence  real check (confidence between 0 and 1),
  severity    text check (severity in ('none','low','moderate','severe')),
  treatment   jsonb,
  lat         numeric(5,2),               -- rounded ~1 km by the Worker
  lng         numeric(5,2),
  created_at  timestamptz not null default now()
);

alter table public.scans enable row level security;

create policy "own scans: read"   on public.scans for select to authenticated using (user_id = auth.uid());
create policy "own scans: insert" on public.scans for insert to authenticated with check (user_id = auth.uid());

-- 2) Public outbreak signals (no user id, coarse location). This is what the map subscribes to.
--    Realtime does not work on views, so this is a real table filled by a trigger.
create table public.outbreak_signals (
  id          bigint generated always as identity primary key,
  crop        text,
  disease     text not null,
  severity    text not null,
  lat         numeric(5,2) not null,
  lng         numeric(5,2) not null,
  created_at  timestamptz not null default now()
);

create index outbreak_signals_recent on public.outbreak_signals (created_at desc);

alter table public.outbreak_signals enable row level security;

create policy "signals: read" on public.outbreak_signals for select to authenticated using (true);
-- no insert/update/delete policies: only the trigger below can write

create function public.scan_to_signal() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.disease is not null
     and new.severity in ('moderate','severe')
     and coalesce(new.confidence, 0) >= 0.6
     and new.lat is not null and new.lng is not null then
    insert into public.outbreak_signals (crop, disease, severity, lat, lng)
    values (new.crop, new.disease, new.severity, round(new.lat, 2), round(new.lng, 2));
  end if;
  return new;
end $$;

create trigger scans_to_signals after insert on public.scans
for each row execute function public.scan_to_signal();

-- 3) Turn on Realtime for the map
alter publication supabase_realtime add table public.outbreak_signals;
