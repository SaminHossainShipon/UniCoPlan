  window.APP_ROLE = 'student';
/* ============ constants ============ */
const DAYS = ['Sat','Sun','Mon','Tue','Wed','Thu','Fri'];
// Five tonal variants within the blue/black palette — enough contrast to tell
// courses apart on the timetable without reaching outside the brief's color range.
const COLORS = [
  { bg:'rgba(62,142,255,.16)', bd:'#3E8EFF' },
  { bg:'rgba(143,199,255,.14)', bd:'#8FC7FF' },
  { bg:'rgba(94,234,212,.13)', bd:'#5EEAD4' },
  { bg:'rgba(129,140,248,.15)', bd:'#818CF8' },
  { bg:'rgba(148,163,184,.14)', bd:'#94A3B8' }
];
const DAY_START = 8 * 60;   // 8:00
const DAY_END   = 19 * 60;  // 19:00
const PX_PER_MIN = 1.5; // horizontal scale now — the timetable's time axis runs left-to-right

const DAY_LOOKUP = {
  sat:'Sat', saturday:'Sat',
  sun:'Sun', sunday:'Sun',
  mon:'Mon', monday:'Mon',
  tue:'Tue', tues:'Tue', tuesday:'Tue',
  wed:'Wed', wednesday:'Wed',
  thu:'Thu', thurs:'Thu', thursday:'Thu',
  fri:'Fri', friday:'Fri'
};

// Single-letter day codes used by many university datasheets (e.g. "M 10:10 AM - 11:40 AM",
// "TR 08:30 AM - 10:00 AM"). Deliberately UPPERCASE-only so this never matches ordinary
// mixed-case day names like "Sat" or "Tue" — see parseLetterDayPrefix().
const LETTER_DAY_CODE = { A:'Sat', S:'Sun', M:'Mon', T:'Tue', W:'Wed', R:'Thu', F:'Fri' };

const HEADER_ALIASES = {
  course:   ['course','course code','code','coursecode','course name'],
  section:  ['section','sec'],
  faculty:  ['faculty','instructor','teacher','faculty name'],
  capacity: ['capacity','cap','seats','seat'],
  room:     ['room','room no','room no.','room number','roomno'],
  days:     ['days','day'],
  start:    ['start','start time','starttime','from'],
  end:      ['end','end time','endtime','to'],
  timing:   ['timing','time','schedule']
};

if (typeof pdfjsLib !== 'undefined'){
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
}

/* ============ page role & persistence ============ */
// Each HTML page sets window.APP_ROLE ('student' or 'admin') before loading this
// script, so the student and admin panels are genuinely separate pages rather than
// a client-side toggle.
const ROLE = window.APP_ROLE === 'admin' ? 'admin' : 'student';

const STORAGE_KEYS = {
  selections: 'unicoplan:selections',
  combinations: 'unicoplan:combinations'
};

// Both panels require Google sign-in — see the auth block further down
// (initAuth, PANEL_ALLOWED_ROLES) for how access is decided.

/* ---------- shared datasheet: Supabase ----------
   Semesters and courses are the one piece of data that genuinely needs to be
   shared between the admin (who publishes them) and every student (who needs
   to see the same list) — so they live in Supabase instead of localStorage,
   which is private to a single browser. Student plans/combinations stay in
   localStorage below: they're tied to this browser, not the signed-in
   account, so a student's in-progress plan is never visible to anyone else
   (including that same student on a different device). */
const SUPABASE_URL = 'https://jxvpdkpfsexzovbzrrhf.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imp4dnBka3Bmc2V4em92YnpycmhmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODkzOTk2NzgsImV4cCI6MjEwNDk3NTY3OH0.RY7PpZjBvq5FucTUNKtVF2vmMVyw4aysm91FuJYGVbU';
const sb = (typeof window.supabase !== 'undefined')
  ? window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
  : null;

if (!sb){
  console.error('Supabase client library did not load — check the <script> tag order in the HTML file. Falling back to this device\'s last saved copy only.');
}

// Coalesces bursts of saves (e.g. a bulk import adding 40 rows in a loop) into
// a single round trip instead of firing one per row.
let supabaseSyncInFlight = false;
let supabaseSyncQueued = false;

async function saveSemesters(){
  // Admins own the whole datasheet, so a full resync is correct for them.
  // Students never write semesters/courses in bulk — their only effect on
  // this data is reserving/releasing a seat, which goes through
  // adjustSeatRemote() at the point it happens (see tryAddCourse,
  // removeCourse, applyCombination, and the reset-plan handler below) —
  // so this is a no-op for the student panel.
  if (ROLE === 'admin') await syncSemestersToSupabase();
}

async function syncSemestersToSupabase(){
  if (!sb) return;
  if (supabaseSyncInFlight){ supabaseSyncQueued = true; return; }
  supabaseSyncInFlight = true;
  try {
    const semesterRows = state.semesters.map(s => ({ id: s.id, name: s.name }));

    if (semesterRows.length){
      const { error } = await sb.from('semesters').upsert(semesterRows);
      if (error) throw error;
    }
    // remove semesters that were deleted locally since the last sync
    const { data: existingSem, error: exErr } = await sb.from('semesters').select('id');
    if (exErr) throw exErr;
    const keepSemIds = new Set(semesterRows.map(s => s.id));
    const removeSemIds = (existingSem || []).map(r => r.id).filter(id => !keepSemIds.has(id));
    if (removeSemIds.length) await sb.from('semesters').delete().in('id', removeSemIds);

    // courses: full replace per semester. The datasheet is small (tens to a
    // couple hundred rows), so a delete-then-upsert per save is simple and
    // correct without needing to diff individual row changes.
    for (const sem of state.semesters){
      const courseRows = sem.courses.map(c => ({
        id: c.id,
        semester_id: sem.id,
        code: c.code,
        section: c.section,
        faculty: c.faculty || '',
        capacity: c.capacity,
        seats_taken: c.seatsTaken || 0,
        meetings: c.meetings || []
      }));
      const { data: existingCourses, error: ecErr } = await sb.from('courses').select('id').eq('semester_id', sem.id);
      if (ecErr) throw ecErr;
      const keepCourseIds = new Set(courseRows.map(c => c.id));
      const removeCourseIds = (existingCourses || []).map(r => r.id).filter(id => !keepCourseIds.has(id));
      if (removeCourseIds.length) await sb.from('courses').delete().in('id', removeCourseIds);
      if (courseRows.length){
        const { error: upErr } = await sb.from('courses').upsert(courseRows);
        if (upErr) throw upErr;
      }
    }
  } catch (e){
    console.error('Supabase sync failed — your change is only saved on this device for now. Check your connection and try again.', e);
  } finally {
    supabaseSyncInFlight = false;
    if (supabaseSyncQueued){
      supabaseSyncQueued = false;
      syncSemestersToSupabase();
    }
  }
}

// Pulls the full datasheet down from Supabase (the shared source of truth)
// and rebuilds state.semesters from it.
async function refreshSemestersFromSupabase(){
  if (!sb) return false;
  try {
    const { data: sems, error: semErr } = await sb.from('semesters').select('id,name').order('created_at', { ascending: true });
    if (semErr) throw semErr;
    const { data: courses, error: courseErr } = await sb.from('courses').select('*');
    if (courseErr) throw courseErr;

    const bySemester = {};
    (courses || []).forEach(c => {
      (bySemester[c.semester_id] || (bySemester[c.semester_id] = [])).push({
        id: c.id,
        code: c.code,
        section: c.section,
        faculty: c.faculty || '',
        capacity: c.capacity,
        seatsTaken: c.seats_taken || 0,
        meetings: c.meetings || []
      });
    });

    const semesters = (sems || []).map(s => ({ id: s.id, name: s.name, courses: bySemester[s.id] || [] }));
    semesters.forEach(sem => sortCourses(sem));

    state.semesters = semesters;
    if (!getSemester(state.adminSemesterId) && semesters[0]) state.adminSemesterId = semesters[0].id;
    if (!getSemester(state.studentSemesterId) && semesters[0]) state.studentSemesterId = semesters[0].id;
    return true;
  } catch (e){
    console.error('Could not reach Supabase — showing the last copy this device saw.', e);
    return false;
  }
}

// Reserves (delta=+1) or releases (delta=-1) one seat on a course, atomically
// and server-side — used instead of saveSemesters() for the student-facing
// actions that only ever touch one course's seat count. The `courses` table
// itself stays admin-only for writes; this RPC is the one narrow exception,
// and it clamps to [0, capacity] on the server so two students reserving the
// last seat at once can't both succeed.
async function adjustSeatRemote(courseId, delta){
  if (!sb) return;
  try {
    const { error } = await sb.rpc('adjust_seat', { p_course_id: courseId, p_delta: delta });
    if (error) throw error;
  } catch (e){
    console.error('Could not update seat count on the server — your selection is saved locally, but seat counts may drift until this succeeds.', e);
  }
}

// Live updates: when the admin changes the datasheet, every open student (and
// admin) tab refreshes automatically instead of needing a manual reload.
function subscribeToDatasheetChanges(){
  if (!sb) return;
  sb.channel('datasheet-changes')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'semesters' }, () => onRemoteDatasheetChange())
    .on('postgres_changes', { event: '*', schema: 'public', table: 'courses' }, () => onRemoteDatasheetChange())
    .subscribe();
}
let remoteRefreshTimer = null;
function onRemoteDatasheetChange(){
  // Debounce — a bulk import can fire many change events in quick succession.
  clearTimeout(remoteRefreshTimer);
  remoteRefreshTimer = setTimeout(async () => {
    await refreshSemestersFromSupabase();
    renderApp();
  }, 250);
}

function saveSelections(){
  try { localStorage.setItem(STORAGE_KEYS.selections, JSON.stringify(state.selections)); }
  catch (e) { /* ignore */ }
}

function saveCombinations(){
  try { localStorage.setItem(STORAGE_KEYS.combinations, JSON.stringify(state.combinations)); }
  catch (e) { /* ignore */ }
}

function loadPersistedState(){
  try {
    const rawSel = localStorage.getItem(STORAGE_KEYS.selections);
    if (rawSel) state.selections = JSON.parse(rawSel);
  } catch (e) { /* keep default {} */ }

  try {
    const rawCombos = localStorage.getItem(STORAGE_KEYS.combinations);
    if (rawCombos) state.combinations = JSON.parse(rawCombos);
  } catch (e) { /* keep default {} */ }
  // Note: the shared datasheet itself is no longer loaded here — it only
  // loads once a signed-in user is confirmed authorized (see initAuth below),
  // since an unauthorized visitor shouldn't be able to trigger a fetch of it.
}

/* ============ auth (Google via Supabase) ============
   One shared login for both panels. A visitor's access level — 'none',
   'student', 'admin', or 'main_admin' — comes from the current_app_role()
   database function (see the Supabase migrations), which is the actual
   source of truth: this file only reads that result to decide what to show,
   it never grants access on its own. Each panel additionally restricts which
   roles may use *it* — see PANEL_ALLOWED_ROLES below. */
let authSession = null;   // Supabase auth session, or null if signed out
let appRole = 'none';     // 'none' | 'student' | 'admin' | 'main_admin'
let authChecked = false;  // true once the initial session check has resolved
let realtimeSubscribed = false;

const PANEL_ALLOWED_ROLES = ROLE === 'admin'
  ? ['admin', 'main_admin']
  : ['student', 'admin', 'main_admin'];

function hasAccessToThisPanel(){ return PANEL_ALLOWED_ROLES.includes(appRole); }

async function resolveAppRole(){
  if (!sb || !authSession) return 'none';
  try {
    const { data, error } = await sb.rpc('current_app_role');
    if (error) throw error;
    return data || 'none';
  } catch (e){
    console.error('Could not resolve your access level.', e);
    return 'none';
  }
}

