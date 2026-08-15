// Pure domain logic. No DOM, no IndexedDB — keeps the tricky bits testable.

export const TRANSPORT_MODES = {
  flight:   { label: 'Flight',      icon: '✈️', lead: 150 },
  train:    { label: 'Train',       icon: '🚆', lead: 25 },
  bus:      { label: 'Bus / coach', icon: '🚌', lead: 20 },
  ferry:    { label: 'Ferry',       icon: '⛴️', lead: 75 },
  car:      { label: 'Car rental',  icon: '🚗', lead: 30 },
  transfer: { label: 'Taxi / transfer', icon: '🛣️', lead: 10 },
};

export const ITEM_TYPES = {
  transport: { label: 'Transport', icon: '✈️' },
  stay:      { label: 'Stay',      icon: '🏨' },
  activity:  { label: 'Activity',  icon: '🎫' },
  food:      { label: 'Food',      icon: '🍽️' },
  other:     { label: 'Other',     icon: '📌' },
};

export const PAY_STATUS = {
  prepaid:  { label: 'Already paid',    needsMoney: false },
  deposit:  { label: 'Deposit paid',    needsMoney: true },
  on_site:  { label: 'Pay at the place', needsMoney: true },
  settled:  { label: 'Settled on trip',  needsMoney: false },
};

export const PAY_METHOD = {
  cash: { label: 'Cash only' },
  card: { label: 'Card' },
  either: { label: 'Cash or card' },
};

// One list instead of a type picker plus a mode picker. "Is it a flight or a
// hotel" is a single question to a person, so it should be a single field.
export const KINDS = {
  flight:   { label: 'Flight',        type: 'transport', mode: 'flight' },
  train:    { label: 'Train',         type: 'transport', mode: 'train' },
  bus:      { label: 'Bus or coach',  type: 'transport', mode: 'bus' },
  ferry:    { label: 'Ferry',         type: 'transport', mode: 'ferry' },
  car:      { label: 'Car hire',      type: 'transport', mode: 'car' },
  transfer: { label: 'Taxi',          type: 'transport', mode: 'transfer' },
  stay:     { label: 'Stay',          type: 'stay' },
  activity: { label: 'Activity',      type: 'activity' },
  food:     { label: 'Food',          type: 'food' },
  other:    { label: 'Other',         type: 'other' },
};

export function kindOf(it) {
  return it.type === 'transport' ? (it.mode || 'flight') : (it.type || 'other');
}

export function applyKind(item, kind) {
  const k = KINDS[kind] || KINDS.other;
  item.type = k.type;
  if (k.mode) item.mode = k.mode;
  return item;
}

export function blankItem(tripId) {
  return {
    id: null,
    tripId,
    type: 'transport',
    title: '',
    start: '',          // 'YYYY-MM-DDTHH:mm' local wall time
    end: '',
    from: '',
    to: '',
    mode: 'flight',
    leadMinutes: null,  // null => use mode default
    ref: '',
    provider: '',
    seat: '',
    docs: '',      // what you must physically have on you: passport, licence, cert card
    notes: '',
    payStatus: 'prepaid',
    payMethod: 'card',
    amount: '',
    currency: 'GBP',
    settledAt: null,
    createdAt: Date.now(),
  };
}

export function leadFor(item) {
  if (item.leadMinutes !== null && item.leadMinutes !== '' && item.leadMinutes !== undefined) {
    return Number(item.leadMinutes);
  }
  if (item.type !== 'transport') return 0;
  const m = TRANSPORT_MODES[item.mode];
  return m ? m.lead : 15;
}

// Local wall-clock string -> Date. Parsed as local time so the itinerary reads
// correctly in whatever timezone the phone is sitting in.
export function parseLocal(s) {
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/.exec(s);
  if (!m) return null;
  return new Date(+m[1], +m[2] - 1, +m[3], m[4] ? +m[4] : 0, m[5] ? +m[5] : 0, 0, 0);
}

export function leaveByDate(item) {
  const start = parseLocal(item.start);
  if (!start) return null;
  const lead = leadFor(item);
  if (!lead) return null;
  return new Date(start.getTime() - lead * 60000);
}

