# UniCoPlan

Semester planning, without the clashes.

UniCoPlan is a two-sided web app for planning a university semester's course
offerings and helping students build a clash-free schedule from them. Both
panels sign in with Google (via Supabase Auth), and one access-control system
decides who gets into which panel. The shared course datasheet (semesters +
courses) lives in Supabase, so the admin panel and every student's browser
see the same live data. A student's in-progress plan and saved combinations
stay in that browser's `localStorage` — tied to the device, not the signed-in
account, so nobody else (not even that student on another device) can see
them.

## What's in each panel

**Admin panel** (`admin_panel/admin_index.html`)
- **Dashboard** — total student logins, the currently "ongoing" semester
  (starred on the Semesters tab), and how many courses that semester has
- Create semesters and build each one's course datasheet (course, section,
  faculty, capacity, room, meeting days/times); star one semester per app as
  "ongoing" for the Dashboard stat
- Add courses manually, one at a time, or bulk-import from a CSV/XLSX/PDF file
  (select a semester first, then add/import — courses can then be edited or
  deleted individually)
- Edit or delete any row from a dedicated "Course datasheet edit" view — new
  and edited rows are kept sorted by course code, then section
- Rows are auto-checked for time-clash conflicts as they're entered
- **Student** — every student who has signed in, their email, and their name
  once they've set one on their own Profile page
- Changes save to Supabase and appear for every open student tab automatically
  (via Supabase Realtime) — no manual refresh needed
- The main admin gets a **"Manage access"** tab to grant/revoke admin access
  — `mdsaminhossainshipon@gmail.com`, the main admin, can never be removed here

**Student panel** (`student_panel/Std_index.html`)
- **Profile** — set the display name shown (alongside your email) on the
  admin's Student page
- **Available Courses** — select a semester, browse its published courses,
  and add them to a working plan; sort the list A–Z or Z–A
- **Class Schedule** — select a semester to view your plan as a weekly
  timetable, exportable as a PNG
- **Combinations** — select a semester and save multiple course combinations
  to compare, each expandable in place to preview its own weekly schedule,
  and apply any saved combination back to the plan

Both panels require Google sign-in — see **Login & access control** below.

## Running it

No build step and no server required:

1. Open `index.html` — this is the single entry point. It shows one "Sign in
   with Google" button (no panel to pick beforehand); once signed in, it asks
   Supabase which role the account has and sends the browser straight to
   `admin_panel/admin_index.html` or `student_panel/Std_index.html`
   automatically. An account with no role sees a plain "not authorized"
   message instead of either panel.
2. The panel pages can still be opened directly
   (`admin_panel/admin_index.html`, `student_panel/Std_index.html`) — each
   one re-checks the signed-in account's role itself, so a direct link or
   bookmark can't be used to skip the access check.

If your browser blocks `localStorage`/`sessionStorage` on `file://` pages,
serve the folder instead of double-clicking the file, e.g.:

```bash
npx serve .
# or
python3 -m http.server 8000
```

## Database (Supabase)

