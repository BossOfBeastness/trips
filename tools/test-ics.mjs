// Checks the calendar file is well formed and carries the alarms that make it
// worth having. Run: node tools/test-ics.mjs
import assert from 'node:assert/strict';
import { buildIcs, fold } from '../ics.js';

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { console.error('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
}

const mk = o => ({
  id: o.id || 'i1', tripId: 't1', type: 'transport', mode: 'flight',
  title: '', start: '', end: '', from: '', to: '', seat: '', leadMinutes: null,
  provider: '', ref: '', notes: '', payStatus: 'prepaid', payMethod: 'card',
  amount: '', currency: '', settledAt: null, createdAt: 0, ...o,
});

const trip = { id: 't1', name: 'Lisbon & Algarve', start: '2026-10-12', end: '2026-10-18' };

const flight = mk({
  id: 'f1', title: 'BA2551 to Faro', from: 'Gatwick', to: 'Faro',
  start: '2026-10-12T21:20', end: '2026-10-13T00:05', provider: 'British Airways', ref: 'XK9P2T',
});
const stay = mk({
  id: 's1', type: 'stay', title: 'Casa do Mar',
  start: '2026-10-13T02:00', end: '2026-10-16T11:00',
  payStatus: 'on_site', payMethod: 'cash', amount: '180', currency: 'EUR',
});
const kayak = mk({
  id: 'k1', type: 'activity', title: 'Benagil kayak', start: '2026-10-13T09:30',
  payStatus: 'on_site', payMethod: 'cash', amount: '70', currency: 'EUR',
});

const ics = buildIcs(trip, [flight, stay, kayak]);
const lines = ics.split('\r\n');

test('every line ends CRLF and the file is wrapped in VCALENDAR', () => {
  assert.ok(ics.startsWith('BEGIN:VCALENDAR\r\n'));
  assert.ok(ics.endsWith('END:VCALENDAR\r\n'));
  assert.ok(!ics.includes('\n\n'));
});

test('no line exceeds 75 octets', () => {
  const enc = new TextEncoder();
  for (const l of lines) {
    assert.ok(enc.encode(l).length <= 75, `too long (${enc.encode(l).length}): ${l.slice(0, 40)}…`);
  }
});

test('folding counts UTF-8 bytes, not characters', () => {
  const folded = fold('DESCRIPTION:' + 'é'.repeat(60));
  const enc = new TextEncoder();
  for (const l of folded.split('\r\n')) assert.ok(enc.encode(l).length <= 75);
  assert.ok(folded.includes('\r\n '), 'expected a continuation line');
  // Unfolding must give the original back, accents intact.
  assert.equal(folded.replace(/\r\n /g, ''), 'DESCRIPTION:' + 'é'.repeat(60));
});

test('commas and semicolons in free text are escaped', () => {
  const out = buildIcs(trip, [mk({ id: 'x', title: 'Hire car, small; manual', start: '2026-10-12T09:00' })]);
  assert.ok(out.includes('SUMMARY:Hire car\\, small\\; manual'));
});

test('summaries carry no emoji', () => {
  assert.ok(!/SUMMARY:[^\r\n]*[\u{1F300}-\u{1FAFF}\u{2700}-\u{27BF}\u{2600}-\u{26FF}]/u.test(ics));
});

test('newlines in notes become \\n, not real line breaks', () => {
  const out = buildIcs(trip, [mk({ id: 'x', title: 'Flat', start: '2026-10-12T09:00', notes: 'Code 4417\nBack door' })]);
  assert.ok(out.includes('Code 4417\\nBack door'));
  assert.ok(!out.includes('Code 4417\r\nBack door'));
});

test('times are floating local, so they read the same in any timezone', () => {
  assert.ok(ics.includes('DTSTART:20261012T212000'));
  assert.ok(!/DTSTART:\d{8}T\d{6}Z/.test(ics), 'should not be UTC-stamped');
});

test('a flight carries a leave-by alarm plus a day-before warning', () => {
  const block = ics.slice(ics.indexOf('UID:f1@'), ics.indexOf('END:VEVENT', ics.indexOf('UID:f1@')));
  assert.ok(block.includes('TRIGGER:-PT150M'), 'expected the 150 min flight lead');
  assert.ok(block.includes('TRIGGER:-P1D'), 'expected a day-before warning on flights');
  assert.ok(block.includes('LOCATION:Gatwick'));
  assert.ok(block.includes('XK9P2T'));
});

test('nothing gets a second alarm at the departure itself', () => {
  assert.ok(!ics.includes('TRIGGER:-PT0M\r\nDESCRIPTION:BA2551'),
    'a duplicate buzz at departure only teaches you to ignore both');
});

test('non-flights get one alarm only', () => {
  const bus = mk({ id: 'b1', mode: 'bus', title: 'Coach', start: '2026-10-14T08:00' });
  const out = buildIcs(trip, [bus]);
  const block = out.slice(out.indexOf('UID:b1@'), out.indexOf('END:VEVENT', out.indexOf('UID:b1@')));
  assert.equal((block.match(/BEGIN:VALARM/g) || []).length, 1);
  assert.ok(block.includes('TRIGGER:-PT20M'));
});

test('a date with no time becomes an all-day event nudged at 09:00', () => {
  const out = buildIcs(trip, [mk({ id: 'd1', type: 'activity', title: 'Free day', start: '2026-10-15' })]);
  assert.ok(out.includes('DTSTART;VALUE=DATE:20261015'), 'expected an all-day start');
  assert.ok(out.includes('DTEND;VALUE=DATE:20261016'), 'all-day end is the next date');
  assert.ok(out.includes('TRIGGER:PT9H'), 'expected a 09:00 nudge, not midnight');
  assert.ok(!/DTSTART:20261015T000000/.test(out), 'must not be buried at midnight');
});

test('what to bring leads the description', () => {
  const out = buildIcs(trip, [mk({ id: 'p1', title: 'Dive', start: '2026-10-15T08:00', docs: 'PADI card, passport' })]);
  assert.ok(/DESCRIPTION:Bring: PADI card\\, passport/.test(out));
});

test('arrival time is carried into the description', () => {
  const block = ics.slice(ics.indexOf('UID:f1@'), ics.indexOf('END:VEVENT', ics.indexOf('UID:f1@')));
  assert.ok(block.includes('Arrives 00:05'), 'expected the landing time');
});

test('a stay splits into check in and check out, not one long block', () => {
  assert.ok(ics.includes('UID:s1-in@trips.local'));
  assert.ok(ics.includes('UID:s1-out@trips.local'));
  assert.ok(ics.includes('DTSTART:20261016T110000'), 'check-out starts when the stay ends');
  assert.ok(!/DTSTART:20261013T020000\r\nDTEND:20261016T110000/.test(ics));
});

test('pay-on-arrival cash shows in the event description', () => {
  const block = ics.slice(ics.indexOf('UID:k1@'), ics.indexOf('END:VEVENT', ics.indexOf('UID:k1@')));
  assert.ok(/Pay on arrival \(CASH\)/.test(block));
});

test('a cash reminder lands the evening before the first cash day', () => {
  assert.ok(/SUMMARY:Draw out/.test(ics));
  assert.ok(ics.includes('DTSTART:20261012T180000'), 'expected 18:00 the day before 13 Oct');
});

test('undated items are skipped rather than emitted with a bad date', () => {
  const out = buildIcs(trip, [mk({ id: 'nope', title: 'Someday', start: '' })]);
  assert.ok(!out.includes('UID:nope@'));
});

test('SEQUENCE tracks the last edit so a re-import supersedes', () => {
  const edited = { ...flight, updatedAt: 1760000000000 };
  assert.ok(buildIcs(trip, [edited]).includes('SEQUENCE:1760000000'));
});

console.log(`\n${passed} passed`);