// Called once we know the signed-in user is authorized for this panel —
// pulls the live datasheet and starts listening for further changes.
async function onAuthorized(){
  await refreshSemestersFromSupabase();
  if (!realtimeSubscribed){
    subscribeToDatasheetChanges();
    realtimeSubscribed = true;
  }
}

async function initAuth(){
  if (!sb){ authChecked = true; renderApp(); return; }

  const { data } = await sb.auth.getSession();
  authSession = data.session;
  appRole = await resolveAppRole();
  authChecked = true;
  if (hasAccessToThisPanel()) await onAuthorized();
  renderApp();

  // Handles sign-in, sign-out, and token refresh after this initial check —
  // e.g. the redirect back from Google, or the user clicking "Sign out".
  sb.auth.onAuthStateChange(async (_event, session) => {
    authSession = session;
    appRole = await resolveAppRole();
    if (hasAccessToThisPanel()) await onAuthorized();
    renderApp();
  });
}

function signInWithGoogle(){
  if (!sb) return;
  sb.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: window.location.origin + window.location.pathname }
  });
}

function signOut(){
  if (!sb) return;
  sb.auth.signOut();
}

// Cross-tab sync: if the admin panel and student panel are open in different tabs
// on the *same device*, pick up local plan/combination changes made in the other
// tab without needing a manual refresh. The shared datasheet itself syncs across
// devices too, via the Supabase realtime subscription above.
window.addEventListener('storage', e => {
  if (e.key === STORAGE_KEYS.selections){
    try {
      state.selections = JSON.parse(e.newValue || '{}');
      renderApp();
    } catch (err) { /* ignore malformed payloads */ }
  }
  if (e.key === STORAGE_KEYS.combinations){
    try {
      state.combinations = JSON.parse(e.newValue || '{}');
      renderApp();
    } catch (err) { /* ignore malformed payloads */ }
  }
});

/* ============ state ============ */
const state = {
  adminInputMode: 'manual', // 'manual' | 'import'
  adminPage: 'semesters',   // 'semesters' | 'datasheet' | 'timetable'
  semesters: [],
  adminSemesterId: null,
  studentSemesterId: null,
  studentPage: 'plan',      // 'plan' | 'timetable' | 'combinations'
  editingCourseId: null,
  selections: {},   // semesterId -> [courseId, ...]  (max 5 per semester)
  combinations: {}, // semesterId -> [{ id, name, courseIds, createdAt }, ...]
  search: '',
  adminSearch: '',
  accessList: [], // rows from user_roles — loaded on demand when the main admin opens "Manage access"
  accessListLoaded: false
};
const MAX_PLAN_COURSES = 5;
let importPreviewData = [];

/* ============ generic helpers ============ */
function uid(prefix){ return prefix + Math.random().toString(36).slice(2, 9); }
function getSemester(id){ return state.semesters.find(s => s.id === id); }
function toMinutes(t){ const [h, m] = t.split(':').map(Number); return h * 60 + m; }
function overlapsRange(aS, aE, bS, bE){ return aS < bE && bS < aE; }
function sharedDays(d1, d2){ return d1.filter(d => d2.includes(d)); }

function escapeHtml(str){
  return String(str).replace(/[&<>"']/g, c => ({
    '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'
  }[c]));
}

// TBA/placeholder text ("TBA", "TBA3", "Project", blank) shows up constantly in real
// datasheets for rooms and faculty that haven't been assigned yet. We still store and
// display it, but we never let it participate in clash detection — treating every
// "TBA" faculty as the same person, or every "Project" room as the same room, would
// manufacture false conflicts across unrelated courses.
function isPlaceholderText(str){
  if (!str) return true;
  const s = String(str).trim().toLowerCase();
  if (!s) return true;
  return /tba/.test(s) || s === 'project' || s === 'n/a' || s === 'na';
}

function fmtTime(t){
  const [h, m] = t.split(':').map(Number);
  const suf = h >= 12 ? 'PM' : 'AM';
  let hh = h % 12; if (hh === 0) hh = 12;
  return hh + ':' + String(m).padStart(2, '0') + ' ' + suf;
}
function fmtHourLabel(min){
  const h = Math.floor(min / 60);
  const suf = h >= 12 ? 'PM' : 'AM';
  let hh = h % 12; if (hh === 0) hh = 12;
  return hh + suf;
}
function fmtDays(days){ return DAYS.filter(d => days.includes(d)).join('/'); }

// A course can now have more than one "meeting" (different day/time/room combos —
// common when a datasheet lists each meeting day of the same section as its own row,
// sometimes in a different room). These helpers render one or many meetings consistently.
function fmtMeetingLine(m){
  const facultyPart = m.faculty ? ` · ${m.faculty}` : '';
  const roomPart = m.room ? ` · Room ${m.room}` : '';
  return `${fmtDays(m.days)} · ${fmtTime(m.start)}–${fmtTime(m.end)}${roomPart}${facultyPart}`;
}
function fmtMeetingsBlock(meetings){
  if (!meetings || !meetings.length) return '—';
  return meetings.map(m => escapeHtml(fmtMeetingLine(m))).join('<br>');
}
function fmtMeetingsInline(meetings){
  if (!meetings || !meetings.length) return '—';
  return meetings.map(fmtMeetingLine).join('; ');
}

function normalizeDayToken(tok){
  const key = String(tok).trim().toLowerCase();
  return DAY_LOOKUP[key] || null;
}

function to24Hour(raw){
  if (raw === null || raw === undefined) return null;
  let t = String(raw).trim().toLowerCase();
  if (!t) return null;
  // already HH:MM 24h
  if (/^\d{1,2}:\d{2}$/.test(t) && !/am|pm/.test(t)){
    const [h,m] = t.split(':').map(Number);
    if (h>23||m>59) return null;
    return String(h).padStart(2,'0')+':'+String(m).padStart(2,'0');
  }
  const m = t.match(/^(\d{1,2})(:(\d{2}))?\s*(am|pm)?$/);
  if (!m) return null;
  let h = parseInt(m[1],10);
  const min = m[3] ? parseInt(m[3],10) : 0;
  const suf = m[4];
  if (suf === 'pm' && h < 12) h += 12;
  if (suf === 'am' && h === 12) h = 0;
  if (h>23||min>59) return null;
  return String(h).padStart(2,'0')+':'+String(min).padStart(2,'0');
}

// Matches a leading UPPERCASE day code like "M", "TR", "MW" immediately followed by
// whitespace and a digit (the start of the time). Case-sensitive on purpose: lowercase
// letters in a real day name (e.g. the "a" and "t" in "Sat") must never be read as codes.
function parseLetterDayPrefix(text){
  const m = text.match(/^([ASMTWRF]{1,3})\s+\d/);
  if (!m) return null;
  const days = [];
  for (const ch of m[1]){
    const d = LETTER_DAY_CODE[ch];
    if (!d) return null;
    if (!days.includes(d)) days.push(d);
  }
  return days.length ? days : null;
}

function parseTiming(raw){
  if (!raw) return null;
  const text = String(raw).trim();

  let foundDays = parseLetterDayPrefix(text);
  if (!foundDays){
    foundDays = [];
    const dayRegex = /(saturday|sunday|monday|tuesday|wednesday|thursday|friday|sat|sun|mon|tue|tues|wed|thu|thurs|fri)/gi;
    let dm;
    while ((dm = dayRegex.exec(text))){
      const mapped = normalizeDayToken(dm[0]);
      if (mapped && !foundDays.includes(mapped)) foundDays.push(mapped);
    }
  }

  const timeRegex = /\d{1,2}(:\d{2})?\s*(am|pm)?/gi;
  const times = [];
  let m;
  while ((m = timeRegex.exec(text))){
    if (m[0].trim()) times.push(m[0].trim());
  }
  if (times.length < 2) return null;
  let start = to24Hour(times[0]);
  let end = to24Hour(times[1]);
  if (!start || !end) return null;

  if (!/am|pm/i.test(times[1]) && toMinutes(end) < 7 * 60){
    const pmEnd = to24Hour(times[1] + ' pm');
    if (pmEnd) end = pmEnd;
  }

  if (!/am|pm/i.test(times[0])){
    const pmStart = to24Hour(times[0] + ' pm');
    if (pmStart && toMinutes(pmStart) < toMinutes(end) && toMinutes(pmStart) >= 7 * 60){
      start = pmStart;
    }
  }

  return { days: foundDays, start, end };
}

// Real capacity columns are often "enrolled/total" (e.g. "12/40"), not a plain number.
// Imported sheets never carry live enrollment for this app (seats are only ever
// taken up by students adding a course here), so we deliberately ignore the
// "enrolled" half of that format and only ever take the total capacity.
function parseCapacity(raw){
  if (raw === undefined || raw === null) return { total: NaN, taken: 0 };
  const s = String(raw).trim();
  if (!s) return { total: NaN, taken: 0 };
  const m = s.match(/^(\d+)\s*\/\s*(\d+)$/);
  if (m) return { taken: 0, total: parseInt(m[2], 10) };
  const n = parseInt(s, 10);
  return { taken: 0, total: isNaN(n) ? NaN : n };
}

// A course now carries a `meetings` array — one entry per distinct day/time/room
// combination — instead of a single days/start/end/room set. All conflict checks
// compare every meeting of one course against every meeting of the other.
function findScheduleConflict(course, others){
  for (const o of others){
    if (o.id === course.id) continue;
    for (const cm of course.meetings){
      for (const om of o.meetings){
        const sd = sharedDays(cm.days, om.days);
        if (sd.length && overlapsRange(toMinutes(cm.start), toMinutes(cm.end), toMinutes(om.start), toMinutes(om.end))){
          return { other:o, days:sd, otherMeeting:om };
        }
      }
    }
  }
  return null;
}
function findRoomConflict(candidate, courses){
  for (const cm of candidate.meetings){
    if (isPlaceholderText(cm.room)) continue;
    for (const o of courses){
      for (const om of o.meetings){
        if (isPlaceholderText(om.room)) continue;
        if (om.room.trim().toLowerCase() !== cm.room.trim().toLowerCase()) continue;
        const sd = sharedDays(cm.days, om.days);
        if (sd.length && overlapsRange(toMinutes(cm.start), toMinutes(cm.end), toMinutes(om.start), toMinutes(om.end))){
          return { other:o, days:sd, room:cm.room };
        }
      }
    }
  }
  return null;
}
function findFacultyConflict(candidate, courses){
  for (const cm of candidate.meetings){
    const cmFaculty = cm.faculty || candidate.faculty;
    if (isPlaceholderText(cmFaculty)) continue;
    for (const o of courses){
      for (const om of o.meetings){
        const omFaculty = om.faculty || o.faculty;
        if (isPlaceholderText(omFaculty)) continue;
        if (omFaculty.trim().toLowerCase() !== cmFaculty.trim().toLowerCase()) continue;
        const sd = sharedDays(cm.days, om.days);
        if (sd.length && overlapsRange(toMinutes(cm.start), toMinutes(cm.end), toMinutes(om.start), toMinutes(om.end))){
          return { other:o, days:sd, faculty:cmFaculty };
        }
      }
    }
  }
  return null;
}

