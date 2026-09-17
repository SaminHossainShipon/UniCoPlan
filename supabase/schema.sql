-- UniCoPlan — Supabase schema
--
-- This file is the missing "backend" for UniCoPlan: the tables, row-level
-- security policies, and Postgres functions that admin_panel/script.js and
-- student_panel/script.js already call (sb.from('semesters'), sb.from
-- ('courses'), sb.from('user_roles'), sb.rpc('current_app_role'),
-- sb.rpc('adjust_seat')). None of this lived in the repo before — it only
-- existed as manual changes in the Supabase dashboard — so this file makes
-- the project reproducible from scratch on a fresh Supabase project.
--
-- HOW TO RUN THIS
-- 1. Create a project at https://supabase.com (or open your existing one).
-- 2. Open the SQL Editor and paste this entire file in, then run it. It is
--    idempotent — safe to re-run if you tweak something later.
-- 3. Copy the project's URL and anon public key (Settings → API) into
--    SUPABASE_URL / SUPABASE_ANON_KEY in index.html, admin_panel/script.js,
--    and student_panel/script.js if you're pointing at a different project
--    than the one already hardcoded there.
-- 4. Follow the README's "One manual step: enabling Google sign-in" section
--    — that part genuinely can't be scripted, Supabase has no API for it.
-- 5. Give yourself (or whoever should be main admin) access by editing the
--    MAIN_ADMIN_EMAIL constant below before running this file, or by
--    updating current_app_role() afterwards.

-- ============================================================================
-- 1. TABLES
-- ============================================================================

create table if not exists public.semesters (
  id         text primary key,          -- client-generated, e.g. "sem1a2b3c"
  name       text not null,
  is_current boolean not null default false, -- the one semester the admin has starred as "ongoing" (admin Dashboard)
  created_at timestamptz not null default now()
);

-- Existing projects created before is_current existed: this is a no-op if
-- the column is already there (create table above already has it for fresh
-- projects), and adds it in place otherwise.
alter table public.semesters add column if not exists is_current boolean not null default false;

create table if not exists public.courses (
  id           text primary key,        -- client-generated, e.g. "crs4d5e6f"
  semester_id  text not null references public.semesters(id) on delete cascade,
  code         text not null,
  section      text not null default '',
  faculty      text not null default '',
  capacity     integer not null default 0,
  seats_taken  integer not null default 0,
  meetings     jsonb not null default '[]'::jsonb,
  created_at   timestamptz not null default now()
);

create index if not exists courses_semester_id_idx on public.courses(semester_id);

create table if not exists public.user_roles (
  email      text primary key,
  role       text not null check (role in ('admin', 'main_admin')),
  added_by   text,
  created_at timestamptz not null default now()
);

-- A signed-in account's own editable profile — currently just a display
-- name, shown alongside their email on the admin panel's "Student" page.
-- Anyone with panel access can set their own row; nobody can set anyone
-- else's (see the profiles_* policies below).
create table if not exists public.profiles (
  email      text primary key,
  name       text,
  updated_at timestamptz not null default now()
);

-- One row per account that has ever signed in, bumped by the record_login()
-- RPC below every time someone completes sign-in. Backs the admin
-- Dashboard's "total student logins" stat and the "Student" directory page.
create table if not exists public.login_log (
  email       text primary key,
  role        text not null,             -- the role they held at that login ('student' / 'admin' / 'main_admin')
  login_count integer not null default 1,
  first_login timestamptz not null default now(),
  last_login  timestamptz not null default now()
);

-- ============================================================================
-- 2. ACCESS-CONTROL FUNCTIONS
--    (security definer: they run with elevated rights so they can read
--    user_roles / update seats regardless of the caller's own RLS grants,
--    while the logic inside stays deliberately narrow)
-- ============================================================================

create or replace function public.current_app_role()
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text;
  v_role  text;
  -- Hardcoded fallback so the app can never lock out its own main admin,
  -- even if user_roles is ever emptied by mistake. Change this to your own
  -- Google account email before running this file.
  MAIN_ADMIN_EMAIL constant text := 'mdsaminhossainshipon@gmail.com';
begin
  v_email := lower(coalesce(auth.jwt() ->> 'email', ''));

  if v_email = '' then
    return 'none';
  end if;

  if v_email = MAIN_ADMIN_EMAIL then
    return 'main_admin';
  end if;

  select role into v_role from public.user_roles where lower(email) = v_email;
  if v_role is not null then
    return v_role;
  end if;

  if v_email like '%@std.ewubd.edu' then
    return 'student';
  end if;

  return 'none';
end;
$$;

grant execute on function public.current_app_role() to anon, authenticated;

create or replace function public.adjust_seat(p_course_id text, p_delta integer)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role    text;
  v_cap     integer;
  v_current integer;