export function dayKey(d) {
  if (!d) return '';
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function sortItems(items) {
  return [...items].sort((a, b) => {
    const da = parseLocal(a.start), dbb = parseLocal(b.start);
    if (!da && !dbb) return a.createdAt - b.createdAt;
    if (!da) return 1;
    if (!dbb) return -1;
    return da - dbb;
  });
}

export function groupByDay(items) {
  const out = new Map();
  for (const it of sortItems(items)) {
    const k = dayKey(parseLocal(it.start)) || 'unscheduled';
    if (!out.has(k)) out.set(k, []);
    out.get(k).push(it);
  }
  return out;
}

// The next thing that still matters. An item stays "next" until its own start
// time passes, so you keep seeing the flight while you're sat at the gate.
export function nextUp(items, now = new Date()) {
  return sortItems(items).find(it => {
    const s = parseLocal(it.start);
    if (!s) return false;
    const end = parseLocal(it.end);
    return (end || s) >= now;
  }) || null;
}

export function itemsNeedingCash(items) {
  return items.filter(it => {
    const st = PAY_STATUS[it.payStatus];
    if (!st || !st.needsMoney) return false;
    if (it.settledAt) return false;
    return it.payMethod === 'cash' || it.payMethod === 'either';
  });
}

// Cash still to hand over, split by currency. `certain` is cash-only money you
// definitely need; `maybe` is cash-or-card, which you could cover with plastic.
export function cashPlan(items) {
  const byCur = new Map();
  for (const it of itemsNeedingCash(items)) {
    const cur = (it.currency || '?').toUpperCase();
    const amt = Number(it.amount) || 0;
    if (!byCur.has(cur)) byCur.set(cur, { currency: cur, certain: 0, maybe: 0, items: [], firstNeeded: null });
    const bucket = byCur.get(cur);
    if (it.payMethod === 'cash') bucket.certain += amt; else bucket.maybe += amt;
    bucket.items.push(it);
    const d = parseLocal(it.start);
    if (d && (!bucket.firstNeeded || d < bucket.firstNeeded)) bucket.firstNeeded = d;
  }
  for (const bucket of byCur.values()) bucket.items = sortItems(bucket.items);
  return [...byCur.values()].sort((a, b) => {
    if (!a.firstNeeded) return 1;
    if (!b.firstNeeded) return -1;
    return a.firstNeeded - b.firstNeeded;
  });
}

// Rates are entered by hand as "1 GBP = n", because an offline app cannot fetch
// them and a made-up rate is worse than an honest one you set yourself.
export function toBase(amount, currency, rates = {}, base = 'GBP') {
  const n = Number(amount) || 0;
  const cur = (currency || base).toUpperCase();
  if (cur === base) return n;
  const rate = Number(rates[cur]);
  return rate > 0 ? n / rate : null;   // null means "no rate set", never zero
}

export function tripTotals(items, rates = {}, base = 'GBP') {
  let paid = 0, owed = 0;
  const unconverted = new Map();

  for (const it of items) {
    if (!it.amount) continue;
    const converted = toBase(it.amount, it.currency, rates, base);
    const isOwed = PAY_STATUS[it.payStatus]?.needsMoney && !it.settledAt;

    if (converted === null) {
      const cur = (it.currency || '?').toUpperCase();
      const bucket = unconverted.get(cur) || { currency: cur, total: 0 };
      bucket.total += Number(it.amount) || 0;
      unconverted.set(cur, bucket);
      continue;
    }
    if (isOwed) owed += converted; else paid += converted;
  }

  return {
    base,
    paid,
    owed,
    total: paid + owed,
    unconverted: [...unconverted.values()],
  };
}

export function fmtMoney(amount, currency) {
  const n = Number(amount) || 0;
  const cur = (currency || '').toUpperCase();
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: cur, maximumFractionDigits: 2 }).format(n);
  } catch {
    return `${n.toFixed(2)} ${cur}`.trim();
  }
}

// Dates and times are stored separately in one string so a date can be pinned
// months ahead before the time is known — which is how trips actually get planned.
export const hasTime = s => typeof s === 'string' && s.length > 10;
export const datePart = s => (s || '').slice(0, 10);
export const timePart = s => (hasTime(s) ? s.slice(11, 16) : '');
export const joinWhen = (date, time) => (date ? (time ? `${date}T${time}` : date) : '');

// 24-hour throughout. Shorter, never wraps, and it matches every timetable,
// boarding pass and ticket you will be reading it against.
export function fmtTime(d) {
  if (!d) return '';
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
}

export function fmtDayLong(d) {
  if (!d) return 'No date yet';
  return d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
}

// "20 Nov" — what you need when the thing is weeks away.
export function fmtDayNum(d) {
  if (!d) return '';
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

export function fmtWeekday(d) {
  if (!d) return '';
  return d.toLocaleDateString(undefined, { weekday: 'long' });
}

export function fmtDayShort(d) {
  if (!d) return 'Undated';
  return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}

// "in 3 days", "in 2h 15m", "12m ago"
export function relative(target, now = new Date()) {
  if (!target) return '';
  let ms = target - now;
  const past = ms < 0;
  ms = Math.abs(ms);
  const mins = Math.floor(ms / 60000);
  const hours = Math.floor(mins / 60);
  const days = Math.floor(hours / 24);
  let s;
  if (days >= 1) s = `${days}d ${hours % 24}h`;
  else if (hours >= 1) s = `${hours}h ${mins % 60}m`;
  else s = `${mins}m`;
  return past ? `${s} ago` : `in ${s}`;
}

export function dayDiff(target, now = new Date()) {
  const a = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const b = new Date(target.getFullYear(), target.getMonth(), target.getDate());
  return Math.round((b - a) / 86400000);
}
