# UniCoPlan

Semester planning, without the clashes.

UniCoPlan is a two-sided, client-only web app for planning a university semester's
course offerings and helping students build a clash-free schedule from them.
There's no backend or database — everything runs in the browser and persists to
`localStorage` on the device it's opened on.

## What's in each panel

**Admin panel** (`admin_panel/admin_index.html`)
- Create semesters and build each one's course datasheet (course, section,
  faculty, capacity, room, meeting days/times)
- Add courses manually, one at a time, or bulk-import from a CSV/XLSX/PDF file
- Edit or delete any row from a dedicated "Course datasheet edit" view — new
  and edited rows are kept sorted by course code, then section
- Rows are auto-checked for time-clash conflicts as they're entered

**Student panel** (`student_panel/Std_index.html`)
- Browse a semester's published courses and add them to a working plan
- View the plan as a weekly class schedule, exportable as a PNG
- Save multiple course combinations to compare, each expandable in place to
  preview its own weekly schedule, and apply any saved combination back to
  the plan

Both panels sit behind a login screen — see **Login** below before you push
this anywhere public.

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

## Login

Both panels are **open access** — no sign-in, no accounts, no credentials
anywhere in the code. Anyone with the link can use the student panel or the
admin panel.

There's no authentication gate at all right now, so treat both panels as
public: don't put anything in the datasheet you wouldn't want anyone with the
link to see or edit. If you later want to restrict who can edit the admin
panel, that needs a real login system backed by a server (client-side-only
checks can always be bypassed by reading the page source) — happy to help
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
for a single `window.APP_ROLE` line at the top — keep them in sync if you
edit one.

## License

No license is included, so default copyright applies — all rights reserved.
The source is public to view, but it isn't licensed for reuse, modification,
or redistribution.