function validateCandidate(candidate, referenceCourses){
  if (!candidate.code) return 'Missing course code.';
  if (!candidate.section) return 'Missing section.';
  if (!candidate.meetings || candidate.meetings.length === 0) return 'No valid meeting days/times found.';
  for (const m of candidate.meetings){
    if (!m.days || m.days.length === 0) return 'No valid meeting days found.';
    if (!m.start || !m.end) return 'Could not read a valid time range.';
    if (toMinutes(m.start) >= toMinutes(m.end)) return 'End time must be after start time.';
  }
  if (candidate.capacity === undefined || candidate.capacity === null || isNaN(candidate.capacity) || candidate.capacity < 0) return 'Capacity must be a number (0 or more).';

  const dup = referenceCourses.find(c => c.code.toLowerCase() === candidate.code.toLowerCase() && c.section.toLowerCase() === candidate.section.toLowerCase());
  if (dup) return `${candidate.code} — Section ${candidate.section} already exists.`;

  const roomConflict = findRoomConflict(candidate, referenceCourses);
  if (roomConflict) return `Room ${roomConflict.room} clashes with ${roomConflict.other.code}-${roomConflict.other.section} on ${fmtDays(roomConflict.days)}.`;

  const facConflict = findFacultyConflict(candidate, referenceCourses);
  if (facConflict) return `${facConflict.faculty} already teaches ${facConflict.other.code}-${facConflict.other.section} at that time.`;

  return null;
}

// Bulk file import is deliberately permissive: real datasheets routinely have
// sections that share a room/faculty slot, repeat rows, or are missing a field
// or two, and none of that should stop the row from being imported. The only
// thing that makes a row genuinely unusable is having neither a course code
// nor a section to identify it by.
function validateImportCandidate(candidate){
  if (!candidate.code && !candidate.section) return 'Empty row — no course code or section found.';
  if (!candidate.code) return 'Missing course code.';
  if (!candidate.section) return 'Missing section.';
  return null;
}

// Keeps a semester's datasheet in a stable, predictable order (course code, then
// section — numeric-aware so CSE9 sorts before CSE10) any time a row is added or
// edited, rather than leaving new rows tacked on at the end.
function sortCourses(sem){
  if (!sem || !Array.isArray(sem.courses)) return;
  sem.courses.sort((a, b) => {
    const codeCmp = String(a.code).localeCompare(String(b.code), undefined, { numeric: true, sensitivity: 'base' });
    if (codeCmp !== 0) return codeCmp;
    return String(a.section).localeCompare(String(b.section), undefined, { numeric: true, sensitivity: 'base' });
  });
}

function showFlash(el, type, text){
  if (!el) return;
  el.className = 'flash flash-' + type;
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(el._t);
  // Success messages are quick confirmations and can fade on their own;
  // errors often need reading and acting on, so they stay until the next action.
  if (type === 'success'){
    el._t = setTimeout(() => el.classList.remove('show'), 4500);
  }
}

/* ============ (no seed data — app starts empty) ============ */

/* ============ render: shell ============ */
function renderApp(){
  renderHeader();
  if (!authChecked){
    document.getElementById('mainView').innerHTML = `<div class="empty-state"><p>Loading…</p></div>`;
    return;
  }
  if (!authSession){
    renderLoginScreen();
    return;
  }
  if (!hasAccessToThisPanel()){
    renderNotAuthorizedScreen();
    return;
  }
  renderMain();
}

function renderHeader(){
  const header = document.getElementById('header');
  header.classList.remove('header-has-logout');
  const avatarUrl = authSession && authSession.user.user_metadata ? authSession.user.user_metadata.avatar_url : null;
  const userBlock = authSession ? `
    <div class="header-user">
      ${avatarUrl ? `<img class="header-avatar" src="${escapeHtml(avatarUrl)}" alt="">` : ''}
      <span class="header-username">${escapeHtml(authSession.user.email)}</span>
    </div>
    <button type="button" class="logout-btn" id="signOutBtn">Sign out</button>
  ` : '';
  header.innerHTML = `
    <div class="header-brand">
      <span class="brand-mark" id="brandLogo" role="button" tabindex="0" title="Refresh">UniCoPlan</span>
      <span class="brand-sub">Semester planning, without the clashes</span>
    </div>
    ${userBlock}
  `;
  if (authSession) header.classList.add('header-has-logout');
  const logo = document.getElementById('brandLogo');
  if (logo){
    logo.addEventListener('click', () => window.location.reload());
    logo.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' '){ e.preventDefault(); window.location.reload(); }
    });
  }
  const signOutBtn = document.getElementById('signOutBtn');
  if (signOutBtn) signOutBtn.addEventListener('click', signOut);
}

// Shown when nobody is signed in yet — neither panel shows any app content
// until Google sign-in succeeds.
function renderLoginScreen(){
  const main = document.getElementById('mainView');
  const panelLabel = ROLE === 'admin' ? 'admin panel' : 'student panel';
  main.innerHTML = `
    <div class="login-wrap">
      <div class="login-card form-card">
        <h2>Sign in to continue</h2>
        <p class="login-sub empty-note" style="padding:0 0 4px">Use your Google account to access the ${panelLabel}.</p>
        <div class="google-signin-btn">
          <button type="button" class="btn btn-primary" id="googleSignInBtn" style="width:auto; padding:10px 26px;">Sign in with Google</button>
        </div>
      </div>
    </div>
  `;
  const btn = document.getElementById('googleSignInBtn');
  if (btn) btn.addEventListener('click', signInWithGoogle);
}

// Shown when someone is signed in, but their account isn't authorized for
// *this* panel (e.g. a student opening the admin panel, or an unlisted
// Google account trying either one).
function renderNotAuthorizedScreen(){
  const main = document.getElementById('mainView');
  const panelLabel = ROLE === 'admin' ? 'admin panel' : 'student panel';
  // The only case where the signed-in account can use the *other* panel is
  // an admin/main admin blocked from here for some transient reason, or a
  // student who landed on the admin panel by mistake — the reverse never
  // happens, since admins already have access to the student panel too.
  const showStudentLink = ROLE === 'admin' && appRole === 'student';
  main.innerHTML = `
    <div class="login-wrap">
      <div class="login-card form-card">
        <h2>Not authorized</h2>
        <p class="login-sub empty-note" style="padding:0 0 4px">${escapeHtml(authSession.user.email)} doesn't have access to the ${panelLabel}.</p>
        ${showStudentLink ? `<p class="login-sub"><a href="../student_panel/Std_index.html">Go to the student panel instead →</a></p>` : ''}
        <button type="button" class="btn btn-ghost" id="notAuthSignOutBtn" style="width:100%; margin-top:10px;">Sign out</button>
      </div>
    </div>
  `;
  const btn = document.getElementById('notAuthSignOutBtn');
  if (btn) btn.addEventListener('click', signOut);
}

function renderMain(){
  const main = document.getElementById('mainView');
  if (ROLE === 'admin'){
    main.innerHTML = adminTemplate();
    bindAdminEvents();
    if (state.adminInputMode === 'manual') renderAdminTable();
    renderAdminEditTable();
  } else {
    main.innerHTML = studentTemplate();
    bindStudentEvents();
    renderAvailableList();
    renderTimetable();
    renderSelectedList();
  }
}

/* ============ admin view ============ */
function semesterTabsHTML(activeId){
  if (state.semesters.length === 0){
    return `<p class="empty-note">No semesters yet — create one to get started.</p>`;
  }
  return `<div class="tabs">${state.semesters.map(s => `
    <div class="tab ${s.id === activeId ? 'active' : ''}" data-tab="${s.id}" role="tab" tabindex="0">
      <span class="tab-label">${escapeHtml(s.name)}<span class="tab-count">${s.courses.length}</span></span>
      <button type="button" class="tab-del" data-tab-del="${s.id}" title="Delete ${escapeHtml(s.name)}" aria-label="Delete semester ${escapeHtml(s.name)} and all its courses">✕</button>
    </div>
  `).join('')}</div>`;
}

function adminPageNavHTML(){
  const items = [
    { key:'semesters', label:'Semesters' },
    { key:'datasheet', label:'Course datasheet edit' }
  ];
  if (appRole === 'main_admin') items.push({ key:'access', label:'Manage access' });
  return `<div class="page-nav">${items.map(i => `
    <button type="button" class="page-nav-btn ${state.adminPage === i.key ? 'active' : ''}" data-admin-page="${i.key}">${i.label}</button>
  `).join('')}</div>`;
}

function adminTemplate(){
  const nav = adminPageNavHTML();

  if (state.adminPage === 'datasheet') return nav + adminDatasheetEditTemplate();
  if (state.adminPage === 'access' && appRole === 'main_admin') return nav + adminAccessTemplate();

  return nav + `
    <section class="semester-panel">
      <div class="semester-panel-head">
        <h2>Semesters</h2>
        <form id="newSemesterForm" class="inline-form">
          <input type="text" id="newSemesterName" required>
          <button type="submit" class="btn btn-ghost">+ New semester</button>
        </form>
      </div>
      ${semesterTabsHTML(state.adminSemesterId)}
    </section>
    ${state.adminSemesterId ? adminWorkspaceTemplate() : `
      <div class="empty-state"><p>Create a semester above, then add its course datasheet before students can register.</p></div>
    `}
  `;
}

// Dedicated page for editing existing datasheet rows in place (the original
// "Course datasheet" list on the Semesters tab stays delete-only, unchanged).
function adminDatasheetEditTemplate(){
  if (!state.adminSemesterId){
    return `
      <section class="semester-panel">
        <h2>Course datasheet edit</h2>
        ${semesterTabsHTML(state.adminSemesterId)}
      </section>
      <div class="empty-state"><p>Create a semester from the Semesters tab first.</p></div>
    `;
  }
  const sem = getSemester(state.adminSemesterId);
  return `
    <section class="semester-panel">
      <h2>Course datasheet edit</h2>
      ${semesterTabsHTML(state.adminSemesterId)}
    </section>
    <section class="table-card" style="margin-top:22px">
      <div class="table-card-head">
        <h3>Editing <span class="muted">— ${escapeHtml(sem.name)}, ${sem.courses.length} course${sem.courses.length === 1 ? '' : 's'}</span></h3>
        <div class="row-actions">
          <div class="search-wrap admin-search-wrap">
            <input type="search" id="adminEditSearch" value="${escapeHtml(state.adminSearch)}">
          </div>
          <button type="button" class="btn btn-primary" id="openAddCourseBtn">+ Add course</button>
        </div>
      </div>
      <div id="adminEditTableContainer"></div>
    </section>
  `;
}

function adminWorkspaceTemplate(){
  const sem = getSemester(state.adminSemesterId);
  return `
    <section class="workspace">
      <div class="form-card">
        <h3>Build the datasheet — ${escapeHtml(sem.name)}</h3>
        <div class="mode-toggle">
          <button type="button" class="mode-btn ${state.adminInputMode === 'manual' ? 'active' : ''}" data-mode="manual">Manual entry</button>
          <button type="button" class="mode-btn ${state.adminInputMode === 'import' ? 'active' : ''}" data-mode="import">Import file</button>
        </div>
        ${state.adminInputMode === 'manual' ? manualFormHTML() : importModeHTML()}
      </div>
      <div class="table-card">
        <div class="table-card-head">
          <h3>Course datasheet <span class="muted">— ${sem.courses.length} course${sem.courses.length === 1 ? '' : 's'}</span></h3>
          <div class="search-wrap admin-search-wrap">
            <input type="search" id="adminCourseSearch" value="${escapeHtml(state.adminSearch)}">
          </div>
        </div>
        <div id="adminTableContainer"></div>
      </div>
    </section>
  `;
}

function manualFormHTML(){
  return `
    <form id="addCourseForm">
      <div id="adminFlash" class="flash"></div>
      <div class="form-row">
        <label>Course
          <input type="text" name="code" required>
        </label>
        <label>Section
          <input type="text" name="section" required>
        </label>
      </div>
      <label>Faculty <span class="muted">(optional)</span>
        <input type="text" name="faculty">
      </label>
      <div class="form-row">
        <label>Capacity
          <input type="number" name="capacity" min="1" value="40" required>
        </label>
        <label>Room no. <span class="muted">(optional)</span>
          <input type="text" name="room">
        </label>
      </div>
      <fieldset class="day-picker">
        <legend>Meets on</legend>
        ${DAYS.map(d => `
          <label class="day-check">
            <input type="checkbox" name="days" value="${d}">
            <span>${d}</span>
          </label>
        `).join('')}
      </fieldset>
      <div class="form-row">
        <label>Start time
          <input type="time" name="start" value="09:00" required>
        </label>
        <label>End time
          <input type="time" name="end" value="10:30" required>
        </label>
      </div>
      <button type="submit" class="btn btn-primary">Add to datasheet</button>
    </form>
  `;
}

