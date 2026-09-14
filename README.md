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

The **student panel is open access** — no sign-in required, anyone with the
link can plan their schedule.

The **admin panel is Google-only** — no usernames or passwords live in the
code. It uses [Google Identity Services](https://developers.google.com/identity/gsi/web)
to show a "Sign in with Google" button, since it's the panel that edits the
shared course datasheet.

**Setup:** create an OAuth 2.0 **Web application** client ID in the
[Google Cloud Console](https://console.cloud.google.com/apis/credentials),
add this site's URL(s) under "Authorized JavaScript origins", then paste the
client ID into `GOOGLE_CLIENT_ID` near the top of `admin_panel/script.js`. A
client ID isn't a secret, so it's fine for it to sit in the source.

Optionally set `ALLOWED_HOSTED_DOMAIN` (also near the top of that file) to
restrict admin sign-in to accounts on your university's Google Workspace
domain instead of allowing any Gmail account.

⚠️ **This app still has no backend**, so the ID token Google returns is only
decoded client-side to show the signed-in admin's name/photo — it is **not**
cryptographically verified. That's enough to gate the UI, but before this app
handles real student/faculty data, add a server that verifies the ID token
(e.g. via Google's tokeninfo endpoint or a server-side auth library) and
issues its own session. Never trust the client-decoded payload for anything
that guards real data.

Login state is stored in `sessionStorage`, scoped separately per panel, so
signing into the admin panel doesn't sign you into the student panel and
vice versa. It persists across a page refresh but clears when the tab closes.

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
