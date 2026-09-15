# UniCoPlan

Semester planning, without the clashes.

UniCoPlan is a two-sided web app for planning a university semester's course
offerings and helping students build a clash-free schedule from them. The
shared course datasheet (semesters + courses) lives in Supabase, so the admin
panel and every student's browser see the same live data. A student's
in-progress plan and saved combinations stay in that browser's `localStorage`
only — there's no login system, so there's no account to tie them to across
devices anyway.

## What's in each panel

**Admin panel** (`admin_panel/admin_index.html`)
- Create semesters and build each one's course datasheet (course, section,
  faculty, capacity, room, meeting days/times)
- Add courses manually, one at a time, or bulk-import from a CSV/XLSX/PDF file
- Edit or delete any row from a dedicated "Course datasheet edit" view — new
  and edited rows are kept sorted by course code, then section
- Rows are auto-checked for time-clash conflicts as they're entered
- Changes save to Supabase and appear for every open student tab automatically
  (via Supabase Realtime) — no manual refresh needed

**Student panel** (`student_panel/Std_index.html`)
- Browse a semester's published courses and add them to a working plan
- View the plan as a weekly class schedule, exportable as a PNG
- Save multiple course combinations to compare, each expandable in place to
  preview its own weekly schedule, and apply any saved combination back to
  the plan

Both panels are **open access** — see **Login** below.

## Running it

No build step and no server required:

1. Open `admin_panel/admin_index.html` directly in a browser to manage
   semesters and datasheets.
2. Open `student_panel/Std_index.html` directly to use the student planner.

If your browser blocks `localStorage`/`sessionStorage` on `file://` pages,
serve the folder instead of double-clicking the file, e.g.:

```bash
npx serve .
# or
python3 -m http.server 8000
```

## Database (Supabase)

Semesters and courses are stored in a Supabase project (`semesters` and
`courses` tables, linked by `semester_id`). Both panels connect using the
project's public **anon** key, which is safe to expose client-side — access
is controlled entirely by the tables' Row Level Security policies, which
currently allow open public read/write (matching this app's no-login design).
If you ever add real accounts, tighten those RLS policies to match.

The Supabase project URL and anon key are hardcoded near the top of
`admin_panel/script.js` / `student_panel/script.js` (`SUPABASE_URL`,
`SUPABASE_ANON_KEY`). If you rotate the anon key or move to a different
project, update both files (they're kept identical outside the
`window.APP_ROLE` line — see below).

## Login

Both panels are **open access** — no sign-in, no accounts, no credentials
anywhere in the code. Anyone with the link can use the student panel or the
admin panel, and anyone can write to the shared datasheet directly via the
Supabase API (the RLS policies are intentionally public, matching the
no-login design).

If you later want to restrict who can edit the admin panel, that needs a
real login system — either Supabase Auth (straightforward, since the
database is already in place) or something server-backed. Client-side-only
checks can always be bypassed by reading the page source. Happy to help
build that when you're ready.

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
└── package.json
```

`admin_panel/script.js` and `student_panel/script.js` are identical except
for a single `window.APP_ROLE` line (and one comment) near the top — keep
them in sync if you edit one.

## License

No license is included, so default copyright applies — all rights reserved.
The source is public to view, but it isn't licensed for reuse, modification,
or redistribution.