function importModeHTML(){
  return `
    <div id="importFlash" class="flash"></div>
    <div id="dropZone" class="drop-zone">
      <span class="file-icon">⤓</span>
      <p>Drag &amp; drop a file here, or <span class="drop-browse">browse</span></p>
      <input type="file" id="importFileInput" accept=".csv,.xlsx,.xls,.pdf" hidden>
    </div>
    <p class="import-help">Upload a CSV, Excel (.xlsx/.xls), or PDF file. Use columns for Course, Section, Faculty, Capacity, Room, and either Days/Start/End or one combined Timing column — e.g. <span class="mono">Sat/Mon/Wed 9:00 AM-10:15 AM</span>, or single-letter day codes like <span class="mono">M</span> or <span class="mono">TR 08:30 AM-10:00 AM</span> (A=Sat, S=Sun, M=Mon, T=Tue, W=Wed, R=Thu, F=Fri). Capacity can be a plain number or "enrolled/total" like <span class="mono">12/40</span> — if it's the latter, only the total is imported, since seat counts aren't tracked here. Rows that share the same Course + Section are merged into one course with several meeting times/rooms — handy for datasheets that list each meeting day as its own row. Excel files with more than one sheet let you pick which sheet to import (or combine them all). Every row with a course code and section is imported as-is — shared rooms, shared faculty, repeated sections, and missing details are all let through without errors.</p>
    <div id="importFileName" class="import-file-name"></div>
    <div id="importSheetPickerWrap"></div>
    <div id="importPreviewContainer"></div>
  `;
}

function renderAdminTable(){
  const container = document.getElementById('adminTableContainer');
  if (!container) return;
  const sem = getSemester(state.adminSemesterId);
  if (!sem || sem.courses.length === 0){
    container.innerHTML = `<p class="empty-note">No courses added yet. Use the form to add the first one, or import a file.</p>`;
    return;
  }
  let courses = sem.courses;
  if (state.adminSearch && state.adminSearch.trim()){
    const q = state.adminSearch.trim().toLowerCase();
    courses = courses.filter(c => c.code.toLowerCase().includes(q) || c.faculty.toLowerCase().includes(q) || c.section.toLowerCase().includes(q));
  }
  if (courses.length === 0){
    container.innerHTML = `<p class="empty-note">No courses match your search.</p>`;
    return;
  }
  container.innerHTML = `
    <table class="ledger">
      <thead><tr>
        <th>Course</th><th>Sec</th><th>Faculty</th><th>Cap</th><th>Schedule</th><th></th>
      </tr></thead>
      <tbody>
        ${courses.map(c => `
          <tr>
            <td class="mono">${escapeHtml(c.code)}</td>
            <td>${escapeHtml(c.section)}</td>
            <td>${escapeHtml(c.faculty)}</td>
            <td>${isNaN(c.capacity) ? '—' : c.capacity}</td>
            <td class="mono">${fmtMeetingsBlock(c.meetings)}</td>
            <td><button class="icon-btn" data-del="${c.id}" title="Remove course">✕</button></td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
  container.querySelectorAll('[data-del]').forEach(btn => {
    btn.addEventListener('click', () => {
      const s = getSemester(state.adminSemesterId);
      s.courses = s.courses.filter(c => c.id !== btn.dataset.del);
      Object.keys(state.selections).forEach(semId => {
        state.selections[semId] = (state.selections[semId] || []).filter(id => id !== btn.dataset.del);
      });
      saveSemesters();
      saveSelections();
      renderMain();
    });
  });
}

// Course datasheet edit page: same rows as the main datasheet table, but every
// row also gets an Edit button that opens the modal below instead of just delete.
function renderAdminEditTable(){
  const container = document.getElementById('adminEditTableContainer');
  if (!container) return;
  const sem = getSemester(state.adminSemesterId);
  if (!sem || sem.courses.length === 0){
    container.innerHTML = `<p class="empty-note">No courses to edit yet. Add some from the Semesters tab.</p>`;
    return;
  }
  let courses = sem.courses;
  if (state.adminSearch && state.adminSearch.trim()){
    const q = state.adminSearch.trim().toLowerCase();
    courses = courses.filter(c => c.code.toLowerCase().includes(q) || c.faculty.toLowerCase().includes(q) || c.section.toLowerCase().includes(q));
  }
  if (courses.length === 0){
    container.innerHTML = `<p class="empty-note">No courses match your search.</p>`;
    return;
  }
  container.innerHTML = `
    <table class="ledger">
      <thead><tr>
        <th>Course</th><th>Sec</th><th>Faculty</th><th>Cap</th><th>Schedule</th><th></th>
      </tr></thead>
      <tbody>
        ${courses.map(c => `
          <tr>
            <td class="mono">${escapeHtml(c.code)}</td>
            <td>${escapeHtml(c.section)}</td>
            <td>${escapeHtml(c.faculty)}</td>
            <td>${isNaN(c.capacity) ? '—' : c.capacity}</td>
            <td class="mono">${fmtMeetingsBlock(c.meetings)}</td>
            <td class="row-actions">
              <button class="icon-btn" data-edit="${c.id}" title="Edit course">✎</button>
              <button class="icon-btn" data-del="${c.id}" title="Remove course">✕</button>
            </td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
  container.querySelectorAll('[data-edit]').forEach(btn => {
    btn.addEventListener('click', () => openEditCourseModal(btn.dataset.edit));
  });
  container.querySelectorAll('[data-del]').forEach(btn => {
    btn.addEventListener('click', () => {
      const s = getSemester(state.adminSemesterId);
      s.courses = s.courses.filter(c => c.id !== btn.dataset.del);
      Object.keys(state.selections).forEach(semId => {
        state.selections[semId] = (state.selections[semId] || []).filter(id => id !== btn.dataset.del);
      });
      saveSemesters();
      saveSelections();
      renderMain();
    });
  });
}

// Edit-course modal — pre-fills from the course's first meeting. Courses with more
// than one meeting (typically from a file import) are flattened to one meeting on
// save; a notice in the modal makes that explicit rather than silently dropping rows.
function openEditCourseModal(courseId){
  const sem = getSemester(state.adminSemesterId);
  const course = sem && sem.courses.find(c => c.id === courseId);
  if (!course) return;
  state.editingCourseId = courseId;

  const m = (course.meetings && course.meetings[0]) || { days: [], start: '09:00', end: '10:30', room: '' };
  document.getElementById('editCode').value = course.code;
  document.getElementById('editSection').value = course.section;
  document.getElementById('editFaculty').value = course.faculty || '';
  document.getElementById('editCapacity').value = isNaN(course.capacity) ? '' : course.capacity;
  document.getElementById('editRoom').value = m.room || '';
  document.querySelectorAll('#editCourseForm input[name="days"]').forEach(cb => {
    cb.checked = m.days.includes(cb.value);
  });
  document.getElementById('editStart').value = m.start || '09:00';
  document.getElementById('editEnd').value = m.end || '10:30';

  const note = document.getElementById('editMultiMeetingNote');
  if (note) note.style.display = (course.meetings && course.meetings.length > 1) ? 'block' : 'none';

  const flash = document.getElementById('editFlash');
  if (flash){ flash.textContent = ''; flash.classList.remove('show'); }

  const overlay = document.getElementById('editModalOverlay');
  if (overlay) overlay.style.display = 'flex';
}

function closeEditCourseModal(){
  state.editingCourseId = null;
  const overlay = document.getElementById('editModalOverlay');
  if (overlay) overlay.style.display = 'none';
}

function saveEditedCourse(form){
  const sem = getSemester(state.adminSemesterId);
  const course = sem && sem.courses.find(c => c.id === state.editingCourseId);
  if (!sem || !course){ closeEditCourseModal(); return; }

  const fd = new FormData(form);
  const code = (fd.get('code') || '').trim();
  const section = (fd.get('section') || '').trim();
  const faculty = (fd.get('faculty') || '').trim();
  const capacity = parseInt(fd.get('capacity'), 10);
  const room = (fd.get('room') || '').trim();
  const start = fd.get('start');
  const end = fd.get('end');
  const days = fd.getAll('days');

  const candidate = { id: course.id, code, section, faculty, capacity, meetings: [{ days, start, end, room, faculty }] };
  const others = sem.courses.filter(c => c.id !== course.id);
  const err = validateCandidate(candidate, others);
  const flash = document.getElementById('editFlash');
  if (err){ showFlash(flash, 'error', err); return; }

  course.code = code;
  course.section = section;
  course.faculty = faculty;
  course.capacity = capacity;
  course.meetings = [{ days, start, end, room, faculty }];

  sortCourses(sem);
  saveSemesters();
  closeEditCourseModal();
  renderMain();
}

// Add-course modal — used from the Course datasheet edit page. Same validation
// as the manual entry form, but the new row is inserted in sorted order rather
// than appended, so the datasheet edit table always reads code/section-order.
function openAddCourseModal(){
  const form = document.getElementById('addCourseFormModal');
  if (form) form.reset();
  document.getElementById('addCapacity').value = 40;
  document.getElementById('addStart').value = '09:00';
  document.getElementById('addEnd').value = '10:30';
  const flash = document.getElementById('addFlash');
  if (flash){ flash.textContent = ''; flash.classList.remove('show'); }
  const overlay = document.getElementById('addModalOverlay');
  if (overlay) overlay.style.display = 'flex';
}

function closeAddCourseModal(){
  const overlay = document.getElementById('addModalOverlay');
  if (overlay) overlay.style.display = 'none';
}

function saveAddedCourse(form){
  const sem = getSemester(state.adminSemesterId);
  if (!sem) return;
  const fd = new FormData(form);
  const candidate = {
    id: 'temp',
    code: (fd.get('code') || '').trim(),
    section: (fd.get('section') || '').trim(),
    faculty: (fd.get('faculty') || '').trim(),
    capacity: parseInt(fd.get('capacity'), 10),
    meetings: [{
      room: (fd.get('room') || '').trim(),
      start: fd.get('start'),
      end: fd.get('end'),
      days: fd.getAll('days'),
      faculty: (fd.get('faculty') || '').trim()
    }]
  };
  const flash = document.getElementById('addFlash');
  const err = validateCandidate(candidate, sem.courses);
  if (err){ showFlash(flash, 'error', err); return; }

  candidate.id = uid('c_');
  candidate.seatsTaken = 0;
  sem.courses.push(candidate);
  sortCourses(sem);
  saveSemesters();
  closeAddCourseModal();
  renderMain();
}

function initAddModal(){
  const dayChecksWrap = document.getElementById('addDayChecks');
  if (dayChecksWrap){
    dayChecksWrap.innerHTML = DAYS.map(d => `
      <label class="day-check">
        <input type="checkbox" name="days" value="${d}">
        <span>${d}</span>
      </label>
    `).join('');
  }
  const overlay = document.getElementById('addModalOverlay');
  const cancelBtn = document.getElementById('addCancelBtn');
  const form = document.getElementById('addCourseFormModal');
  if (cancelBtn) cancelBtn.addEventListener('click', closeAddCourseModal);
  if (overlay) overlay.addEventListener('click', e => { if (e.target === overlay) closeAddCourseModal(); });
  if (form) form.addEventListener('submit', e => { e.preventDefault(); saveAddedCourse(form); });
}

