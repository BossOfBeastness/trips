// Turns the text of a booking confirmation into fields for the edit sheet.
// Everything it produces is a guess shown for confirmation — nothing here is
// ever saved without the user seeing it first.

const MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

// Words that look like airport codes but are not.
const NOT_IATA = new Set([
  'THE', 'AND', 'FOR', 'YOU', 'ALL', 'NEW', 'ONE', 'TWO', 'VAT', 'GBP', 'USD',
  'EUR', 'PEN', 'PDF', 'ETA', 'ETD', 'REF', 'MON', 'TUE', 'WED', 'THU', 'FRI',
  'SAT', 'SUN', 'JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP',
  'OCT', 'NOV', 'DEC', 'AIR', 'FLY', 'BUS', 'CAR', 'PNR', 'SEAT', 'GATE',
]);

const CURRENCY_SIGNS = { '£': 'GBP', '$': 'USD', '€': 'EUR', 'S/': 'PEN' };

const p2 = n => String(n).padStart(2, '0');

export function findDates(text, yearHint) {
  const out = [];
  const year = yearHint || new Date().getFullYear();

  // 2026-09-11
  for (const m of text.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) {
    out.push(`${m[1]}-${m[2]}-${m[3]}`);
  }
  // 11 September 2026 / 11 Sep 26 / Sep 11, 2026
  for (const m of text.matchAll(/\b(\d{1,2})\s+([A-Za-z]{3,9})\.?,?\s*(\d{4})?\b/g)) {
    const mo = MONTHS[m[2].slice(0, 3).toLowerCase()];
    if (!mo) continue;
    out.push(`${m[3] || year}-${p2(mo)}-${p2(+m[1])}`);
  }
  for (const m of text.matchAll(/\b([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s*(\d{4})?\b/g)) {
    const mo = MONTHS[m[1].slice(0, 3).toLowerCase()];
    if (!mo) continue;
    out.push(`${m[3] || year}-${p2(mo)}-${p2(+m[2])}`);
  }
  // 11/09/2026 — day first, which is what a UK traveller's paperwork uses.
  for (const m of text.matchAll(/\b(\d{1,2})\/(\d{1,2})\/(\d{2,4})\b/g)) {
    let y = +m[3];
    if (y < 100) y += 2000;
    const d = +m[1], mo = +m[2];
    if (mo > 12) continue;
    out.push(`${y}-${p2(mo)}-${p2(d)}`);
  }
  return [...new Set(out)];
}

export function findTimes(text) {
  const out = [];
  for (const m of text.matchAll(/\b(\d{1,2}):(\d{2})\s*(am|pm|AM|PM)?/g)) {
    let h = +m[1];
    const mins = +m[2];
    if (mins > 59) continue;
    const ap = (m[3] || '').toLowerCase();
    if (ap === 'pm' && h < 12) h += 12;
    if (ap === 'am' && h === 12) h = 0;
    if (h > 23) continue;
    out.push(`${p2(h)}:${p2(mins)}`);
  }
  return [...new Set(out)];
}

export function findFlightNumber(text) {
  const m = text.match(/\b([A-Z]{2}|[A-Z]\d|\d[A-Z])\s?(\d{2,4})\b/);
  return m ? `${m[1]}${m[2]}` : '';
}

export function findAirports(text) {
  const hits = [];
  for (const m of text.matchAll(/\b([A-Z]{3})\b/g)) {
    if (!NOT_IATA.has(m[1])) hits.push(m[1]);
  }
  return [...new Set(hits)];
}

// Six characters, letters and digits, at least one digit — the shape of an
// airline PNR. Excludes plain words, which is why the digit is required.
export function findReference(text) {
  const labelled = text.match(
    /(?:booking\s*(?:ref(?:erence)?|number|code)|reservation|confirmation|PNR|ref)\s*[:#-]?\s*([A-Z0-9]{5,10})\b/i);
  if (labelled) return labelled[1].toUpperCase();

  for (const m of text.matchAll(/\b([A-Z0-9]{6})\b/g)) {
    const s = m[1];
    if (/\d/.test(s) && /[A-Z]/.test(s)) return s;
  }
  return '';
}

export function findAmount(text) {
  const m = text.match(/([£$€]|S\/)\s?([\d,]+(?:\.\d{2})?)/)
    || text.match(/\b(GBP|USD|EUR|PEN|COP|BRL|CLP|ARS)\s?([\d,]+(?:\.\d{2})?)/i);
  if (!m) return { amount: '', currency: '' };
  const sign = m[1];
  const currency = CURRENCY_SIGNS[sign] || sign.toUpperCase();
  return { amount: m[2].replace(/,/g, ''), currency };
}

function guessKind(text) {
  const t = text.toLowerCase();
  if (/\b(flight|boarding|airline|departure gate|baggage|pnr)\b/.test(t)) return 'flight';
  if (/\b(hotel|hostel|check[- ]?in|check[- ]?out|airbnb|guesthouse|apartment)\b/.test(t)) return 'stay';
  if (/\b(train|rail|platform|coach class)\b/.test(t)) return 'train';
  if (/\b(bus|coach|terminal de|rede expressos)\b/.test(t)) return 'bus';
  if (/\b(ferry|boat|pier)\b/.test(t)) return 'ferry';
  if (/\b(car hire|rental car|europcar|hertz|avis|pick[- ]?up location)\b/.test(t)) return 'car';
  if (/\b(dive|tour|trek|ticket|entry|admission)\b/.test(t)) return 'activity';
  return 'other';
}

function guessTitle(text, kind, flight) {
  if (flight) return `Flight ${flight}`;
  const line = text.split(/\r?\n/).map(s => s.trim())
    .find(s => s.length > 3 && s.length < 60 && /[a-z]/.test(s));
  if (line) return line;
  return kind === 'other' ? '' : kind[0].toUpperCase() + kind.slice(1);
}

/**
 * Best guess at an item from arbitrary confirmation text.
 * Returns partial item fields plus `confidence`, which the sheet uses to decide
 * how loudly to tell the user to check it.
 */
export function parseBooking(text, { yearHint } = {}) {
  const clean = String(text || '').replace(/ /g, ' ');
  if (!clean.trim()) return null;

  const kind = guessKind(clean);
  const flight = kind === 'flight' ? findFlightNumber(clean) : '';
  const dates = findDates(clean, yearHint);
  const times = findTimes(clean);
  const airports = kind === 'flight' ? findAirports(clean) : [];
  const { amount, currency } = findAmount(clean);
  const ref = findReference(clean);

  const startDate = dates[0] || '';
  const endDate = dates[1] || '';

  const found = [dates.length, times.length, ref ? 1 : 0, flight ? 1 : 0].filter(Boolean).length;

  return {
    kind,
    title: guessTitle(clean, kind, flight),
    from: airports[0] || '',
    to: airports[1] || '',
    startDate,
    startTime: times[0] || '',
    endDate: kind === 'stay' ? endDate : (times[1] && !endDate ? startDate : endDate),
    endTime: times[1] || '',
    ref,
    amount,
    currency,
    confidence: found >= 3 ? 'high' : found === 2 ? 'medium' : 'low',
  };
}
