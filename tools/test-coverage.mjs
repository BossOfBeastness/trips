// Coverage, totals and confirmation parsing. Run: node tools/test-coverage.mjs
import assert from 'node:assert/strict';
import { coverageGaps, bedGaps, transitGaps, coverageByDay } from '../coverage.js';
import { tripTotals, toBase } from '../model.js';
import { parseBooking, findDates, findTimes, findReference, findAmount } from '../parse.js';
import { fromIcs } from '../importers.js';

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { console.error('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
}

const mk = o => ({
  id: o.id || Math.random().toString(36).slice(2), tripId: 't1',
  type: 'transport', mode: 'flight', title: '', start: '', end: '',
  from: '', to: '', seat: '', leadMinutes: null, provider: '', ref: '', docs: '', notes: '',
  payStatus: 'prepaid', payMethod: 'card', amount: '', currency: 'GBP',
  settledAt: null, createdAt: 0, ...o,
});

const trip = { id: 't1', name: 'Trip', start: '2026-09-11', end: '2026-09-15' };

/* ------------------------------------------------------------ coverage --- */

test('a night with no stay is a gap', () => {
  const gaps = bedGaps(trip, [mk({ type: 'stay', start: '2026-09-11T15:00', end: '2026-09-13T10:00' })]);
  assert.deepEqual(gaps.map(g => g.date), ['2026-09-13', '2026-09-14']);
});

test('the last day needs no bed - you have gone home', () => {
  const stay = mk({ type: 'stay', start: '2026-09-11T15:00', end: '2026-09-15T10:00' });
  assert.equal(bedGaps(trip, [stay]).length, 0);
});

test('an overnight flight counts as somewhere to be', () => {
  const stay = mk({ type: 'stay', start: '2026-09-11T15:00', end: '2026-09-13T10:00' });
  const redeye = mk({ start: '2026-09-13T22:00', end: '2026-09-14T09:00' });
  const stay2 = mk({ type: 'stay', start: '2026-09-14T14:00', end: '2026-09-15T10:00' });
  assert.equal(bedGaps(trip, [stay, redeye, stay2]).length, 0);
});

test('a day-time flight does not cover the night', () => {
  const hop = mk({ start: '2026-09-13T09:00', end: '2026-09-13T14:00' });
  assert.ok(bedGaps(trip, [hop]).some(g => g.date === '2026-09-13'));
});

test('ending somewhere different with no transport is a transit gap', () => {
  const gaps = transitGaps([
    mk({ id: 'a', type: 'activity', title: 'Dive', to: 'Santa Catalina', start: '2026-09-13T09:00' }),
    mk({ id: 'b', title: 'Fly home', from: 'Panama City', to: 'London', start: '2026-09-14T06:00' }),
  ]);
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].kind, 'transit');
  assert.equal(gaps[0].date, '2026-09-14');
});

test('booking the bus closes the transit gap', () => {
  const gaps = transitGaps([
    mk({ id: 'a', type: 'activity', to: 'Santa Catalina', start: '2026-09-13T09:00' }),
    mk({ id: 'x', mode: 'bus', from: 'Santa Catalina', to: 'Panama City', start: '2026-09-13T15:00' }),
    mk({ id: 'b', from: 'Panama City', to: 'London', start: '2026-09-14T06:00' }),
  ]);
  assert.equal(gaps.length, 0);
});

test('staying put is not a gap', () => {
  const gaps = transitGaps([
    mk({ id: 'a', type: 'activity', to: 'Cusco', start: '2026-09-13T09:00' }),
    mk({ id: 'b', type: 'food', to: 'Cusco', start: '2026-09-14T20:00' }),
  ]);
  assert.equal(gaps.length, 0);
});

test('a dismissed gap stays dismissed', () => {
  const items = [mk({ type: 'stay', start: '2026-09-11T15:00', end: '2026-09-13T10:00' })];
  const all = coverageGaps(trip, items);
  const fewer = coverageGaps(trip, items, [all[0].id]);
  assert.equal(fewer.length, all.length - 1);
});

test('the ribbon reports one row per day of the trip', () => {
  const rows = coverageByDay(trip, [mk({ type: 'stay', start: '2026-09-11T15:00', end: '2026-09-13T10:00' })]);
  assert.equal(rows.length, 5);
  assert.equal(rows[0].bed, true);
  assert.equal(rows[2].bedMissing, true);
});

/* -------------------------------------------------------------- totals --- */

test('totals convert with the rates you set', () => {
  const t = tripTotals([
    mk({ amount: '100', currency: 'GBP' }),
    mk({ amount: '470', currency: 'PEN' }),
  ], { PEN: 4.7 });
  assert.equal(t.total, 200);
  assert.equal(t.paid, 200);
});