function initEditModal(){
  const dayChecksWrap = document.getElementById('editDayChecks');
  if (dayChecksWrap){
    dayChecksWrap.innerHTML = DAYS.map(d => `
      <label class="day-check">
        <input type="checkbox" name="days" value="${d}">
        <span>${d}</span>
      </label>
    `).join('');
  }
  const overlay = document.getElementById('editModalOverlay');
  const cancelBtn = document.getElementById('editCancelBtn');
  const form = document.getElementById('editCourseForm');
  if (cancelBtn) cancelBtn.addEventListener('click', closeEditCourseModal);
  if (overlay) overlay.addEventListener('click', e => { if (e.target === overlay) closeEditCourseModal(); });
  if (form) form.addEventListener('submit', e => { e.preventDefault(); saveEditedCourse(form); });
}

// Renders the weekly timetable grid into any container, given the list of courses
// to plot. Shared by the student's personal timetable and the admin's full-datasheet
// timetable so both stay visually and behaviorally identical.
function buildTimetableHTML(sem, courses){
  const totalMin = DAY_END - DAY_START;
  const gridWidth = totalMin * PX_PER_MIN;
  const hourCount = totalMin / 60;

  let hourLabels = '';
  for (let h = 0; h <= hourCount; h++){
    const isFirst = h === 0;
    hourLabels += `<div class="hour-label${isFirst ? ' hour-label-first' : ''}" style="left:${h * 60 * PX_PER_MIN}px">${fmtHourLabel(DAY_START + h * 60)}</div>`;
  }

  const dayRows = DAYS.map(day => {
    let blocksHtml = '';
    courses.forEach(c => {
      const colorIdx = sem.courses.indexOf(c) % COLORS.length;
      c.meetings.forEach(m => {
        if (!m.days.includes(day)) return;
        const left = (toMinutes(m.start) - DAY_START) * PX_PER_MIN;
        const width = (toMinutes(m.end) - toMinutes(m.start)) * PX_PER_MIN;
        blocksHtml += `
          <div class="course-block" style="left:${left}px;width:${width}px;background:${COLORS[colorIdx].bg};border-left-color:${COLORS[colorIdx].bd}">
            <div class="block-title mono">${escapeHtml(c.code)}-${escapeHtml(c.section)}</div>
            <div class="block-meta">${fmtTime(m.start)}–${fmtTime(m.end)}</div>
          </div>
        `;
      });
    });
    return `<div class="day-row"><div class="day-row-head">${day}</div><div class="day-row-body" style="width:${gridWidth}px">${blocksHtml}</div></div>`;
  }).join('');

  return `
    <div class="timetable-wrap" id="timetableCapture">
      <div class="timetable-hours"><div class="day-row-head"></div><div class="hour-row-body" style="width:${gridWidth}px">${hourLabels}</div></div>
      ${dayRows}
    </div>
  `;
}

// Snapshots the currently-visible timetable grid to a PNG and downloads it.
// Works for both the student's personal timetable and the admin's full-datasheet
// one, since whichever is on screen is the one wearing id="timetableCapture".
function downloadTimetablePNG(filename){
  const el = document.getElementById('timetableCapture');
  if (!el){ alert('Nothing to download yet — add some courses first.'); return; }
  if (typeof html2canvas === 'undefined'){
    alert("PNG export isn't available right now — please try again in a moment.");
    return;
  }
  html2canvas(el, { backgroundColor: '#0B1220', scale: 2 }).then(canvas => {
    const link = document.createElement('a');
    link.download = filename;
    link.href = canvas.toDataURL('image/png');
    link.click();
  }).catch(() => {
    alert('Could not generate the PNG. Please try again.');
  });
}

/* ---------- manage access (main admin only) ---------- */
function adminAccessTemplate(){
  const rows = state.accessList || [];
  return `
    <section class="form-card" style="max-width:560px">
      <h3>Manage access</h3>
      <p class="empty-note" style="padding-top:0">Grant admin-panel access to another Google account below. Anyone signing in with an @std.ewubd.std address already gets student-panel access automatically — you don't need to add students here.</p>
      <form id="addAccessForm" class="inline-form">
        <input type="email" id="newAdminEmail" placeholder="name@gmail.com" required style="flex:1">
        <button type="submit" class="btn btn-ghost">+ Grant admin access</button>
      </form>
      <div id="accessFlash" class="flash"></div>
      <div id="accessListWrap" style="margin-top:16px">
        ${state.accessListLoaded
          ? (rows.length === 0 ? `<p class="empty-note">No admins yet — grant access above.</p>` : rows.map(r => accessRowHTML(r)).join(''))
          : `<p class="empty-note">Loading…</p>`}
      </div>
    </section>
  `;
}