begin
  v_role := public.current_app_role();
  if v_role = 'none' then
    raise exception 'not authorized';
  end if;

  select capacity, seats_taken into v_cap, v_current
  from public.courses
  where id = p_course_id
  for update; -- row lock: two students grabbing the last seat can't both win

  if not found then
    raise exception 'course not found';
  end if;

  update public.courses
  set seats_taken = greatest(0, least(v_cap, coalesce(v_current, 0) + p_delta))
  where id = p_course_id;
end;
$$;

grant execute on function public.adjust_seat(text, integer) to anon, authenticated;

-- Called once per sign-in (see recordLoginRemote() in script.js) to upsert a
-- row in login_log for whoever is currently signed in, bumping login_count.
-- SECURITY DEFINER so it can write to a table students otherwise have no
-- write access to at all (see login_log's RLS below — same pattern as
-- adjust_seat() above bypassing courses_write for seat updates).
create or replace function public.record_login()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text;
  v_role  text;
begin
  v_email := lower(coalesce(auth.jwt() ->> 'email', ''));
  v_role  := public.current_app_role();

  if v_email = '' or v_role = 'none' then
    return;
  end if;

  insert into public.login_log (email, role, login_count, first_login, last_login)
  values (v_email, v_role, 1, now(), now())
  on conflict (email) do update
    set role        = excluded.role,
        login_count = public.login_log.login_count + 1,
        last_login  = now();
end;
$$;

grant execute on function public.record_login() to anon, authenticated;

-- ============================================================================
-- 3. ROW LEVEL SECURITY
-- ============================================================================

alter table public.semesters enable row level security;
alter table public.courses   enable row level security;
alter table public.user_roles enable row level security;

-- semesters: readable by anyone with panel access; writable by admins only
drop policy if exists semesters_select on public.semesters;
create policy semesters_select on public.semesters
  for select using (public.current_app_role() <> 'none');

drop policy if exists semesters_write on public.semesters;
create policy semesters_write on public.semesters
  for all using (public.current_app_role() in ('admin', 'main_admin'))
  with check (public.current_app_role() in ('admin', 'main_admin'));

-- courses: readable by anyone with panel access; writable by admins only.
-- (Seat count changes go through adjust_seat(), which is SECURITY DEFINER
-- and bypasses this policy on purpose — students never get direct UPDATE.)
drop policy if exists courses_select on public.courses;
create policy courses_select on public.courses
  for select using (public.current_app_role() <> 'none');

drop policy if exists courses_write on public.courses;
create policy courses_write on public.courses
  for all using (public.current_app_role() in ('admin', 'main_admin'))
  with check (public.current_app_role() in ('admin', 'main_admin'));

-- user_roles: only the main admin's "Manage access" tab reads/writes this
drop policy if exists user_roles_all on public.user_roles;
create policy user_roles_all on public.user_roles
  for all using (public.current_app_role() = 'main_admin')
  with check (public.current_app_role() = 'main_admin');

alter table public.profiles enable row level security;
alter table public.login_log enable row level security;

-- profiles: an account can read/write only its own row; admins/main admins
-- can additionally read every row, for the admin panel's "Student" page.
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles
  for select using (
    public.current_app_role() in ('admin', 'main_admin')
    or lower(coalesce(auth.jwt() ->> 'email', '')) = email
  );

drop policy if exists profiles_insert on public.profiles;
create policy profiles_insert on public.profiles
  for insert with check (
    public.current_app_role() <> 'none'
    and lower(coalesce(auth.jwt() ->> 'email', '')) = email
  );

drop policy if exists profiles_update on public.profiles;
create policy profiles_update on public.profiles
  for update using (lower(coalesce(auth.jwt() ->> 'email', '')) = email)
  with check (lower(coalesce(auth.jwt() ->> 'email', '')) = email);

-- login_log: readable only by admins/main admins (the Dashboard + Student
-- page). Nobody gets a direct write policy — every write goes through the
-- SECURITY DEFINER record_login() RPC above, which bypasses RLS the same
-- way adjust_seat() does for seats_taken.
drop policy if exists login_log_select on public.login_log;
create policy login_log_select on public.login_log
  for select using (public.current_app_role() in ('admin', 'main_admin'));

-- ============================================================================
-- 4. REALTIME
--    admin_panel/script.js and student_panel/script.js both subscribe to a
--    'datasheet-changes' channel on these two tables so every open tab
--    refreshes automatically when the admin edits the datasheet.
-- ============================================================================

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'semesters'
  ) then
    alter publication supabase_realtime add table public.semesters;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'courses'
  ) then
    alter publication supabase_realtime add table public.courses;
  end if;
end;
$$;