Semesters and courses are stored in a Supabase project (`semesters` and
`courses` tables, linked by `semester_id`; `semesters.is_current` marks the
one "ongoing" semester shown on the admin Dashboard). There's also a
`user_roles` table (email → `admin` / `main_admin`) that backs the access
control described below, a `profiles` table (email → name, the student
Profile page) and a `login_log` table (email → role, login_count, backing
the Dashboard's "total student logins" stat and the Student page). Both
panels connect using the project's public **anon** key, which is safe to
expose client-side — real access control happens entirely through the
tables' Row Level Security policies and the `current_app_role()` /
`adjust_seat()` / `record_login()` database functions, not anything
client-side.

The Supabase project URL and anon key are hardcoded near the top of
`admin_panel/script.js` / `student_panel/script.js` (`SUPABASE_URL`,
`SUPABASE_ANON_KEY`). If you rotate the anon key or move to a different
project, update both files (they're kept identical outside the
`window.APP_ROLE` line — see below).

## Login & access control

Both panels require signing in with Google. What a signed-in account can do
is resolved entirely server-side, by the `current_app_role()` Postgres
function, in this order:

1. `mdsaminhossainshipon@gmail.com` is always `main_admin` — hardcoded as a
   fallback so the app can never lock out its own main admin, even if the
   `user_roles` table is ever emptied by mistake.
2. Otherwise, if the email has a row in `user_roles`, that row's role
   (`admin` or `main_admin`) applies.
3. Otherwise, any `...@std.ewubd.edu` email is treated as a `student`
   automatically — no row needed.
4. Anyone else gets `none` — signed in, but no access to either panel.

This logic lives entirely in the `current_app_role()` Postgres function on
the Supabase project — it isn't part of any file in this repo, so it has to
be checked/edited directly in the Supabase SQL editor. If sign-in ever grants
the wrong role, that function (not these client files) is where to look —
in particular, double-check it matches on `@std.ewubd.edu` and not a typo of
it, since an earlier version of this README had the domain wrong.

Panel access: `admin` / `main_admin` can use the **admin panel**; `student`,
`admin`, and `main_admin` can all use the **student panel**. The main admin
additionally sees a **"Manage access"** tab in the admin panel to grant or
revoke `admin` access for other Google accounts — that's the only role
change any UI in the app can make; there's no way to grant `main_admin`
status through the UI, on purpose.

Seat counts are the one place students write to the shared datasheet: adding
or dropping a course calls a narrow `adjust_seat()` database function that
only ever touches one course's `seats_taken`, clamped to
`[0, capacity]` server-side so two students grabbing the last seat at once
can't both succeed. Everything else about `semesters`/`courses` is
admin-only to write.

### One manual step: enabling Google sign-in

Supabase doesn't expose an API for configuring OAuth providers, so this part
has to be done by hand, once, in the Supabase Dashboard:

1. In [Google Cloud Console](https://console.cloud.google.com/apis/credentials),
   create an **OAuth 2.0 Client ID** (type: *Web application*).
2. Add this **Authorized redirect URI**:
   `https://jxvpdkpfsexzovbzrrhf.supabase.co/auth/v1/callback`
3. In the Supabase Dashboard → **Authentication → Providers → Google**,
   enable the provider and paste in the Client ID and Client Secret from
   step 1.
4. In **Authentication → URL Configuration**, add the URL(s) where you'll
   host this app (e.g. `https://your-domain.vercel.app/**`) to **Redirect
   URLs**, so Google's redirect back after sign-in is allowed to land there.

Until step 3 is done, the "Sign in with Google" button will show an error
from Supabase rather than the Google account picker — that's expected.

## Deploying

This is a static site backed by Supabase — there's no build step and no
server process to run yourself.

1. **Set up the database** (skip if your Supabase project already has this):
   open `supabase/schema.sql` in the Supabase SQL editor and run it. It
   creates the `semesters`, `courses`, and `user_roles` tables, the
   `current_app_role()` / `adjust_seat()` functions, the row-level security
   policies, and enables Realtime on the two shared tables. Edit the
   `MAIN_ADMIN_EMAIL` constant near the top of the function before running it.
2. Do the one manual step in **Login & access control → "enabling Google
   sign-in"** below — it can't be scripted.
3. **Deploy the frontend to Vercel**: import this repo in Vercel as-is (no
   framework preset / build command needed — it's static HTML). `vercel.json`
   already routes `/student` and `/admin` to the right panel.
4. In Supabase → **Authentication → URL Configuration**, add your Vercel
   deployment's URL (e.g. `https://your-project.vercel.app/**`) to Redirect
   URLs, or Google sign-in will fail after you deploy to a new domain.

## Tests

A small hand-rolled unit test suite covers the trickiest logic — datasheet
time-string parsing, AM/PM inference, and schedule-clash detection:

```bash
npm test
```

## Project structure

```
UniCoPlan/
├── admin_panel/
│   ├── admin_index.html
│   ├── script.js
│   └── style.css
├── student_panel/
│   ├── Std_index.html
│   ├── script.js
│   └── style.css
├── test/
│   └── script.test.js
├── supabase/
│   └── schema.sql
└── package.json
```

`admin_panel/script.js` and `student_panel/script.js` are identical except
for a single `window.APP_ROLE` line (and one comment) near the top — keep
them in sync if you edit one.

## License

No license is included, so default copyright applies — all rights reserved.
The source is public to view, but it isn't licensed for reuse, modification,
or redistribution.