function accessRowHTML(r){
  const isMain = r.role === 'main_admin';
  return `
    <div class="course-row" data-access-email="${escapeHtml(r.email)}">
      <div class="course-row-main">
        <div>
          <div class="course-title">${escapeHtml(r.email)}</div>
          <div class="course-meta">${isMain ? 'Main admin' : 'Admin'}</div>
        </div>
      </div>
      <div class="course-row-side">
        ${isMain
          ? `<span class="empty-note" style="padding:0">Can't be removed here</span>`
          : `<button type="button" class="btn btn-remove" data-remove-access="${escapeHtml(r.email)}">Remove</button>`}
      </div>
    </div>
  `;
}

async function loadAccessList(){
  if (!sb) return;
  try {
    const { data, error } = await sb.from('user_roles').select('email,role').order('created_at', { ascending: true });
    if (error) throw error;
    state.accessList = data || [];
  } catch (e){
    console.error('Could not load the access list.', e);
    state.accessList = state.accessList || [];
  }
  state.accessListLoaded = true;
  renderMain();
}

function bindAdminEvents(){
  document.querySelectorAll('[data-admin-page]').forEach(btn => {
    btn.addEventListener('click', () => {
      state.adminPage = btn.dataset.adminPage;
      state.adminSearch = '';
      renderMain();
      if (state.adminPage === 'access') loadAccessList();
    });
  });

  const addAccessForm = document.getElementById('addAccessForm');
  if (addAccessForm){
    addAccessForm.addEventListener('submit', async e => {
      e.preventDefault();
      const flash = document.getElementById('accessFlash');
      const emailInput = document.getElementById('newAdminEmail');
      const email = (emailInput.value || '').trim().toLowerCase();
      if (!email) return;
      try {
        const { error } = await sb.from('user_roles').insert({ email, role: 'admin', added_by: authSession.user.email });
        if (error) throw error;
        emailInput.value = '';
        if (flash) showFlash(flash, 'success', `${email} can now access the admin panel.`);
        await loadAccessList();
      } catch (err){
        const msg = (err && err.message && err.message.toLowerCase().includes('duplicate'))
          ? 'That email already has access.'
          : 'Could not grant access — try again.';
        if (flash) showFlash(flash, 'error', msg);
      }
    });
  }
  document.querySelectorAll('[data-remove-access]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const email = btn.dataset.removeAccess;
      if (!confirm(`Remove admin access for ${email}?`)) return;
      try {
        const { error } = await sb.from('user_roles').delete().eq('email', email);
        if (error) throw error;
        await loadAccessList();
      } catch (err){
        alert('Could not remove that account — try again.');
      }
    });
  });

  const adminEditSearch = document.getElementById('adminEditSearch');
  if (adminEditSearch){
    adminEditSearch.addEventListener('input', () => {
      state.adminSearch = adminEditSearch.value;
      renderAdminEditTable();
    });
  }

  const openAddCourseBtn = document.getElementById('openAddCourseBtn');
  if (openAddCourseBtn){
    openAddCourseBtn.addEventListener('click', () => openAddCourseModal());
  }

  const newSemForm = document.getElementById('newSemesterForm');
  if (newSemForm){
    newSemForm.addEventListener('submit', e => {
      e.preventDefault();
      const input = document.getElementById('newSemesterName');
      const name = input.value.trim();
      if (!name) return;
      const sem = { id: uid('sem_'), name, courses: [] };
      state.semesters.push(sem);
      state.adminSemesterId = sem.id;
      if (!state.studentSemesterId) state.studentSemesterId = sem.id;
      saveSemesters();
      renderMain();
    });
  }
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      state.adminSemesterId = tab.dataset.tab;
      state.adminSearch = '';
      renderMain();
    });
    tab.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' '){
        e.preventDefault();
        state.adminSemesterId = tab.dataset.tab;
        state.adminSearch = '';
        renderMain();
      }
    });
  });
  document.querySelectorAll('[data-tab-del]').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const semId = btn.dataset.tabDel;
      const sem = getSemester(semId);
      if (!sem) return;
      const ok = confirm(`Delete "${sem.name}" and all ${sem.courses.length} course${sem.courses.length === 1 ? '' : 's'} in it? This cannot be undone.`);
      if (!ok) return;
      state.semesters = state.semesters.filter(s => s.id !== semId);
      delete state.selections[semId];
      if (state.adminSemesterId === semId){
        state.adminSemesterId = state.semesters.length ? state.semesters[0].id : null;
      }
      if (state.studentSemesterId === semId){
        state.studentSemesterId = state.semesters.length ? state.semesters[0].id : null;
      }
      state.adminSearch = '';
      saveSemesters();
      saveSelections();
      renderMain();
    });
  });
  document.querySelectorAll('.mode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      state.adminInputMode = btn.dataset.mode;
      renderMain();
    });
  });
  const adminSearch = document.getElementById('adminCourseSearch');
  if (adminSearch){
    adminSearch.addEventListener('input', () => {
      state.adminSearch = adminSearch.value;
      renderAdminTable();
    });
  }

  if (state.adminInputMode === 'manual'){
    const addForm = document.getElementById('addCourseForm');
    if (addForm){
      addForm.addEventListener('submit', e => {
        e.preventDefault();
        handleAddCourse(addForm);
      });
    }
  } else {
    bindImportModeEvents();
  }
}

function handleAddCourse(form){
  const sem = getSemester(state.adminSemesterId);
  const fd = new FormData(form);
  const candidate = {
    id: 'temp',
    code: (fd.get('code') || '').trim(),
    section: (fd.get('section') || '').trim(),
    faculty: (fd.get('faculty') || '').trim(),
    capacity: parseInt(fd.get('capacity'), 10),
    meetings: [{
      room: (fd.get('room') || '').trim(),
      start: fd.get('start'),
      end: fd.get('end'),
      days: fd.getAll('days'),
      faculty: (fd.get('faculty') || '').trim()
    }]
  };
  const flash = document.getElementById('adminFlash');

  const err = validateCandidate(candidate, sem.courses);
  if (err){ showFlash(flash, 'error', err); return; }

  candidate.id = uid('c_');
  candidate.seatsTaken = 0;
  sem.courses.push(candidate);
  sortCourses(sem);
  saveSemesters();
  form.reset();
  showFlash(flash, 'success', `${candidate.code}-${candidate.section} added to the datasheet.`);
  renderAdminTable();
  updateTabCounts();
}

function updateTabCounts(){
  const sem = getSemester(state.adminSemesterId);
  if (!sem) return;
  const tabCount = document.querySelector(`.tab[data-tab="${sem.id}"] .tab-count`);
  if (tabCount) tabCount.textContent = sem.courses.length;
  const heading = document.querySelector('.table-card h3 .muted');
  if (heading) heading.textContent = `— ${sem.courses.length} course${sem.courses.length === 1 ? '' : 's'}`;
}

/* ============ file import ============ */
function bindImportModeEvents(){
  const dropZone = document.getElementById('dropZone');
  const fileInput = document.getElementById('importFileInput');
  if (dropZone && fileInput){
    dropZone.addEventListener('click', () => fileInput.click());
    dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('dragover'); });
    dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
    dropZone.addEventListener('drop', e => {
      e.preventDefault();
      dropZone.classList.remove('dragover');
      if (e.dataTransfer.files.length) handleFileImport(e.dataTransfer.files[0]);
    });
    fileInput.addEventListener('change', () => {
      if (fileInput.files.length) handleFileImport(fileInput.files[0]);
    });
  }
}

function mapRowObject(rowObj){
  const mapped = {};
  Object.entries(rowObj).forEach(([h, v]) => {
    const norm = String(h).trim().toLowerCase();
    for (const [field, aliases] of Object.entries(HEADER_ALIASES)){
      if (aliases.includes(norm)){ mapped[field] = v; break; }
    }
  });
  return mapped;
}

// Real-world exports often have a title/metadata line (or several) above the actual
// header row — e.g. "East West University / Offered Courses (Fall-2026) / Generated
// from ...". Scan the first few rows of the raw grid for the row that actually looks
// like a header (hits at least 2 known column names) instead of always assuming row 0.
const HEADER_SCAN_ROWS = 20;
function findHeaderRowIndex(grid){
  const maxScan = Math.min(grid.length, HEADER_SCAN_ROWS);
  for (let i = 0; i < maxScan; i++){
    const cells = (grid[i] || []).map(c => String(c || '').trim().toLowerCase());
    let hits = 0;
    cells.forEach(c => {
      for (const aliases of Object.values(HEADER_ALIASES)){
        if (aliases.includes(c)){ hits++; break; }
      }
    });
    if (hits >= 2) return i;
  }
  return -1;
}
function gridToRowObjects(grid){
  const headerIdx = findHeaderRowIndex(grid);
  if (headerIdx === -1) return [];
  const headers = (grid[headerIdx] || []).map(c => String(c || '').trim());
  const rows = [];
  for (let r = headerIdx + 1; r < grid.length; r++){
    const rowArr = grid[r] || [];
    if (rowArr.every(v => String(v || '').trim() === '')) continue;
    const obj = {};
    headers.forEach((h, idx) => { if (h) obj[h] = rowArr[idx] !== undefined ? rowArr[idx] : ''; });
    rows.push(obj);
  }
  return rows;
}

async function handleFileImport(file){
  const flash = document.getElementById('importFlash');
  const nameEl = document.getElementById('importFileName');
  if (nameEl) nameEl.textContent = `Selected: ${file.name}`;
  const pickerWrap = document.getElementById('importSheetPickerWrap');
  if (pickerWrap) pickerWrap.innerHTML = '';
  const ext = file.name.split('.').pop().toLowerCase();

  try{
    if (ext === 'csv'){
      finishRowsImport(await parseCSVFile(file), flash);
    } else if (ext === 'xlsx' || ext === 'xls'){
      const wb = await parseExcelWorkbook(file);
      const nonEmpty = wb.sheetNames.filter(n => wb.sheets[n].length > 0);
      if (nonEmpty.length === 0){
        showFlash(flash, 'error', 'No rows could be read from that file (checked every sheet for a recognizable header row).');
        document.getElementById('importPreviewContainer').innerHTML = '';
        return;
      }
      if (nonEmpty.length > 1 && pickerWrap) renderSheetPicker(wb, nonEmpty, pickerWrap);
      finishRowsImport(wb.sheets[nonEmpty[0]], flash);
    } else if (ext === 'pdf'){
      finishRowsImport(await parsePDFFile(file), flash);
    } else {
      showFlash(flash, 'error', 'Unsupported file type. Use CSV, XLSX, XLS, or PDF.');
    }
  } catch (e){
    showFlash(flash, 'error', e.message);
  }
}

function finishRowsImport(rows, flash){
  if (!rows || rows.length === 0){
    showFlash(flash, 'error', 'No rows could be read from that file (or its header row could not be found). Check the format and try again.');
    document.getElementById('importPreviewContainer').innerHTML = '';
    return;
  }
  processImportRows(rows);
}

// Lets the admin choose which sheet to import when a workbook has more than one
// (e.g. an export with separate tabs per program), or combine all of them at once.
function renderSheetPicker(wb, sheetNames, wrap){
  const totalRows = sheetNames.reduce((s, n) => s + wb.sheets[n].length, 0);
  wrap.innerHTML = `
    <label class="sheet-picker-label">Sheet to import
      <select id="importSheetSelect">
        ${sheetNames.map((n, i) => `<option value="${escapeHtml(n)}" ${i === 0 ? 'selected' : ''}>${escapeHtml(n)} (${wb.sheets[n].length} row${wb.sheets[n].length === 1 ? '' : 's'})</option>`).join('')}
        <option value="__all__">All sheets combined (${totalRows} rows)</option>
      </select>
    </label>
  `;
  const sel = document.getElementById('importSheetSelect');
  sel.addEventListener('change', () => {
    const flash = document.getElementById('importFlash');
    if (sel.value === '__all__'){
      const combined = [];
      sheetNames.forEach(n => combined.push(...wb.sheets[n]));
      finishRowsImport(combined, flash);
    } else {
      finishRowsImport(wb.sheets[sel.value], flash);
    }
  });
}

function parseCSVFile(file){
  return new Promise((resolve, reject) => {
    if (typeof Papa === 'undefined'){ reject(new Error('CSV reader unavailable (library failed to load).')); return; }
    Papa.parse(file, {
      header: false,
      skipEmptyLines: true,
      complete: res => resolve(gridToRowObjects(res.data)),
      error: err => reject(err)
    });
  });
}

async function parseExcelWorkbook(file){
  if (typeof XLSX === 'undefined') throw new Error('Excel reader unavailable (library failed to load).');
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: 'array' });
  const sheets = {};
  wb.SheetNames.forEach(name => {
    const grid = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: '', raw: false });
    sheets[name] = gridToRowObjects(grid);
  });
  return { sheetNames: wb.SheetNames, sheets };
}

const PDF_HEADER_KEYWORDS = ['course','section','sec','faculty','instructor','capacity','cap','room','timing','time','days','start','end'];
const PDF_MAX_SANE_ROWS = 300; // a real datasheet won't have thousands of rows; more than this means the parse went wrong

async function parsePDFFile(file){
  if (typeof pdfjsLib === 'undefined') throw new Error('PDF reader unavailable — try a CSV or Excel file instead.');
  const buf = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise;

  const allLines = [];
  for (let p = 1; p <= pdf.numPages; p++){
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    const items = content.items
      .map(it => ({ str: it.str, x: it.transform[4], y: it.transform[5] }))
      .filter(it => it.str.trim().length);
    allLines.push(...groupItemsIntoLines(items));
  }

  if (allLines.length < 2) return [];

  // Find the header line: first line (within the first 15) whose text hits at least 2 known keywords.
  let headerLineIdx = -1;
  for (let i = 0; i < Math.min(allLines.length, 15); i++){
    const text = allLines[i].items.map(it => it.str).join(' ').toLowerCase();
    const hits = PDF_HEADER_KEYWORDS.filter(k => text.includes(k)).length;
    if (hits >= 2){ headerLineIdx = i; break; }
  }
  if (headerLineIdx === -1) return [];

  const headerCells = mergeAdjacentItems(allLines[headerLineIdx].items);
  const colStarts = headerCells.map(h => h.x);
  const colNames = headerCells.map(h => h.str.trim());

  const rows = [];
  for (let i = headerLineIdx + 1; i < allLines.length; i++){
    const line = allLines[i];
    if (!line.items.length) continue;
    const cells = colNames.map(() => []);
    line.items.forEach(it => {
      let colIdx = 0;
      for (let c = 0; c < colStarts.length; c++){
        if (it.x >= colStarts[c] - 6) colIdx = c;
      }
      cells[colIdx].push(it.str);
    });
    const rowObj = {};
    colNames.forEach((name, idx) => { rowObj[name] = cells[idx].join(' ').trim(); });
    if (Object.values(rowObj).some(v => v)) rows.push(rowObj);

    // Bail out early if this clearly isn't a simple table — avoids flooding the preview with junk rows.
    if (rows.length > PDF_MAX_SANE_ROWS){
      throw new Error(`This PDF produced over ${PDF_MAX_SANE_ROWS} rows, which usually means its layout isn't a simple table UniCoPlan can read automatically. Try exporting it as CSV/Excel instead, or use manual entry.`);
    }
  }
  return rows;
}

// Groups raw text fragments into visual lines using a y-tolerance (PDF coordinates
// for text on the "same" line often differ by a fraction of a point).
function groupItemsIntoLines(items){
  const Y_TOLERANCE = 3;
  const sorted = items.slice().sort((a, b) => b.y - a.y || a.x - b.x);
  const lines = [];
  sorted.forEach(it => {
    let line = lines.find(l => Math.abs(l.y - it.y) <= Y_TOLERANCE);
    if (!line){ line = { y: it.y, items: [] }; lines.push(line); }
    line.items.push(it);
  });
  lines.forEach(l => l.items.sort((a, b) => a.x - b.x));
  return lines;
}

// Merges text fragments that sit close together on the x-axis into a single cell —
// handles multi-word column headers like "Room No" that pdf.js may split into separate items.
function mergeAdjacentItems(items){
  const merged = [];
  items.forEach(it => {
    const last = merged[merged.length - 1];
    const estWidth = last ? last.str.length * 5 : 0;
    if (last && (it.x - (last.x + estWidth)) < 12){
      last.str += ' ' + it.str;
    } else {
      merged.push({ str: it.str, x: it.x });
    }
  });
  return merged;
}

// Reads one row's Days/Start/End (or combined Timing) columns into a single meeting.
// Faculty is carried per-meeting too: a section's lecture and lab meetings are
// sometimes taught by different people, and treating that as one course-level
// faculty value would misattribute — and could falsely "clash" — a meeting that
// isn't actually that person's.
function parseMeetingFromRow(mapped){
  let days = [];
  let start = '', end = '';
  if (mapped.days) days = String(mapped.days).split(/[\/,;]+/).map(normalizeDayToken).filter(Boolean);
  if (mapped.start) start = to24Hour(mapped.start) || '';
  if (mapped.end) end = to24Hour(mapped.end) || '';
  if ((!days.length || !start || !end) && mapped.timing){
    const parsed = parseTiming(mapped.timing);
    if (parsed){
      if (!days.length) days = parsed.days;
      if (!start) start = parsed.start;
      if (!end) end = parsed.end;
    }
  }
  const room = (mapped.room || '').toString().trim();
  const faculty = (mapped.faculty || '').toString().trim();
  return { days, start, end, room, faculty };
}
function meetingKey(m){ return `${m.start}|${m.end}|${m.room.trim().toLowerCase()}`; }
// Folds a new meeting into an existing list: same start/end/room just adds its days
// to that meeting (this is what happens when a section's Mon and Wed rows land in the
// same room); a different room or time — or a different instructor — becomes its own
// separate meeting entry.
function mergeMeetingInto(meetings, m){
  if (!m.days.length && !m.start && !m.end && !m.room) return;
  const key = meetingKey(m);
  const found = meetings.find(x => meetingKey(x) === key);
  if (found){
    m.days.forEach(d => { if (!found.days.includes(d)) found.days.push(d); });
  } else {
    meetings.push({ days: m.days.slice(), start: m.start, end: m.end, room: m.room, faculty: m.faculty });
  }
}
// Builds the course-level "display" faculty from its meetings: the common name if
// every meeting shares one, or all distinct names joined together when a section is
// co-taught / has a different instructor per meeting.
function combineFacultyNames(meetings, fallback){
  const names = [];
  meetings.forEach(m => {
    const f = (m.faculty || '').trim();
    if (f && !isPlaceholderText(f) && !names.some(n => n.toLowerCase() === f.toLowerCase())) names.push(f);
  });
  if (names.length) return names.join(' / ');
  const fb = (fallback || '').trim();
  return fb || (meetings[0] && meetings[0].faculty) || '';
}

