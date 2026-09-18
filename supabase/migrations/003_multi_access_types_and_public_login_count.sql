-- UniCoPlan — migration 003: multi-select access types + public student count
--
-- Additive on top of supabase/schema.sql and
-- supabase/migrations/002_admin_roles_and_comments.sql — run those first if
-- you haven't already, then run this one. Idempotent (safe to re-run).
--
-- What this adds:
--   1. user_roles.access_types (text[]) — replaces the single-value
--      admin_role label from migration 002 with a proper multi-select: an
--      admin can now be granted any combination of Main Admin / Semester
--      Adjust / Course datasheet edit / Students / Student comments (see
--      ADMIN_ACCESS_TYPES in script.js). Existing admin_role values are
--      copied in automatically so nobody's access "disappears". The old
--      admin_role column is left in place, unused, rather than dropped —
--      no data loss either way.
--      NOTE: like admin_role before it, access_types is a client-side
--      display/nav-gating label only. It does not change what an 'admin'
--      row can read/write at the database level — that's still governed by
--      user_roles.role ('admin'/'main_admin') and current_app_role(),
--      unchanged from schema.sql. Course/semester/login_log RLS still
--      treats every 'admin' row the same.
--   2. student_login_count() — a public RPC returning just the total
--      number of distinct students who have ever signed in. Callable by
--      *anyone*, signed in or not, since it exposes nothing but a count
--      (never an email or a timestamp) — backs the "Total students signed
--      in" stat shown on both panels' sign-in screens.
--
-- HOW TO RUN: Supabase SQL Editor → paste this whole file → run.

-- ============================================================================
-- 1. user_roles.access_types
-- ============================================================================

alter table public.user_roles add column if not exists access_types text[] not null default '{}';

-- Backfill: carry migration 002's single admin_role value into the new
-- array column for any row that hasn't been touched since. Only fires for
-- rows that still have an empty array, so re-running this migration never
-- clobbers access_types someone has already edited via the new multi-select UI.
update public.user_roles
set access_types = array[admin_role]
where access_types = '{}'
  and admin_role is not null
  and admin_role <> '';

-- ============================================================================
-- 2. student_login_count()
--    Public (anon + authenticated) — deliberately does NOT check
--    current_app_role(), unlike the app's other RPCs, since it exposes
--    nothing sensitive. Backs the "Total students signed in" stat on the
--    pre-login screen of both index.html and the student panel, meant to
--    encourage more students to sign in and use the site.
-- ============================================================================

create or replace function public.student_login_count()
returns integer
language sql
security definer
set search_path = public
stable
as $$
  select count(*)::integer from public.login_log where role = 'student';
$$;

grant execute on function public.student_login_count() to anon, authenticated;
