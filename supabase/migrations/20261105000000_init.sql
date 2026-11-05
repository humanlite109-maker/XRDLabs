-- =============================================================================
-- Sample Queue & Tracking System: initial schema
-- Run once (Supabase SQL Editor, or `supabase db push`). Safe to re-run.
--
-- Design:
--   samples         full records (names, roll numbers). Operators only.
--   public_samples  masked mirror kept in sync by a trigger. Anonymous read.
--                   Students subscribe to THIS table, so no PII ever reaches them.
--   operators       email allowlist. Defence in depth on top of disabled sign-ups.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Operator allowlist
-- ---------------------------------------------------------------------------
create table if not exists public.operators (
  email text primary key check (email = lower(email))
);
alter table public.operators enable row level security;
-- No policies on purpose: the API can never read or write this table directly.
revoke all on public.operators from anon, authenticated;

create or replace function public.is_operator()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.operators
    where email = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;
revoke all on function public.is_operator() from public;
grant execute on function public.is_operator() to authenticated;

-- ---------------------------------------------------------------------------
-- 2. Samples (full records)
-- ---------------------------------------------------------------------------
create table if not exists public.samples (
  id            uuid primary key default gen_random_uuid(),
  student_name  text not null check (length(btrim(student_name)) between 1 and 100),
  roll_no       text not null check (length(btrim(roll_no))      between 1 and 30),
  sample_label  text not null check (length(btrim(sample_label)) between 1 and 40),
  status        text not null default 'queued'
                check (status in ('queued', 'running', 'ready', 'collected')),
  est_minutes   integer not null check (est_minutes between 1 and 1440),
  queued_at     timestamptz not null default now(),
  started_at    timestamptz,
  ready_at      timestamptz,
  collected_at  timestamptz,
  operator_name text,            -- operator who added the sample
  started_by    text,
  ready_by      text,
  collected_by  text,
  notes         text check (notes is null or length(notes) <= 500)
);
create index if not exists samples_status_queued_idx on public.samples (status, queued_at);

-- Guard trigger: server-side timestamps, operator identity, legal transitions only.
create or replace function public.samples_guard()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  actor text := coalesce(auth.jwt() ->> 'email', current_user);
begin
  if tg_op = 'INSERT' then
    new.student_name  := btrim(new.student_name);
    new.roll_no       := btrim(new.roll_no);
    new.sample_label  := btrim(new.sample_label);
    new.status        := 'queued';
    new.queued_at     := now();
    new.started_at    := null;
    new.ready_at      := null;
    new.collected_at  := null;
    new.operator_name := actor;
    new.started_by    := null;
    new.ready_by      := null;
    new.collected_by  := null;
    return new;
  end if;

  -- UPDATE: audit columns can only change through a status transition
  new.id            := old.id;
  new.queued_at     := old.queued_at;
  new.operator_name := old.operator_name;
  new.started_at    := old.started_at;   new.started_by   := old.started_by;
  new.ready_at      := old.ready_at;     new.ready_by     := old.ready_by;
  new.collected_at  := old.collected_at; new.collected_by := old.collected_by;
  new.student_name  := btrim(new.student_name);
  new.roll_no       := btrim(new.roll_no);
  new.sample_label  := btrim(new.sample_label);

  if new.status is distinct from old.status then
    if not (   (old.status = 'queued'  and new.status = 'running')
            or (old.status = 'running' and new.status = 'ready')
            or (old.status = 'ready'   and new.status = 'collected')) then
      raise exception 'Invalid status change: % -> %', old.status, new.status
        using errcode = 'P0001';
    end if;

    if new.status = 'running' then
      new.started_at := now();   new.started_by   := actor;
    elsif new.status = 'ready' then
      new.ready_at := now();     new.ready_by     := actor;
    elsif new.status = 'collected' then
      new.collected_at := now(); new.collected_by := actor;
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists samples_guard_trg on public.samples;
create trigger samples_guard_trg
  before insert or update on public.samples
  for each row execute function public.samples_guard();

-- Operators can read, add and update. Nobody can delete (audit trail).
alter table public.samples enable row level security;
revoke all on public.samples from anon, authenticated;
grant select, insert, update on public.samples to authenticated;

drop policy if exists samples_select on public.samples;
drop policy if exists samples_insert on public.samples;
drop policy if exists samples_update on public.samples;
create policy samples_select on public.samples for select to authenticated using (public.is_operator());
create policy samples_insert on public.samples for insert to authenticated with check (public.is_operator());
create policy samples_update on public.samples for update to authenticated
  using (public.is_operator()) with check (public.is_operator());

-- ---------------------------------------------------------------------------
-- 3. Public, masked mirror (what students can see)
-- ---------------------------------------------------------------------------
create or replace function public.mask_roll(r text)
returns text
language sql
immutable
as $$
  -- '***' + up to the last 3 characters, never the whole roll number
  select '***' || right(r, greatest(least(3, length(r) - 1), 0));
$$;

create table if not exists public.public_samples (
  id           uuid primary key,
  sample_label text not null,
  first_name   text not null,
  roll_masked  text not null,
  status       text not null check (status in ('queued', 'running', 'ready')),
  est_minutes  integer not null,
  queued_at    timestamptz not null,
  started_at   timestamptz,
  ready_at     timestamptz
);

alter table public.public_samples enable row level security;
revoke all on public.public_samples from anon, authenticated;
grant select on public.public_samples to anon, authenticated;

drop policy if exists public_samples_read on public.public_samples;
create policy public_samples_read on public.public_samples
  for select to anon, authenticated using (true);
-- No insert/update/delete policies: only the trigger below can write.

create or replace function public.sync_public_samples()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    delete from public.public_samples where id = old.id;
    return old;
  end if;

  if new.status = 'collected' then
    delete from public.public_samples where id = new.id;
    return new;
  end if;

  insert into public.public_samples
    (id, sample_label, first_name, roll_masked, status, est_minutes, queued_at, started_at, ready_at)
  values
    (new.id, new.sample_label, split_part(btrim(new.student_name), ' ', 1),
     public.mask_roll(new.roll_no), new.status, new.est_minutes,
     new.queued_at, new.started_at, new.ready_at)
  on conflict (id) do update set
    sample_label = excluded.sample_label,
    first_name   = excluded.first_name,
    roll_masked  = excluded.roll_masked,
    status       = excluded.status,
    est_minutes  = excluded.est_minutes,
    queued_at    = excluded.queued_at,
    started_at   = excluded.started_at,
    ready_at     = excluded.ready_at;
  return new;
end;
$$;
revoke all on function public.sync_public_samples() from public;

drop trigger if exists samples_sync_trg on public.samples;
create trigger samples_sync_trg
  after insert or update or delete on public.samples
  for each row execute function public.sync_public_samples();

-- ---------------------------------------------------------------------------
-- 4. Server clock (lets browsers correct their own clock skew for ETAs)
-- ---------------------------------------------------------------------------
create or replace function public.server_now()
returns timestamptz
language sql
stable
as $$ select clock_timestamp(); $$;
grant execute on function public.server_now() to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5. Realtime
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (select 1 from pg_publication_tables
                   where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'public_samples') then
      alter publication supabase_realtime add table public.public_samples;
    end if;
    if not exists (select 1 from pg_publication_tables
                   where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'samples') then
      alter publication supabase_realtime add table public.samples;
    end if;
  end if;
end
$$;
