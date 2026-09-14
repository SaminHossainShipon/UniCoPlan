const fs = require('fs');
const assert = require('assert');

// Set up minimal browser environment
const dummyEl = {
  innerHTML: '',
  className: '',
  classList: { add: () => {}, remove: () => {} },
  appendChild: () => {},
  querySelectorAll: () => [],
  querySelector: () => null,
  addEventListener: () => {}
};
global.window = { APP_ROLE: 'admin', addEventListener: () => {} };
global.document = {
  getElementById: () => dummyEl,
  querySelectorAll: () => [],
  querySelector: () => null,
  createElement: () => dummyEl
};
global.localStorage = { getItem: () => null, setItem: () => null };

// Load admin_panel/script.js
const adminScript = fs.readFileSync('admin_panel/script.js', 'utf8');
eval(adminScript);

console.log('--- Running UniCoPlan Unit Tests ---');

// 1. Test parseTiming for day parsing (including Friday and letter day codes)
console.log('Testing day parsing in parseTiming...');

const t1 = parseTiming('Fri 09:00 AM - 10:30 AM');
assert.ok(t1, 'Fri timing should parse');
assert.deepStrictEqual(t1.days, ['Fri'], 'Fri day should map to Fri');

const t2 = parseTiming('F 09:00 AM - 10:30 AM');
assert.ok(t2, 'F timing should parse');
assert.deepStrictEqual(t2.days, ['Fri'], 'F day code should map to Fri');

const t3 = parseTiming('Sat/Mon/Wed 9:00 AM-10:15 AM');
assert.ok(t3, 'Sat/Mon/Wed timing should parse');
assert.deepStrictEqual(t3.days, ['Sat', 'Mon', 'Wed']);

const t4 = parseTiming('MW 10:10 AM - 11:40 AM');
assert.ok(t4, 'MW timing should parse');
assert.deepStrictEqual(t4.days, ['Mon', 'Wed']);

const t5 = parseTiming('TR 08:30 AM - 10:00 AM');
assert.ok(t5, 'TR timing should parse');
assert.deepStrictEqual(t5.days, ['Tue', 'Thu']);

const t6 = parseTiming('ST 09:00 AM - 10:30 AM');
assert.ok(t6, 'ST timing should parse');
assert.deepStrictEqual(t6.days, ['Sun', 'Tue']);

// 2. Test parseTiming time range meridian inference (e.g. 1:00-2:15 PM)
console.log('Testing time range meridian inference in parseTiming...');

const p1 = parseTiming('Mon 1:00-2:15 PM');
assert.ok(p1);
assert.strictEqual(p1.start, '13:00', 'Start time 1:00 should infer PM (13:00) when end is 2:15 PM');
assert.strictEqual(p1.end, '14:15');

const p2 = parseTiming('Mon 11:00 AM - 1:30 PM');
assert.ok(p2);
assert.strictEqual(p2.start, '11:00');
assert.strictEqual(p2.end, '13:30');

const p3 = parseTiming('Mon 11:00 - 1:30 PM');
assert.ok(p3);
assert.strictEqual(p3.start, '11:00');
assert.strictEqual(p3.end, '13:30');

const p4 = parseTiming('Mon 9:00 - 10:15 AM');
assert.ok(p4);
assert.strictEqual(p4.start, '09:00');
assert.strictEqual(p4.end, '10:15');

// 3. Test fmtDays
console.log('Testing fmtDays...');
assert.strictEqual(fmtDays(['Sat', 'Fri']), 'Sat/Fri', 'fmtDays should format Fri correctly');

// 4. Test schedule conflicts
console.log('Testing schedule conflict detection...');
const c1 = { id: 'c1', code: 'CS101', section: '1', meetings: [{ days: ['Mon'], start: '09:00', end: '10:30' }] };
const c2 = { id: 'c2', code: 'CS102', section: '1', meetings: [{ days: ['Mon'], start: '10:00', end: '11:30' }] };
const conflict = findScheduleConflict(c1, [c2]);
assert.ok(conflict, 'c1 and c2 should clash');

console.log('All tests passed successfully!');
