// Sanity checks for the logic that would quietly ruin a trip if it were wrong.
// Run: node tools/test-model.mjs
import assert from 'node:assert/strict';
import {
  leadFor, parseLocal, leaveByDate, nextUp, cashPlan, groupByDay, dayDiff, relative,
} from '../model.js';

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { console.error('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
}

const item = (o) => ({
  id: o.id || Math.random().toString(36).slice(2),
  type: 'transport', mode: 'flight', start: '', end: '', leadMinutes: null,
  payStatus: 'prepaid', payMethod: 'card', amount: '', currency: '',
  settledAt: null, createdAt: 0, ...o,
});

test('flight default lead is 150 min', () => {
  assert.equal(leadFor(item({ mode: 'flight' })), 150);
});

test('explicit lead overrides the mode default', () => {
  assert.equal(leadFor(item({ mode: 'flight', leadMinutes: 200 })), 200);
});

test('lead of 0 is honoured, not treated as missing', () => {
  assert.equal(leadFor(item({ mode: 'flight', leadMinutes: 0 })), 0);
});

test('non-transport items have no lead time', () => {
  assert.equal(leadFor(item({ type: 'activity', mode: 'flight' })), 0);
});

test('start times parse as local wall time, not UTC', () => {
  const d = parseLocal('2026-10-12T06:30');
  assert.equal(d.getHours(), 6);
  assert.equal(d.getMinutes(), 30);
  assert.equal(d.getDate(), 12);
});

test('leave-by subtracts the lead and crosses midnight correctly', () => {
  const d = leaveByDate(item({ start: '2026-10-12T01:00', mode: 'flight' }));
  assert.equal(d.getDate(), 11);
  assert.equal(d.getHours(), 22);
  assert.equal(d.getMinutes(), 30);
});

test('next-up keeps showing an item until its own end time passes', () => {
  const now = parseLocal('2026-10-12T07:00');
  const flight = item({ id: 'f', start: '2026-10-12T06:30', end: '2026-10-12T09:00' });
  const hotel = item({ id: 'h', start: '2026-10-12T15:00' });
  assert.equal(nextUp([hotel, flight], now).id, 'f');
});

test('next-up moves on once the item is fully over', () => {
  const now = parseLocal('2026-10-12T09:30');
  const flight = item({ id: 'f', start: '2026-10-12T06:30', end: '2026-10-12T09:00' });
  const hotel = item({ id: 'h', start: '2026-10-12T15:00' });
  assert.equal(nextUp([hotel, flight], now).id, 'h');
});

test('undated items never become next-up', () => {
  const now = parseLocal('2026-10-12T09:30');
  assert.equal(nextUp([item({ id: 'x', start: '' })], now), null);
});

test('cash plan splits cash-only from cash-or-card, per currency', () => {
  const items = [
    item({ payStatus: 'on_site', payMethod: 'cash',   amount: '40', currency: 'eur', start: '2026-10-13T10:00' }),
    item({ payStatus: 'on_site', payMethod: 'either', amount: '25', currency: 'EUR', start: '2026-10-14T10:00' }),
    item({ payStatus: 'on_site', payMethod: 'card',   amount: '90', currency: 'EUR', start: '2026-10-14T10:00' }),
    item({ payStatus: 'prepaid', payMethod: 'cash',   amount: '99', currency: 'EUR', start: '2026-10-14T10:00' }),
    item({ payStatus: 'on_site', payMethod: 'cash',   amount: '15', currency: 'GBP', start: '2026-10-12T08:00' }),
  ];
  const plan = cashPlan(items);
  assert.equal(plan.length, 2);
  assert.equal(plan[0].currency, 'GBP');           // needed first, so listed first
  assert.equal(plan[1].currency, 'EUR');
  assert.equal(plan[1].certain, 40);               // card-only and prepaid excluded
  assert.equal(plan[1].maybe, 25);
  assert.equal(plan[1].firstNeeded.getDate(), 13);
});

test('settled items drop out of the cash plan', () => {
  const items = [item({ payStatus: 'on_site', payMethod: 'cash', amount: '40', currency: 'EUR', settledAt: 1 })];
  assert.equal(cashPlan(items).length, 0);
});

test('deposit-paid still counts as cash owed on the day', () => {
  const items = [item({ payStatus: 'deposit', payMethod: 'cash', amount: '60', currency: 'EUR' })];
  assert.equal(cashPlan(items)[0].certain, 60);
});

test('days group in chronological order, undated last', () => {
  const keys = [...groupByDay([
    item({ start: '2026-10-14T09:00' }),
    item({ start: '' }),
    item({ start: '2026-10-12T09:00' }),
  ]).keys()];
  assert.deepEqual(keys, ['2026-10-12', '2026-10-14', 'unscheduled']);
});

test('day difference ignores time of day', () => {
  assert.equal(dayDiff(parseLocal('2026-10-13T00:05'), parseLocal('2026-10-12T23:55')), 1);
});

test('relative time reads forwards and backwards', () => {
  const now = parseLocal('2026-10-12T09:00');
  assert.equal(relative(parseLocal('2026-10-12T11:30'), now), 'in 2h 30m');
  assert.equal(relative(parseLocal('2026-10-12T08:45'), now), '15m ago');
});

console.log(`\n${passed} passed`);