test('unpaid cash lands in owed, not paid', () => {
  const t = tripTotals([
    mk({ amount: '50', currency: 'GBP' }),
    mk({ amount: '25', currency: 'GBP', payStatus: 'on_site', payMethod: 'cash' }),
  ]);
  assert.equal(t.paid, 50);
  assert.equal(t.owed, 25);
  assert.equal(t.total, 75);
});

test('a currency with no rate is reported, never counted as zero', () => {
  const t = tripTotals([mk({ amount: '900', currency: 'COP' })], { PEN: 4.7 });
  assert.equal(t.total, 0);
  assert.deepEqual(t.unconverted, [{ currency: 'COP', total: 900 }]);
  assert.equal(toBase('900', 'COP', { PEN: 4.7 }), null);
});

test('settled cash counts as paid', () => {
  const t = tripTotals([mk({ amount: '30', payStatus: 'on_site', payMethod: 'cash', settledAt: 1 })]);
  assert.equal(t.owed, 0);
  assert.equal(t.paid, 30);
});

/* --------------------------------------------------------------- parse --- */

test('dates are read in several shapes, day first', () => {
  assert.ok(findDates('departing 2026-09-11').includes('2026-09-11'));
  assert.ok(findDates('11 September 2026').includes('2026-09-11'));
  assert.ok(findDates('Sep 11, 2026').includes('2026-09-11'));
  assert.ok(findDates('11/09/2026').includes('2026-09-11'), 'UK order, not US');
});

test('12-hour times convert to 24-hour', () => {
  assert.deepEqual(findTimes('boards 2:35 pm'), ['14:35']);
  assert.deepEqual(findTimes('12:10 am departure'), ['00:10']);
});

test('a labelled booking reference wins over a random six-character word', () => {
  assert.equal(findReference('Booking reference: XK9P2T for LONDON'), 'XK9P2T');
});

test('a bare PNR is found when nothing is labelled', () => {
  assert.equal(findReference('Your code J4K2M9 is confirmed'), 'J4K2M9');
});

test('plain words are not mistaken for references', () => {
  assert.equal(findReference('PLEASE ARRIVE EARLIER THAN USUAL'), '');
});

test('amounts carry their currency', () => {
  assert.deepEqual(findAmount('Total £820.00 paid'), { amount: '820.00', currency: 'GBP' });
  assert.deepEqual(findAmount('PEN 450 due on arrival'), { amount: '450', currency: 'PEN' });
});

test('a flight confirmation parses into usable fields', () => {
  const f = parseBooking(`British Airways
Flight BA 2551
London LGW to Faro FAO
11 September 2026, departing 12:00
Booking reference XK9P2T
Total £820.00`);
  assert.equal(f.kind, 'flight');
  assert.equal(f.startDate, '2026-09-11');
  assert.equal(f.startTime, '12:00');
  assert.equal(f.ref, 'XK9P2T');
  assert.equal(f.amount, '820.00');
  assert.equal(f.currency, 'GBP');
  assert.equal(f.confidence, 'high');
});

test('a hotel confirmation is recognised as a stay', () => {
  const f = parseBooking(`Casa do Mar
Check-in 12 September 2026 15:00
Check-out 15 September 2026 10:00`);
  assert.equal(f.kind, 'stay');
  assert.equal(f.startDate, '2026-09-12');
  assert.equal(f.endDate, '2026-09-15');
});

test('empty text parses to nothing rather than a blank item', () => {
  assert.equal(parseBooking('   '), null);
});

/* ----------------------------------------------------------------- ics --- */

test('an airline calendar attachment imports exactly', () => {
  const f = fromIcs([
    'BEGIN:VCALENDAR', 'BEGIN:VEVENT',
    'UID:x@airline', 'DTSTART:20260911T120000', 'DTEND:20260912T110000',
    'SUMMARY:Flight BA2551 to Cusco', 'LOCATION:Gatwick Airport',
    'DESCRIPTION:Booking reference XK9P2T', 'END:VEVENT', 'END:VCALENDAR',
  ].join('\r\n'));
  assert.equal(f.startDate, '2026-09-11');
  assert.equal(f.startTime, '12:00');
  assert.equal(f.endDate, '2026-09-12');
  assert.equal(f.title, 'Flight BA2551 to Cusco');
  assert.equal(f.ref, 'XK9P2T');
  assert.equal(f.confidence, 'high');
});

test('folded calendar lines are rejoined before reading', () => {
  const f = fromIcs('BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nDTSTART:20260911T120000\r\nSUMMARY:A very long flig\r\n ht name here\r\nEND:VEVENT\r\nEND:VCALENDAR');
  assert.equal(f.title, 'A very long flight name here');
});

console.log(`\n${passed} passed`);
