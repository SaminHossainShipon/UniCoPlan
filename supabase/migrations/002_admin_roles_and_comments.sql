-- UniCoPlan — migration 002: admin sub-roles + student comments
--
-- Additive on top of supabase/schema.sql — run that file first if you
-- haven't already, then run this one. Idempotent, same as schema.sql (safe
-- to re-run).
--
-- What this adds:
--   1. user_roles.admin_role — the Role dropdown shown in "Manage access"
--      (Main Admin / Semester Adjust / ... — see ADMIN_ROLES in script.js).
--      Purely a display label; it does NOT change what an 'admin' row can
--      do — that's still governed by user_roles.role ('admin'/'main_admin')
--      and current_app_role(), unchanged from schema.sql.
--   2. A policy letting a non-main admin read their own user_roles row, so
--      the profile-menu "Role" line can show their admin_role (previously
--      user_roles was main-admin-only, even for reading your own row).
--   3. student_comments — the table backing both panels' Comments pages.
--
-- HOW TO RUN: Supabase SQL Editor → paste this whole file → run.

-- ============================================================================
-- 1. user_roles.admin_role
-- ============================================================================

alter table public.user_roles add column if not exists admin_role text not null default 'admin';

-- A non-main admin previously had no read access to user_roles at all (the
-- existing user_roles_all policy is main-admin-only). This adds a second,
-- narrower policy — permissive policies are OR'd together in Postgres RLS —
-- so any signed-in admin can read (only) their own row, which is all the
-- profile-menu "Role" line needs. It does not grant insert/update/delete.
drop policy if exists user_roles_select_self on public.user_roles;
create policy user_roles_select_self on public.user_roles
  for select using (lower(coalesce(auth.jwt() ->> 'email', '')) = email);

-- ============================================================================
-- 2. student_comments
--    Backs the student panel's "Comments" page (a message box) and the
--    admin panel's "Comments" page (reads every message, with student name/
--    email + timestamp).
-- ============================================================================

create table if not exists public.student_comments (
  id         text primary key,        -- client-generated, e.g. "cmt4d5e6f"
  email      text not null,           -- the sending student's account email
  name       text,                    -- their profiles.name at send time, if set (may be blank)
  message    text not null,
  created_at timestamptz not null default now()
);

create index if not exists student_comments_created_at_idx on public.student_comments(created_at desc);
create index if not exists student_comments_email_idx on public.student_comments(email);

alter table public.student_comments enable row level security;

-- insert: any signed-in, authorized account (student or admin, e.g. while
-- using "Preview as Student") can insert only a comment attributed to
-- themselves — never on someone else's behalf.
drop policy if exists student_comments_insert on public.student_comments;
create policy student_comments_insert on public.student_comments
  for insert with check (
    public.current_app_role() <> 'none'
    and lower(coalesce(auth.jwt() ->> 'email', '')) = email
  );

-- select: admins/main admins can read every comment (the admin Comments
-- page); a student can additionally read their own past comments (their own
-- Comments-page history + Dashboard "Your messages" count).
drop policy if exists student_comments_select on public.student_comments;
create policy student_comments_select on public.student_comments
  for select using (
    public.current_app_role() in ('admin', 'main_admin')
    or lower(coalesce(auth.jwt() ->> 'email', '')) = email
  );
