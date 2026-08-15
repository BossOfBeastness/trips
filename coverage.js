// Finds holes in a trip: nights with nowhere to sleep, and days where you end up
// somewhere different from where you started with nothing booked to get there.
// Pure — no DOM, no storage — because being wrong here means standing outside a
// bus station at midnight.

import { parseLocal, dayKey, sortItems } from './model.js';

const DAY = 86400000;

export function addDays(d, n) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}

export function eachNight(trip) {
  const start = parseLocal(trip.start);
  const end = parseLocal(trip.end);
  if (!start || !end) return [];
  const out = [];
  // A night is named for the day it begins. The last day of a trip has no night:
  // you have gone home.
  for (let d = start; d < end; d = addDays(d, 1)) out.push(new Date(d));
  return out;
}

const norm = v => (v || '').trim().toLowerCase();

// Two different questions, and conflating them is a bug: a flight out of Panama
// City *ends* in London but *starts* in Panama City, and it is the start that
// says where you needed to already be.
export const endsAt = it => norm(it.type === 'transport' ? (it.to || it.from) : (it.to || it.from));
export const startsAt = it => norm(it.type === 'transport' ? (it.from || it.to) : (it.to || it.from));

function spansNight(it, night) {
  const s = parseLocal(it.start);
  if (!s) return false;
  const e = parseLocal(it.end);
  // Treat the night as the small hours: if the item is still running at 02:00,
  // it covers that night.
  const mark = new Date(night.getFullYear(), night.getMonth(), night.getDate() + 1, 2, 0);
  return s <= mark && (e ? e >= mark : false);
}

export function bedGaps(trip, items) {
  const stays = items.filter(i => i.type === 'stay');
  const moving = items.filter(i => i.type === 'transport');
  const out = [];
  for (const night of eachNight(trip)) {
    if (stays.some(s => spansNight(s, night))) continue;
    // An overnight bus or flight is a bed, of a sort. Not a gap.
    if (moving.some(m => spansNight(m, night))) continue;
    out.push({ kind: 'bed', date: dayKey(night), id: `bed:${dayKey(night)}` });
  }
  return out;
}

export function transitGaps(items) {
  const dated = sortItems(items).filter(i => i.start && (endsAt(i) || startsAt(i)));
  const byDay = new Map();
  for (const it of dated) {
    const k = dayKey(parseLocal(it.start));
    if (!byDay.has(k)) byDay.set(k, []);
    byDay.get(k).push(it);
  }

  const days = [...byDay.keys()].sort();
  const out = [];
  for (let i = 0; i < days.length - 1; i++) {
    const here = byDay.get(days[i]);
    const next = byDay.get(days[i + 1]);
    const last = here[here.length - 1];
    const first = next[0];

    const from = endsAt(last);
    const to = startsAt(first);
    if (!from || !to || from === to) continue;

    // Something that sets off from where you were counts as having handled it,
    // even if it is the first leg of a longer chain.
    const carried = [...here, ...next].some(it => it.type === 'transport' && startsAt(it) === from);
    if (carried) continue;

    out.push({
      kind: 'transit',
      date: days[i + 1],
      from: last.to || last.from,
      to: first.from || first.to,
      id: `transit:${days[i + 1]}`,
    });
  }
  return out;
}

export function coverageGaps(trip, items, dismissed = []) {
  if (!trip) return [];
  const skip = new Set(dismissed);
  return [...bedGaps(trip, items), ...transitGaps(items)]
    .filter(g => !skip.has(g.id))
    .sort((a, b) => a.date.localeCompare(b.date));
}

// One row per day for the ribbon: is there a bed, is there movement, and is
// either of them missing.
export function coverageByDay(trip, items, dismissed = []) {
  const start = parseLocal(trip?.start);
  const end = parseLocal(trip?.end);
  if (!start || !end) return [];

  const gaps = coverageGaps(trip, items, dismissed);
  const bedMissing = new Set(gaps.filter(g => g.kind === 'bed').map(g => g.date));
  const transitMissing = new Set(gaps.filter(g => g.kind === 'transit').map(g => g.date));

  const stays = items.filter(i => i.type === 'stay');
  const moving = items.filter(i => i.type === 'transport');

  const out = [];
  for (let d = start; d <= end; d = addDays(d, 1)) {
    const k = dayKey(d);
    out.push({
      date: k,
      day: d.getDate(),
      moves: moving.some(m => dayKey(parseLocal(m.start)) === k),
      bed: stays.some(s => spansNight(s, d)) || moving.some(m => spansNight(m, d)),
      bedMissing: bedMissing.has(k),
      transitMissing: transitMissing.has(k),
      lastNight: dayKey(d) === dayKey(end),
    });
  }
  return out;
}