// Groups raw rows by Course+Section first (a datasheet routinely lists each meeting
// day of a section as its own row, sometimes with a different room per day), then
// validates once per merged course rather than once per raw row.
function processImportRows(rowObjs){
  const groups = new Map();
  const order = [];

  rowObjs.forEach((rowObj, idx) => {
    const mapped = mapRowObject(rowObj);
    const code = (mapped.course || '').toString().trim();
    const section = (mapped.section || '').toString().trim();
    const cap = parseCapacity(mapped.capacity);
    const meeting = parseMeetingFromRow(mapped);
    const key = code.toLowerCase() + '|||' + section.toLowerCase();

    if (!groups.has(key)){
      groups.set(key, { code, section, capacityTotal: NaN, meetings: [], rowNumbers: [] });
      order.push(key);
    }
    const g = groups.get(key);
    if (!isNaN(cap.total)) g.capacityTotal = Math.max(isNaN(g.capacityTotal) ? 0 : g.capacityTotal, cap.total);
    mergeMeetingInto(g.meetings, meeting);
    g.rowNumbers.push(idx + 1);
  });

  const preview = [];

  order.forEach(key => {
    const g = groups.get(key);
    const candidate = {
      id: 'temp',
      code: g.code,
      section: g.section,
      faculty: combineFacultyNames(g.meetings, ''),
      capacity: g.capacityTotal,
      seatsTaken: 0,
      meetings: g.meetings
    };
    const err = validateImportCandidate(candidate);
    if (!err){
      candidate.id = uid('c_');
    }
    preview.push({ candidate, error: err, rowNumbers: g.rowNumbers });
  });

  renderImportPreview(preview);
}

// Compresses a list of source row numbers like [3,4,7] into "Rows 3–4, 7" for display.
function formatRowNumbers(nums){
  const sorted = nums.slice().sort((a, b) => a - b);
  const parts = [];
  let start = sorted[0], prev = sorted[0];
  for (let i = 1; i <= sorted.length; i++){
    if (i < sorted.length && sorted[i] === prev + 1){ prev = sorted[i]; continue; }
    parts.push(start === prev ? `${start}` : `${start}–${prev}`);
    if (i < sorted.length){ start = sorted[i]; prev = sorted[i]; }
  }
  return (sorted.length === 1 ? 'Row ' : 'Rows ') + parts.join(', ');
}

function renderImportPreview(preview){
  importPreviewData = preview;
  const container = document.getElementById('importPreviewContainer');
  if (!container) return;
  const validCount = preview.filter(p => !p.error).length;
  const totalRows = preview.reduce((n, p) => n + p.rowNumbers.length, 0);

  container.innerHTML = `
    <div class="import-summary">${validCount} of ${preview.length} course${preview.length === 1 ? '' : 's'} ready to import, from ${totalRows} source row${totalRows === 1 ? '' : 's'}.</div>
    <div class="import-table-wrap">
      <table class="ledger">
        <thead><tr><th></th><th>Course</th><th>Sec</th><th>Faculty</th><th>Cap</th><th>Schedule</th><th>Rows</th><th>Status</th></tr></thead>
        <tbody>
          ${preview.map((p, i) => {
            const c = p.candidate;
            return `<tr class="${p.error ? 'row-error' : ''}">
              <td><input type="checkbox" data-row="${i}" ${p.error ? 'disabled' : 'checked'}></td>
              <td class="mono">${escapeHtml(c.code || '—')}</td>
              <td>${escapeHtml(c.section || '—')}</td>
              <td>${escapeHtml(c.faculty || '—')}</td>
              <td>${isNaN(c.capacity) ? '—' : c.capacity}</td>
              <td class="mono">${fmtMeetingsBlock(c.meetings)}</td>
              <td class="muted">${escapeHtml(formatRowNumbers(p.rowNumbers))}</td>
              <td class="${p.error ? 'status-error' : 'status-ok'}">${p.error ? escapeHtml(p.error) : 'Ready'}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>
    <button type="button" id="confirmImportBtn" class="btn btn-primary" ${validCount === 0 ? 'disabled' : ''}>Import ${validCount} course${validCount === 1 ? '' : 's'}</button>
  `;
  const btn = document.getElementById('confirmImportBtn');
  if (btn) btn.addEventListener('click', confirmImport);
}

function confirmImport(){
  const sem = getSemester(state.adminSemesterId);
  const checked = document.querySelectorAll('#importPreviewContainer input[type=checkbox]:checked');
  let count = 0;
  checked.forEach(cb => {
    const idx = parseInt(cb.dataset.row, 10);
    const entry = importPreviewData[idx];
    if (entry && !entry.error){
      sem.courses.push(entry.candidate);
      count++;
    }
  });
  importPreviewData = [];
  sortCourses(sem);
  saveSemesters();
  const previewContainer = document.getElementById('importPreviewContainer');
  if (previewContainer) previewContainer.innerHTML = '';
  const fileInput = document.getElementById('importFileInput');
  if (fileInput) fileInput.value = '';
  const nameEl = document.getElementById('importFileName');
  if (nameEl) nameEl.textContent = '';

  renderAdminTable();
  updateTabCounts();
  const flash = document.getElementById('importFlash');
  showFlash(flash, 'success', `${count} course${count === 1 ? '' : 's'} imported into the datasheet.`);
}

/* ============ student view ============ */
function studentPageNavHTML(){
  const items = [
    { key: 'plan', label: 'Pre-Advising Planning' },
    { key: 'timetable', label: 'Class Schedule' },
    { key: 'combinations', label: 'Combinations' }
  ];
  return `<div class="page-nav">${items.map(i => `
    <button type="button" class="page-nav-btn ${state.studentPage === i.key ? 'active' : ''}" data-student-page="${i.key}">${i.label}</button>
  `).join('')}</div>`;
}

function studentTemplate(){
  const nav = studentPageNavHTML();

  if (state.studentPage === 'timetable'){
    if (state.semesters.length === 0){
      return nav + `<div class="empty-state"><p>No semesters are open yet. Check back once the admin publishes a datasheet.</p></div>`;
    }
    const sem = getSemester(state.studentSemesterId);
    return nav + `
      <section class="schedule-card">
        <div class="timetable-page-head">
          <h3>Class Schedule ${sem ? `<span class="muted">— ${escapeHtml(sem.name)}</span>` : ''}</h3>
          <div class="row-actions">
            <button type="button" class="btn-download" id="saveComboBtn">＋ Save as combination</button>
            <button type="button" class="btn-download" id="resetPlanBtn">↺ Reset plan</button>
            <button type="button" class="btn-download" id="downloadTimetableBtn">⤓ Download PNG</button>
          </div>
        </div>
        <div id="scheduleFlash" class="flash"></div>
        <div id="timetable"></div>
        <h3 class="selected-heading">Your courses</h3>
        <div id="selectedList"></div>
      </section>
    `;
  }

  if (state.studentPage === 'combinations') return nav + combinationsPageTemplate();

  return nav + `
    <section class="student-toolbar">
      <div class="semester-select-wrap">
        <label for="semesterSelect">Semester</label>
        <select id="semesterSelect">
          ${state.semesters.length === 0
            ? `<option value="">No semesters yet</option>`
            : state.semesters.map(s => `<option value="${s.id}" ${s.id === state.studentSemesterId ? 'selected' : ''}>${escapeHtml(s.name)}</option>`).join('')}
        </select>
      </div>
      <div class="search-wrap">
        <label for="courseSearch">Search</label>
        <input type="search" id="courseSearch" value="${escapeHtml(state.search)}">
      </div>
    </section>
    ${state.semesters.length === 0 ? `
      <div class="empty-state"><p>No semesters are open yet. Check back once the admin publishes a datasheet.</p></div>
    ` : `
      <section class="student-workspace">
        <div class="list-card">
          <h3>Available courses</h3>
          <div id="availableList"></div>
        </div>
      </section>
    `}
  `;
}

/* ---------- combinations page ---------- */
function combinationsPageTemplate(){
  if (state.semesters.length === 0){
    return `<div class="empty-state"><p>No semesters are open yet. Check back once the admin publishes a datasheet.</p></div>`;
  }
  const sem = getSemester(state.studentSemesterId);
  const combos = sem ? (state.combinations[sem.id] || []) : [];
  return `
    <section class="schedule-card">
      <div class="timetable-page-head">
        <h3>Saved combinations ${sem ? `<span class="muted">— ${escapeHtml(sem.name)}</span>` : ''}</h3>
      </div>
      ${!sem ? `<p class="empty-note">Select a semester from the Pre-Advising Planning tab first.</p>` :
        combos.length === 0 ? `<p class="empty-note">No saved combinations yet. Build a plan on the Pre-Advising Planning tab, then use "Save as combination" from the Class Schedule tab.</p>` :
        `<div id="comboList">${combos.map(combo => comboRowHTML(sem, combo)).join('')}</div>`
      }
    </section>
  `;
}

function comboRowHTML(sem, combo){
  const courses = combo.courseIds.map(id => sem.courses.find(c => c.id === id)).filter(Boolean);
  return `
    <div class="combo-wrap">
      <div class="course-row combo-row" data-combo-toggle="${combo.id}" role="button" tabindex="0" aria-expanded="false">
        <div class="course-row-main">
          <span class="combo-caret">▸</span>
          <div>
            <div class="course-title">${escapeHtml(combo.name)} <span class="muted">(${courses.length} course${courses.length === 1 ? '' : 's'})</span></div>
            <div class="course-meta mono">${courses.map(c => `${escapeHtml(c.code)}-${escapeHtml(c.section)}`).join(', ') || '—'}</div>
          </div>
        </div>
        <div class="course-row-side">
          <button type="button" class="btn btn-ghost" data-apply-combo="${combo.id}">Apply to plan</button>
          <button type="button" class="btn btn-remove" data-delete-combo="${combo.id}">Delete</button>
        </div>
      </div>
      <div class="combo-timetable" id="comboTimetable-${combo.id}" style="display:none">
        ${courses.length ? buildTimetableHTML(sem, courses) : `<p class="empty-note">No courses in this combination.</p>`}
      </div>
    </div>
  `;
}

// Expands/collapses a saved combination's mini timetable in place. Clicks on the
// row's own action buttons (Apply/Delete) are excluded so they keep working normally.
function toggleComboTimetable(comboId){
  const row = document.querySelector(`[data-combo-toggle="${comboId}"]`);
  const panel = document.getElementById('comboTimetable-' + comboId);
  if (!panel || !row) return;
  const isOpen = panel.style.display !== 'none';
  panel.style.display = isOpen ? 'none' : 'block';
  row.setAttribute('aria-expanded', String(!isOpen));
  row.classList.toggle('combo-row-open', !isOpen);
}

function applyCombination(comboId){
  const sem = getSemester(state.studentSemesterId);
  if (!sem) return;
  const combo = (state.combinations[sem.id] || []).find(c => c.id === comboId);
  if (!combo) return;
  if (!confirm(`Replace your current plan with "${combo.name}"?`)) return;

  // release seats held by whatever is currently selected
  const current = state.selections[sem.id] || [];
  current.forEach(id => {
    const c = sem.courses.find(cc => cc.id === id);
    if (c){ c.seatsTaken = Math.max(0, c.seatsTaken - 1); adjustSeatRemote(c.id, -1); }
  });

  // take up to the plan limit from the combination, skipping courses that no
  // longer exist or no longer have room
  const available = combo.courseIds.filter(id => sem.courses.find(c => c.id === id));
  const applied = [];
  available.slice(0, MAX_PLAN_COURSES).forEach(id => {
    const c = sem.courses.find(cc => cc.id === id);
    if (c && c.seatsTaken < c.capacity){ c.seatsTaken++; adjustSeatRemote(c.id, 1); applied.push(id); }
  });

  state.selections[sem.id] = applied;
  saveSemesters();
  saveSelections();
  state.studentPage = 'timetable';
  renderMain();
  if (applied.length < combo.courseIds.length){
    alert('Some courses from that combination were unavailable (full or removed) and were skipped.');
  }
}

function deleteCombination(comboId){
  const sem = getSemester(state.studentSemesterId);
  if (!sem) return;
  if (!confirm('Delete this saved combination?')) return;
  state.combinations[sem.id] = (state.combinations[sem.id] || []).filter(c => c.id !== comboId);
  saveCombinations();
  renderMain();
}

function bindStudentEvents(){
  document.querySelectorAll('[data-student-page]').forEach(btn => {
    btn.addEventListener('click', () => {
      state.studentPage = btn.dataset.studentPage;
      renderMain();
    });
  });

  const downloadBtn = document.getElementById('downloadTimetableBtn');
  if (downloadBtn){
    downloadBtn.addEventListener('click', () => {
      const sem = getSemester(state.studentSemesterId);
      downloadTimetablePNG((sem ? sem.name.replace(/\s+/g, '_') : 'my') + '_weekly_timetable.png');
    });
  }

  const saveComboBtn = document.getElementById('saveComboBtn');
  if (saveComboBtn){
    saveComboBtn.addEventListener('click', () => {
      const sem = getSemester(state.studentSemesterId);
      const flash = document.getElementById('scheduleFlash');
      if (!sem) return;
      const selectedIds = state.selections[sem.id] || [];
      if (selectedIds.length === 0){
        if (flash) showFlash(flash, 'error', 'Add at least one course to your plan before saving a combination.');
        return;
      }
      const existing = state.combinations[sem.id] || [];
      const name = prompt('Name this combination (e.g. "Option A"):', `Combination ${existing.length + 1}`);
      if (name === null) return;
      if (!state.combinations[sem.id]) state.combinations[sem.id] = [];
      state.combinations[sem.id].push({
        id: uid('combo_'),
        name: name.trim() || 'Untitled combination',
        courseIds: selectedIds.slice(),
        createdAt: Date.now()
      });
      saveCombinations();
      if (flash) showFlash(flash, 'success', 'Combination saved — view it under the Combinations tab.');
    });
  }

  const resetPlanBtn = document.getElementById('resetPlanBtn');
  if (resetPlanBtn){
    resetPlanBtn.addEventListener('click', () => {
      const sem = getSemester(state.studentSemesterId);
      if (!sem) return;
      const selectedIds = state.selections[sem.id] || [];
      if (selectedIds.length === 0) return;
      if (!confirm('Reset your plan? This removes every selected course for this semester. Saved combinations are not affected.')) return;
      selectedIds.forEach(id => {
        const c = sem.courses.find(cc => cc.id === id);
        if (c){ c.seatsTaken = Math.max(0, c.seatsTaken - 1); adjustSeatRemote(c.id, -1); }
      });
      state.selections[sem.id] = [];
      saveSemesters();
      saveSelections();
      renderMain();
    });
  }

  document.querySelectorAll('[data-apply-combo]').forEach(btn => {
    btn.addEventListener('click', e => { e.stopPropagation(); applyCombination(btn.dataset.applyCombo); });
  });
  document.querySelectorAll('[data-delete-combo]').forEach(btn => {
    btn.addEventListener('click', e => { e.stopPropagation(); deleteCombination(btn.dataset.deleteCombo); });
  });
  document.querySelectorAll('[data-combo-toggle]').forEach(row => {
    row.addEventListener('click', e => {
      if (e.target.closest('button')) return;
      toggleComboTimetable(row.dataset.comboToggle);
    });
    row.addEventListener('keydown', e => {
      if ((e.key === 'Enter' || e.key === ' ') && !e.target.closest('button')){
        e.preventDefault();
        toggleComboTimetable(row.dataset.comboToggle);
      }
    });
  });


  const sel = document.getElementById('semesterSelect');
  if (sel){
    sel.addEventListener('change', () => {
      state.studentSemesterId = sel.value;
      state.search = '';
      renderMain();
    });
  }
  const search = document.getElementById('courseSearch');
  if (search){
    search.addEventListener('input', () => {
      state.search = search.value;
      renderAvailableList();
    });
  }
}

function renderAvailableList(){
  const container = document.getElementById('availableList');
  if (!container) return;
  const sem = getSemester(state.studentSemesterId);
  if (!sem){ container.innerHTML = `<p class="empty-note">Select a semester to see its courses.</p>`; return; }

  const selectedIds = state.selections[sem.id] || [];
  let courses = sem.courses;
  if (state.search.trim()){
    const q = state.search.trim().toLowerCase();
    courses = courses.filter(c => c.code.toLowerCase().includes(q) || c.faculty.toLowerCase().includes(q) || c.section.toLowerCase().includes(q));
  }
  if (courses.length === 0){
    container.innerHTML = `<p class="empty-note">No courses match your search.</p>`;
    return;
  }

  const atLimit = selectedIds.length >= MAX_PLAN_COURSES;

  container.innerHTML = (atLimit ? `<p class="empty-note">You've reached the ${MAX_PLAN_COURSES}-course limit for this plan. Remove a course, or reset your plan from the Class Schedule tab, to add another.</p>` : '') + courses.map(c => {
    const isSelected = selectedIds.includes(c.id);
    const full = c.seatsTaken >= c.capacity;
    const disableAdd = !isSelected && (full || atLimit);
    const label = isSelected ? 'Remove' : (full ? 'Full' : (atLimit ? 'Limit reached' : 'Add'));
    const colorIdx = sem.courses.indexOf(c) % COLORS.length;
    return `
      <div class="course-row" data-course="${c.id}">
        <div class="course-row-main">
          <span class="swatch" style="background:${COLORS[colorIdx].bd}"></span>
          <div>
            <div class="course-title mono">${escapeHtml(c.code)}-${escapeHtml(c.section)}</div>
            <div class="course-meta">${escapeHtml(c.faculty)}</div>
            <div class="course-meta mono">${fmtMeetingsBlock(c.meetings)}</div>
          </div>
        </div>
        <div class="course-row-side">
          <button class="btn ${isSelected ? 'btn-remove' : 'btn-add'}" data-action="${isSelected ? 'remove' : 'add'}" data-course="${c.id}" ${disableAdd ? 'disabled' : ''}>
            ${label}
          </button>
        </div>
        <div class="conflict-msg" id="conflict-${c.id}"></div>
      </div>
    `;
  }).join('');

  container.querySelectorAll('[data-action]').forEach(btn => {
    btn.addEventListener('click', () => {
      const courseId = btn.dataset.course;
      if (btn.dataset.action === 'add') tryAddCourse(sem, courseId);
      else removeCourse(sem, courseId);
    });
  });
}

