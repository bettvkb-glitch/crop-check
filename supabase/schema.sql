-- Crop Check database schema. Run once in the Supabase SQL Editor.

-- 1. Every scan a farmer makes. Private to the farmer.
create table public.scans (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null default auth.uid() references auth.users(id) on delete cascade,
  crop             text,
  disease          text,
  disease_key      text,
  confidence       real check (confidence between 0 and 1),
  severity         text check (severity in ('none','low','moderate','severe')),
  affected_percent real check (affected_percent between 0 and 100),
  result           jsonb not null,
  lat              numeric(5,2),
  lng              numeric(5,2),
  created_at       timestamptz not null default now()
);

create index scans_user_recent on public.scans (user_id, created_at desc);

alter table public.scans enable row level security;

create policy "scans: read own"   on public.scans for select to authenticated using (user_id = auth.uid());
create policy "scans: insert own" on public.scans for insert to authenticated with check (user_id = auth.uid());
create policy "scans: delete own" on public.scans for delete to authenticated using (user_id = auth.uid());

-- 2. Outbreak reports. Filled by a trigger, never readable directly.
--    RLS is on and there are no policies, so only get_outbreaks() can read it.
create table public.outbreak_reports (
  id           bigint generated always as identity primary key,
  user_id      uuid not null references auth.users(id) on delete cascade,
  crop         text,
  disease_key  text not null,
  disease      text not null,
  severity     text not null,
  lat          numeric(5,2) not null,
  lng          numeric(5,2) not null,
  created_at   timestamptz not null default now()
);

create index outbreak_reports_recent on public.outbreak_reports (created_at desc);

alter table public.outbreak_reports enable row level security;

-- 3. Only confident, serious diagnoses with a location become reports.
create function public.scan_to_report() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.disease_key is not null
     and new.disease_key not in ('healthy', 'unknown')
     and new.severity in ('moderate', 'severe')
     and coalesce(new.confidence, 0) >= 0.6
     and new.lat is not null and new.lng is not null then
    insert into public.outbreak_reports (user_id, crop, disease_key, disease, severity, lat, lng)
    values (new.user_id, new.crop, new.disease_key, coalesce(new.disease, new.disease_key),
            new.severity, round(new.lat, 2), round(new.lng, 2));
  end if;
  return new;
end $$;

create trigger scans_to_reports after insert on public.scans
for each row execute function public.scan_to_report();

-- 4. An outbreak is confirmed only when 2 or more different farmers report the
--    same disease within the same ~11 km cell. One wrong scan never reaches the map.
create function public.get_outbreaks(days int default 14)
returns table (
  disease_key text, disease text, crop text,
  lat numeric, lng numeric,
  reports bigint, farmers bigint,
  worst text, last_reported timestamptz
)
language sql security definer set search_path = '' stable as $$
  select
    r.disease_key,
    max(r.disease),
    max(r.crop),
    round(avg(r.lat), 2),
    round(avg(r.lng), 2),
    count(*),
    count(distinct r.user_id),
    case max(case r.severity when 'severe' then 2 else 1 end) when 2 then 'severe' else 'moderate' end,
    max(r.created_at)
  from public.outbreak_reports r
  where r.created_at > now() - make_interval(days => least(greatest(days, 1), 60))
  group by r.disease_key, round(r.lat, 1), round(r.lng, 1)
  having count(distinct r.user_id) >= 2
  order by max(r.created_at) desc
  limit 200;
$$;

revoke all on function public.get_outbreaks(int) from public, anon;
grant execute on function public.get_outbreaks(int) to authenticated;
