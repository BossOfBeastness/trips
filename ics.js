// Builds an RFC 5545 calendar from a trip. The point is VALARM: iOS Calendar
// fires those alarms itself, on-device, with no signal and without this app
// running. That is the only way to get an offline nudge onto the phone.

import {
  TRANSPORT_MODES, ITEM_TYPES, PAY_STATUS,
  parseLocal, leadFor, cashPlan, fmtMoney, sortItems,
} from './model.js';

const PRODID = '-//Trips//Itinerary//EN';

// RFC 5545 §3.3.11: backslash, semicolon, comma and newline are special.
function escText(s) {
  return String(s ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

// §3.1: lines wrap at 75 octets, continuations start with a space. Counted in
// UTF-8 bytes, not characters, or an accented place name breaks the file.
export function fold(line) {
  const enc = new TextEncoder();
  const out = [];
  let cur = '';
  let bytes = 0;
  for (const ch of line) {
    const n = enc.encode(ch).length;
    const limit = out.length === 0 ? 75 : 74; // continuations lose one to the space
    if (bytes + n > limit) {
      out.push(cur);
      cur = '';
      bytes = 0;
    }
    cur += ch;
    bytes += n;
  }
  out.push(cur);
  return out[0] + out.slice(1).map(s => '\r\n ' + s).join('');
}

const p2 = n => String(n).padStart(2, '0');

// Floating local time: no Z, no TZID. The event shows at the wall-clock time you
// typed, whatever timezone the phone is in — matching how the app itself reads.
function floating(d) {
  return `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}T${p2(d.getHours())}${p2(d.getMinutes())}00`;
}

function utcStamp(d = new Date()) {
  return `${d.getUTCFullYear()}${p2(d.getUTCMonth() + 1)}${p2(d.getUTCDate())}T${p2(d.getUTCHours())}${p2(d.getUTCMinutes())}${p2(d.getUTCSeconds())}Z`;
}

function addMinutes(d, mins) {
  return new Date(d.getTime() + mins * 60000);
}

function alarm(minutesBefore, description) {
  return [
    'BEGIN:VALARM',
    'ACTION:DISPLAY',
    `TRIGGER:-PT${Math.max(0, Math.round(minutesBefore))}M`,
    `DESCRIPTION:${escText(description)}`,
    'END:VALARM',
  ];
}

function describe(it) {
  const lines = [];
  if (it.provider) lines.push(it.provider);
  if (it.ref) lines.push(`Ref: ${it.ref}`);
  if (it.seat) lines.push(`Seat/vehicle: ${it.seat}`);
  const st = PAY_STATUS[it.payStatus];
  if (st?.needsMoney && !it.settledAt) {
    const how = it.payMethod === 'cash' ? 'CASH' : it.payMethod === 'either' ? 'cash or card' : 'card';
    lines.push(`Pay on arrival (${how}): ${it.amount ? fmtMoney(it.amount, it.currency) : 'amount unknown'}`);
  }
  if (it.notes) lines.push('', it.notes);
  return lines.join('\n');
}

function summaryFor(it, suffix = '') {
  const meta = ITEM_TYPES[it.type] || ITEM_TYPES.other;
  const icon = it.type === 'transport' ? (TRANSPORT_MODES[it.mode]?.icon || meta.icon) : meta.icon;
  return `${icon} ${it.title || meta.label}${suffix}`;
}

function locationFor(it) {
  return [it.from, it.to].filter(Boolean).join(' → ');
}

function event({ uid, seq, start, end, summary, description, location, alarms }) {
  const out = [
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${utcStamp()}`,
    `SEQUENCE:${seq}`,
    `DTSTART:${floating(start)}`,
    `DTEND:${floating(end)}`,
    `SUMMARY:${escText(summary)}`,
  ];
  if (location) out.push(`LOCATION:${escText(location)}`);
  if (description) out.push(`DESCRIPTION:${escText(description)}`);
  out.push(...(alarms || []));
  out.push('END:VEVENT');
  return out;
}

function eventsForItem(it) {
  const start = parseLocal(it.start);
  if (!start) return [];                 // undated items have nothing to schedule
  const end = parseLocal(it.end);
  const seq = Math.floor((it.updatedAt || it.createdAt || 0) / 1000);
  const desc = describe(it);
  const loc = locationFor(it);

  // A stay becomes check-in and check-out rather than one multi-day block that
  // would smother every other day in the calendar.
  if (it.type === 'stay' && end) {
    return [
      ...event({
        uid: `${it.id}-in@trips.local`, seq, start, end: addMinutes(start, 60),
        summary: summaryFor(it, ' — check in'), description: desc, location: loc,
        alarms: alarm(60, `Check in: ${it.title || 'stay'}`),
      }),
      ...event({
        uid: `${it.id}-out@trips.local`, seq, start: end, end: addMinutes(end, 60),
        summary: summaryFor(it, ' — check out'), description: desc, location: loc,
        alarms: alarm(60, `Check out: ${it.title || 'stay'}`),
      }),
    ];
  }

  const lead = leadFor(it);
  const alarms = lead > 0
    ? [...alarm(lead, `Leave now — ${it.title || 'next leg'}`), ...alarm(0, `${it.title || 'Departure'} now`)]
    : alarm(30, it.title || 'Coming up');

  return event({
    uid: `${it.id}@trips.local`, seq, start,
    end: end || addMinutes(start, 60),
    summary: summaryFor(it), description: desc, location: loc, alarms,
  });
}

// One reminder per currency the evening before you first need the notes, because
// the cash machine is not going to be open at 06:00 on the way to the airport.
function cashEvents(items) {
  const out = [];
  for (const c of cashPlan(items)) {
    if (!c.firstNeeded) continue;
    const when = new Date(c.firstNeeded.getFullYear(), c.firstNeeded.getMonth(), c.firstNeeded.getDate() - 1, 18, 0);
    const total = fmtMoney(c.certain, c.currency);
    const maybe = c.maybe ? ` (plus ${fmtMoney(c.maybe, c.currency)} that could go on card)` : '';
    out.push(...event({
      uid: `cash-${c.currency}-${c.items[0].id}@trips.local`,
      seq: 0,
      start: when,
      end: addMinutes(when, 30),
      summary: `💵 Draw out ${total}`,
      description: `Cash needed from tomorrow${maybe}.\n\n`
        + c.items.map(i => `• ${i.title || 'Untitled'} — ${i.amount ? fmtMoney(i.amount, i.currency) : '?'}`).join('\n'),
      alarms: alarm(0, `Draw out ${total}`),
    }));
  }
  return out;
}

export function buildIcs(trip, items) {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:${PRODID}`,
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escText(trip.name || 'Trip')}`,
    'X-WR-TIMEZONE:UTC',
  ];
  for (const it of sortItems(items)) lines.push(...eventsForItem(it));
  lines.push(...cashEvents(items));
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}