function tryAddCourse(sem, courseId){
  const course = sem.courses.find(c => c.id === courseId);
  const selectedIds = state.selections[sem.id] || [];
  const selectedCourses = selectedIds.map(id => sem.courses.find(c => c.id === id)).filter(Boolean);
  const msgEl = document.getElementById('conflict-' + courseId);

  if (selectedIds.length >= MAX_PLAN_COURSES){
    if (msgEl){
      msgEl.textContent = `You can add up to ${MAX_PLAN_COURSES} courses to your plan at a time — remove one first, or reset your plan.`;
      msgEl.classList.add('show', 'shake');
      setTimeout(() => msgEl.classList.remove('shake'), 400);
    }
    return;
  }

  // Only one section per course code — adding CSE303-1 while CSE303-3 is
  // already selected doesn't make sense, so block it before checking anything else.
  const sameCourseOtherSection = selectedCourses.find(sc => sc.code.toLowerCase() === course.code.toLowerCase() && sc.id !== course.id);
  if (sameCourseOtherSection){
    if (msgEl){
      msgEl.textContent = `You've already added ${sameCourseOtherSection.code}-${sameCourseOtherSection.section} — remove it first to add a different section.`;
      msgEl.classList.add('show', 'shake');
      setTimeout(() => msgEl.classList.remove('shake'), 400);
    }
    return;
  }

  const conflict = findScheduleConflict(course, selectedCourses);

  if (conflict){
    if (msgEl){
      msgEl.textContent = `Clashes with ${conflict.other.code}-${conflict.other.section} on ${fmtDays(conflict.days)}, ${fmtTime(conflict.otherMeeting.start)}–${fmtTime(conflict.otherMeeting.end)}.`;
      msgEl.classList.add('show', 'shake');
      setTimeout(() => msgEl.classList.remove('shake'), 400);
    }
    return;
  }
  if (course.seatsTaken >= course.capacity){
    if (msgEl){ msgEl.textContent = 'This section is full.'; msgEl.classList.add('show'); }
    return;
  }

  course.seatsTaken++;
  adjustSeatRemote(course.id, 1);
  if (!state.selections[sem.id]) state.selections[sem.id] = [];
  state.selections[sem.id].push(courseId);
  saveSemesters();
  saveSelections();
  if (msgEl){ msgEl.textContent = ''; msgEl.classList.remove('show'); }

  renderAvailableList();
  renderTimetable();
  renderSelectedList();
}

function removeCourse(sem, courseId){
  const course = sem.courses.find(c => c.id === courseId);
  if (course){ course.seatsTaken = Math.max(0, course.seatsTaken - 1); adjustSeatRemote(course.id, -1); }
  state.selections[sem.id] = (state.selections[sem.id] || []).filter(id => id !== courseId);
  saveSemesters();
  saveSelections();

  renderAvailableList();
  renderTimetable();
  renderSelectedList();
}

function renderTimetable(){
  const container = document.getElementById('timetable');
  if (!container) return;
  const sem = getSemester(state.studentSemesterId);
  if (!sem){ container.innerHTML = ''; return; }

  const selectedIds = state.selections[sem.id] || [];
  const selectedCourses = selectedIds.map(id => sem.courses.find(c => c.id === id)).filter(Boolean);

  container.innerHTML = buildTimetableHTML(sem, selectedCourses);
}

function renderSelectedList(){
  const container = document.getElementById('selectedList');
  if (!container) return;
  const sem = getSemester(state.studentSemesterId);
  if (!sem){ container.innerHTML = ''; return; }

  const selectedIds = state.selections[sem.id] || [];
  const selectedCourses = selectedIds.map(id => sem.courses.find(c => c.id === id)).filter(Boolean);

  if (selectedCourses.length === 0){
    container.innerHTML = `<p class="empty-note">Nothing added yet — pick courses from the list on the left.</p>`;
    return;
  }

  container.innerHTML = `
    <ul class="selected-ul">
      ${selectedCourses.map(c => {
        const colorIdx = sem.courses.indexOf(c) % COLORS.length;
        return `<li>
          <span class="swatch" style="background:${COLORS[colorIdx].bd}"></span>
          <span class="mono">${escapeHtml(c.code)}-${escapeHtml(c.section)}</span>
          <span class="course-meta">${escapeHtml(fmtMeetingsInline(c.meetings))}</span>
          <button class="icon-btn" data-remove="${c.id}" title="Remove">✕</button>
        </li>`;
      }).join('')}
    </ul>
    <div class="summary-line">${selectedCourses.length}/${MAX_PLAN_COURSES} courses selected — all times checked for clashes.</div>
  `;

  container.querySelectorAll('[data-remove]').forEach(btn => {
    btn.addEventListener('click', () => removeCourse(sem, btn.dataset.remove));
  });
}

/* ============ start ============ */
initEditModal();
initAddModal();
loadPersistedState(); // local selections/combinations only — instant, synchronous
renderApp();          // paints the loading state, then login/not-authorized/app
initAuth();           // resolves session + role, then re-renders and (if authorized) loads the datasheet
