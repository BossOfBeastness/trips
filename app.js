import { db, uid } from './db.js';
import {
  TRANSPORT_MODES, ITEM_TYPES, PAY_STATUS, PAY_METHOD, KINDS,
  kindOf, applyKind, blankItem, leadFor, parseLocal, leaveByDate, groupByDay, sortItems,
  nextUp, cashPlan, fmtMoney, fmtTime, fmtDayLong, fmtDayShort, fmtDayNum, fmtWeekday,
  relative, dayDiff, hasTime, datePart, timePart, joinWhen, dayKey, tripTotals,
} from './model.js';
import { buildIcs } from './ics.js';
import { icon, ICON_FOR_KIND } from './icons.js';
import { coverageGaps, coverageByDay, addDays } from './coverage.js';
import { importFileToFields } from './importers.js';
import { parseBooking } from './parse.js';

const state = {
  trips: [],
  tripId: null,
  items: [],
  files: [],
  query: '',
  rates: {},
  lastKind: null,     // what you added last — the next one is usually the same
  focusDate: null,    // the day you were looking at when you tapped add
};

const $ = sel => document.querySelector(sel);
const view = $('#view');

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; }, 2400);
}

const iconFor = it => ICON_FOR_KIND[kindOf(it)] || 'pin';

/* ---------------------------------------------------------------- data --- */

async function load() {
  state.trips = await db.all('trips');
  state.trips.sort((a, b) => (a.start || '').localeCompare(b.start || ''));
  state.tripId = await db.metaGet('activeTrip', null);
  if (!state.trips.find(t => t.id === state.tripId)) {
    state.tripId = state.trips.length ? state.trips[0].id : null;
  }
  state.items = state.tripId ? await db.byIndex('items', 'tripId', state.tripId) : [];
  state.files = await db.all('files');
  state.rates = await db.metaGet('rates', {});
  state.lastKind = await db.metaGet('lastKind', null);
}

const trip = () => state.trips.find(t => t.id === state.tripId) || null;
const filesFor = id => state.files.filter(f => f.itemId === id);

async function saveItem(item) {
  if (!item.id) item.id = uid();
  item.updatedAt = Date.now();   // drives SEQUENCE so a re-imported .ics supersedes
  await db.put('items', item);
  await load();
  render();
}

async function deleteItem(id) {
  if (!confirm('Delete this? It cannot be undone.')) return;
  for (const f of filesFor(id)) await db.del('files', f.id);
  await db.del('items', id);
  closeSheet();
  await load();
  render();
  toast('Deleted');
}

/* --------------------------------------------------------------- render --- */

function render() {
  const t = trip();
  $('#tripName').textContent = t ? t.name : 'Trips';

  const route = (location.hash || '#/now').slice(2) || 'now';
  document.querySelectorAll('#tabs a').forEach(a => a.classList.toggle('on', a.dataset.tab === route));

  if (!t) {
    view.innerHTML = `
      <div class="empty">
        <div class="bloom"></div>
        <h2>No trips yet</h2>
        <p>Start one, then add flights and bookings as you plan them.</p>
        <button class="btn primary" data-new-trip>Start a trip</button>
      </div>`;
    view.querySelector('[data-new-trip]').addEventListener('click', () => editTrip(null));
    return;
  }

  ({ now: viewNow, plan: viewPlan, cash: viewCash }[route] || viewNow)();
}

/* ------------------------------------------------------------ view: next --- */

function viewNow() {
  const now = new Date();
  const t = trip();
  const next = nextUp(state.items, now);
  const tripStart = parseLocal(t.start);

  let html = '';

  if (tripStart && tripStart > now) {
    const d = dayDiff(tripStart, now);
    html += `<p class="trip-when">${d === 0 ? 'You leave today' : `${d} day${d === 1 ? '' : 's'} to go`}</p>`;
  }

  if (!next) {
    html += `
      <div class="empty">
        <div class="bloom"></div>
        <h2>Nothing ahead</h2>
        <p>Everything on this trip has been and gone.</p>
      </div>`;
    view.innerHTML = html;
    return;
  }

  html += focusCard(next, now);

  // Exactly one thing after this. Any more and the screen stops answering
  // "what now?" and starts being a list again.
  const after = sortItems(state.items).find(it => {
    if (it.id === next.id) return false;
    const s = parseLocal(it.start);
    return s && s >= now;
  });
  if (after) {
    const s = parseLocal(after.start);
    html += `
      <button class="after" data-open="${esc(after.id)}">
        <span class="after-time">${esc(fmtTime(s))}</span>
        <span class="after-title">${esc(after.title || 'Untitled')}</span>
      </button>`;
  }

  const open = gaps();
  if (open.length) {
    const beds = open.filter(g => g.kind === 'bed').length;
    const moves = open.length - beds;
    const parts = [];
    if (beds) parts.push(`${beds} night${beds === 1 ? '' : 's'} with nowhere booked`);
    if (moves) parts.push(`${moves} journey${moves === 1 ? '' : 's'} with no way there`);
    html += `
      <a class="note gap-note-line" href="#/plan">
        <span class="note-count">${open.length}</span>
        <span>${esc(parts.join(' · '))}</span>
      </a>`;
  }

  const soon = cashPlan(state.items).filter(c => c.firstNeeded && dayDiff(c.firstNeeded, now) <= 2);
  if (soon.length) {
    const c = soon[0];
    const by = esc(fmtDayShort(c.firstNeeded));
    // A total of zero means the amounts were never filled in, not that nothing
    // is owed. Say which, rather than printing a confident 0.00.
    const line = c.certain > 0
      ? `Have <strong>${esc(fmtMoney(c.certain, c.currency))}</strong> in cash by ${by}`
      : `<strong>${c.items.length} thing${c.items.length === 1 ? '' : 's'}</strong> to pay in cash by ${by} — no amounts yet`;
    html += `<a class="note" href="#/cash">${icon('wallet', { size: 18 })}<span>${line}</span></a>`;
  }

  // Nothing decorative here on purpose. This screen has one job — the leave-by
  // time — and anything next to it only competes. The palette carries the mood.
  view.innerHTML = html;
  wire();
}

function focusCard(it, now) {
  const start = parseLocal(it.start);
  const leave = hasTime(it.start) ? leaveByDate(it) : null;
  const overdue = leave && leave < now;
  const days = start ? dayDiff(start, now) : 0;

  // A leave-by clock is only useful once it is nearly time. Three months out the
  // number you need is the date, so that is what the card leads with.
  const imminent = start && days <= 1;

  let label, big, sub;
  if (imminent && leave) {
    label = overdue ? 'Should have left' : 'Leave by';
    big = fmtTime(leave);
    sub = `${relative(leave, now)} · ${leadFor(it)} min before ${fmtTime(start)}`;
  } else if (imminent) {
    label = 'Starts';
    big = fmtTime(start);
    sub = relative(start, now);
  } else {
    label = days === 1 ? 'Tomorrow' : 'Departs';
    big = fmtDayNum(start);
    sub = `${fmtWeekday(start)}${hasTime(it.start) ? ` · ${fmtTime(start)}` : ''} · ${days} days away`;
  }

  const route = it.from || it.to
    ? `<p class="focus-route">${esc(it.from || '')}${it.from && it.to ? '<span class="sep">to</span>' : ''}<span class="to">${esc(it.to || '')}</span></p>`
    : '';

  const end = parseLocal(it.end);
  const arrive = end && hasTime(it.end)
    ? `<p class="focus-arrive">Arrives ${esc(fmtTime(end))}${dayDiff(end, start) ? ` on ${esc(fmtDayNum(end))}` : ''}</p>`
    : '';

  return `
    <button class="focus ${overdue ? 'overdue' : ''}" data-open="${esc(it.id)}">
      <div class="focus-head">
        ${icon(iconFor(it), { size: 18 })}
        <span class="focus-when">${esc(KINDS[kindOf(it)]?.label || 'Item')}</span>
      </div>
      <h1 class="focus-title">${esc(it.title || 'Untitled')}</h1>
      ${route}
      ${arrive}
      ${it.docs ? `<p class="focus-docs">${icon('inbox', { size: 15 })}<span>${esc(it.docs)}</span></p>` : ''}
      <div class="depart">
        <span class="depart-label">${esc(label)}</span>
        <time class="depart-time">${esc(big)}</time>
        <span class="depart-rel">${esc(sub)}</span>
      </div>
    </button>`;
}

/* ------------------------------------------------------------ view: plan --- */

function matches(it, q) {
  if (!q) return true;
  return [it.title, it.from, it.to, it.provider, it.ref, it.notes, it.seat]
    .filter(Boolean).join(' ').toLowerCase().includes(q);
}

function viewPlan() {
  const now = new Date();
  const q = state.query.trim().toLowerCase();
  const shown = state.items.filter(it => matches(it, q));

  let html = `
    <div class="search">
      ${icon('search', { size: 17 })}
      <input id="q" type="search" placeholder="Search bookings and refs" value="${esc(state.query)}"
             autocapitalize="none" autocorrect="off" spellcheck="false">
    </div>`;

  if (!shown.length) {
    html += q
      ? `<div class="empty"><div class="bloom"></div><h2>No matches</h2><p>Nothing here mentions “${esc(state.query)}”.</p></div>`
      : `<div class="empty"><div class="bloom"></div><h2>Nothing planned</h2>
         <p>Add the first flight or booking with the plus button.</p></div>`;
  } else {
    if (!q) html += ribbon();

    const gapsByDate = new Map();
    if (!q) for (const g of gaps()) {
      if (!gapsByDate.has(g.date)) gapsByDate.set(g.date, []);
      gapsByDate.get(g.date).push(g);
    }

    // Days with items and days with only a gap are merged into one ordered
    // sequence, so a hole appears where it falls rather than at the bottom.
    const grouped = groupByDay(shown);
    const dated = [...grouped.keys()].filter(k => k !== 'unscheduled');
    const keys = [...new Set([...dated, ...gapsByDate.keys()])].sort();
    if (grouped.has('unscheduled')) keys.push('unscheduled');

    html += `<div class="trail">`;
    let prevDay = null;
    for (const key of keys) {
      const items = grouped.get(key) || [];
      const d = key === 'unscheduled' ? null : parseLocal(key);

      // One dash per empty day, so a week sat in one place looks like a week
      // rather than two entries touching.
      if (d && prevDay) {
        const gap = dayDiff(d, prevDay) - 1;
        if (gap > 0) {
          html += `<div class="gap" aria-label="${gap} day${gap === 1 ? '' : 's'} with nothing planned">`
            + '<span class="dash"></span>'.repeat(Math.min(gap, 14))
            + `<span class="gap-note">${gap} day${gap === 1 ? '' : 's'}</span></div>`;
        }
      }
      if (d) prevDay = d;

      const today = d && dayDiff(d, now) === 0;
      html += `<h2 class="day-label ${today ? 'today' : ''}" ${today ? 'id="todayMark"' : ''}>${d ? esc(fmtDayLong(d)) : 'No date yet'}</h2>`;
      html += items.map(it => stopRow(it, now, q)).join('');
      for (const g of gapsByDate.get(key) || []) html += gapMarker(g);
    }
    html += `</div>`;
  }

  view.innerHTML = html;
  wire();

  // Once the trip is under way, open Plan where you actually are.
  if (!q && !viewPlan._jumped) {
    const mark = $('#todayMark');
    if (mark) { mark.scrollIntoView({ block: 'start' }); viewPlan._jumped = true; }
  }

  const input = $('#q');
  input.addEventListener('input', () => {
    const pos = input.selectionStart;
    state.query = input.value;
    viewPlan();
    const next = $('#q');
    next.focus();
    next.setSelectionRange(pos, pos);
  });
}

/* -------------------------------------------------------------- gaps --- */

const dismissed = () => trip()?.dismissed || [];
const gaps = () => coverageGaps(trip(), state.items, dismissed());

function ribbon() {
  const rows = coverageByDay(trip(), state.items, dismissed());
  if (!rows.length) return '';
  return `
    <div class="ribbon" aria-label="What is booked, day by day">
      ${rows.map(r => `
        <div class="rday">
          <div class="rnum">${r.day}</div>
          <div class="rbar ${r.transitMissing ? 'miss' : (r.moves ? 'move' : '')}"></div>
          <div class="rbar ${r.lastNight ? 'none' : (r.bedMissing ? 'miss' : (r.bed ? 'bed' : ''))}"></div>
        </div>`).join('')}
    </div>
    <p class="ribbon-key">Travel above, somewhere to sleep below. <span class="miss-key">Dashed means nothing booked.</span></p>`;
}

function gapMarker(g) {
  const d = parseLocal(g.date);
  const text = g.kind === 'bed'
    ? `<b>No bed for ${esc(fmtWeekday(d))} night.</b>`
    : `<b>Nothing booked to ${esc(g.to || 'the next place')}.</b><span class="gap-why">You end ${esc(fmtWeekday(addDays(d, -1)))} in ${esc(g.from || 'another place')}.</span>`;
  return `
    <div class="hole">
      <span class="hole-node">?</span>
      <button class="hole-body" data-fix="${esc(g.date)}" data-kind="${esc(g.kind)}">${text}</button>
      <button class="hole-skip" data-dismiss="${esc(g.id)}" aria-label="Ignore this">Ignore</button>
    </div>`;
}

async function dismissGap(id) {
  const t = trip();
  t.dismissed = [...(t.dismissed || []), id];
  await db.put('trips', t);
  await load();
  render();
}

function stopRow(it, now, q) {
  const start = parseLocal(it.start);
  const done = start && start < now;
  const isNext = nextUp(state.items, now)?.id === it.id;

  const end = parseLocal(it.end);

  let sub = '';
  if (q && it.ref) sub = `<span class="stop-sub ref selectable">${esc(it.ref)}</span>`;
  else {
    const place = (it.from || it.to) ? [it.from, it.to].filter(Boolean).join(' to ') : it.provider;
    if (place) sub = `<span class="stop-sub">${esc(place)}</span>`;
  }

  const owes = !it.settledAt && PAY_STATUS[it.payStatus]?.needsMoney
    && (it.payMethod === 'cash' || it.payMethod === 'either');

  const cost = (it.amount || owes)
    ? `<span class="cost">
         <span class="cost-amt ${owes ? 'owed' : ''}">${esc(it.amount ? fmtMoney(it.amount, it.currency) : 'cash')}</span>
         ${owes ? '<span class="cost-tag">cash owed</span>' : ''}
       </span>`
    : '';

  // Departure over arrival, joined by a hairline. The +N is the important part:
  // without it, a flight landing 11:00 the next day reads as arriving early.
  let times;
  if (!start) {
    times = `<span class="dep">—</span>`;
  } else if (end && hasTime(it.end) && hasTime(it.start)) {
    const offset = dayDiff(end, start);
    times = `<span class="dep">${esc(fmtTime(start))}</span>`
      + `<span class="conn"></span>`
      + `<span class="arr">${esc(fmtTime(end))}${offset > 0 ? `<span class="plus">+${offset}</span>` : ''}</span>`;
  } else {
    times = `<span class="dep">${esc(hasTime(it.start) ? fmtTime(start) : 'all day')}</span>`;
  }

  return `
    <div class="stop-wrap">
      <button class="stop ${done ? 'done' : ''} ${isNext ? 'now' : ''}" data-open="${esc(it.id)}" data-id="${esc(it.id)}">
        <span class="node">${icon(iconFor(it), { size: 15 })}</span>
        <span class="stop-time">${times}</span>
        <span class="stop-body">
          <span class="stop-title">${esc(it.title || 'Untitled')}</span>
          ${sub}
        </span>
        ${cost}
      </button>
      ${owes ? `<button class="swipe-act" data-pay="${esc(it.id)}">Mark paid</button>` : ''}
    </div>`;
}

/* ------------------------------------------------------------ view: cash --- */

function viewCash() {
  const plan = cashPlan(state.items);
  const settled = state.items.filter(it => it.settledAt);

  if (!plan.length && !settled.length) {
    view.innerHTML = `
      <div class="empty">
        <div class="bloom"></div>
        <h2>Nothing owed</h2>
        <p>Mark a booking “pay at the place” and what you owe collects here.</p>
      </div>`;
    return;
  }

  const totals = tripTotals(state.items, state.rates);
  let html = '';

  if (totals.total || totals.unconverted.length) {
    html += `
      <section class="totals">
        <p class="eyebrow">What the trip costs</p>
        <div class="totals-sum">${esc(fmtMoney(totals.total, totals.base))}</div>
        <p class="totals-split">
          ${esc(fmtMoney(totals.paid, totals.base))} paid
          ${totals.owed ? ` · <span class="owed">${esc(fmtMoney(totals.owed, totals.base))} still owed</span>` : ''}
        </p>
        ${totals.unconverted.length ? `
          <p class="totals-missing">
            Not counted: ${totals.unconverted.map(u => esc(fmtMoney(u.total, u.currency))).join(', ')}
            — <button class="linkish" data-rates>set a rate</button>
          </p>` : ''}
      </section>`;
  }

  for (const c of plan) {
    html += `
      <section class="purse">
        <div class="purse-sum">
          ${c.certain > 0
            ? `<span class="purse-amount">${esc(fmtMoney(c.certain, c.currency))}</span>
               <span class="purse-cur">cash</span>`
            : `<span class="purse-amount">${esc(c.currency)}</span>
               <span class="purse-cur">amounts not set</span>`}
        </div>
        <p class="purse-when">${c.firstNeeded ? `First needed ${esc(fmtDayLong(c.firstNeeded))}` : 'No date set'}</p>
        ${c.maybe ? `<p class="purse-maybe">${esc(fmtMoney(c.maybe, c.currency))} more could go on a card.</p>` : ''}
        ${c.items.map(it => {
          const d = parseLocal(it.start);
          return `
          <div class="owe">
            <label class="tick"><input type="checkbox" data-settle="${esc(it.id)}" aria-label="Mark paid"><span></span></label>
            <button class="owe-body" data-open="${esc(it.id)}">
              <span class="owe-title">${esc(it.title || 'Untitled')}</span>
              <span class="owe-sub">${d ? esc(fmtDayShort(d)) : 'No date'}</span>
            </button>
            <span class="owe-amount">${esc(it.amount ? fmtMoney(it.amount, it.currency) : '—')}</span>
          </div>`;
        }).join('')}
      </section>`;
  }

  if (settled.length) {
    html += `<p class="eyebrow">Paid</p>`;
    html += settled.map(it => `
      <div class="owe settled">
        <button class="owe-body" data-open="${esc(it.id)}">
          <span class="owe-title">${esc(it.title || 'Untitled')}</span>
        </button>
        <button class="text-btn" data-unsettle="${esc(it.id)}">Undo</button>
      </div>`).join('');
  }

  view.innerHTML = html;
  wire();

  view.querySelectorAll('[data-rates]').forEach(el => el.addEventListener('click', editRates));

  view.querySelectorAll('[data-settle]').forEach(el => el.addEventListener('change', async () => {
    const it = state.items.find(x => x.id === el.dataset.settle);
    it.settledAt = Date.now();
    await saveItem(it);
    toast('Marked paid');
  }));
  view.querySelectorAll('[data-unsettle]').forEach(el => el.addEventListener('click', async () => {
    const it = state.items.find(x => x.id === el.dataset.unsettle);
    it.settledAt = null;
    await saveItem(it);
  }));
}

/* --------------------------------------------------------------- sheets --- */

function openSheet(title, bodyHtml, onSave) {
  $('#sheetTitle').textContent = title;
  $('#sheetBody').innerHTML = bodyHtml;
  $('#sheet').hidden = false;
  document.body.classList.add('locked');

  const save = $('#sheetSave');
  const cancel = document.querySelector('.sheet-head [data-close]');
  save.hidden = !onSave;
  cancel.textContent = onSave ? 'Cancel' : 'Done';
  if (onSave) save.onclick = onSave;
}

function closeSheet() {
  $('#sheet').hidden = true;
  document.body.classList.remove('locked');
}

function formEl() {
  const body = $('#sheetBody');
  let form = body.querySelector('form');
  if (!form) {
    form = document.createElement('form');
    while (body.firstChild) form.appendChild(body.firstChild);
    body.appendChild(form);
  }
  return form;
}

function field(label, name, value, opts = {}) {
  return `<label class="field">
    <span>${esc(label)}</span>
    <input name="${name}" type="${opts.type || 'text'}" value="${esc(value ?? '')}"
      ${opts.placeholder ? `placeholder="${esc(opts.placeholder)}"` : ''} ${opts.attrs || ''}>
  </label>`;
}

// A new item starts on the day you were looking at, as the kind you added last.
// Both are nearly always right, and both are one tap to change.
function newItemDefaults() {
  const it = blankItem(state.tripId);
  if (state.lastKind) applyKind(it, state.lastKind);
  if (state.focusDate) it.start = state.focusDate;
  return it;
}

/* ---------------------------------------------------------- when picker --- */

const TIME_CHIPS = ['06:00', '09:00', '12:00', '15:00', '18:00', '21:00'];

// Days a picker offers: the trip, plus two days either side for getting there
// and back. No trip dates yet means a fortnight from today.
function pickerDays() {
  const t = trip();
  const start = parseLocal(t?.start);
  const end = parseLocal(t?.end);
  const from = start ? addDays(start, -2) : new Date();
  const to = end ? addDays(end, 2) : addDays(new Date(), 14);

  const busy = new Set(state.items.map(i => datePart(i.start)).filter(Boolean));
  const out = [];
  for (let d = new Date(from.getFullYear(), from.getMonth(), from.getDate()); d <= to; d = addDays(d, 1)) {
    const key = dayKey(d);
    out.push({
      key,
      dow: d.toLocaleDateString(undefined, { weekday: 'short' }),
      num: d.getDate(),
      mon: d.toLocaleDateString(undefined, { month: 'short' }),
      busy: busy.has(key),
    });
  }
  return out;
}

function whenPicker(name, dateValue, timeValue) {
  const days = pickerDays();
  const known = days.some(d => d.key === dateValue);
  const outside = dateValue && !known;

  return `
    <div class="when" data-when="${name}">
      <input type="hidden" name="${name}Date" value="${esc(dateValue)}">
      <input type="hidden" name="${name}Time" value="${esc(timeValue)}">

      <div class="daystrip">
        ${days.map(d => `
          <button type="button" class="dayb ${d.key === dateValue ? 'on' : ''} ${d.busy ? 'busy' : ''}"
                  data-date="${d.key}">
            <span class="dow">${esc(d.dow)}</span>
            <span class="num">${d.num}</span>
            <span class="mon">${esc(d.mon)}</span>
          </button>`).join('')}
      </div>

      <div class="chiprow">
        ${TIME_CHIPS.map(t => `
          <button type="button" class="chip ${t === timeValue ? 'on' : ''}" data-time="${t}">${t}</button>`).join('')}
        <button type="button" class="chip ghost" data-typeit>Type it</button>
        <button type="button" class="chip ghost ${dateValue && !timeValue ? 'on' : ''}" data-notime>No time</button>
        <button type="button" class="chip ghost" data-clear>Clear</button>
      </div>

      <input type="time" class="loose" data-timefield hidden value="${esc(timeValue)}">
      <button type="button" class="chip ghost wide ${outside ? 'on' : ''}" data-otherdate>
        <span data-datelabel>${dateValue ? esc(fmtDayLong(parseLocal(dateValue))) : 'No date yet'}</span>
      </button>
      <input type="date" class="loose" data-datefield ${outside ? '' : 'hidden'} value="${esc(dateValue)}">
    </div>`;
}

// Wires one picker. Kept separate from the markup so re-rendering a strip after
// a trip's dates change does not need the whole sheet rebuilt.
function wireWhen(root) {
  root.querySelectorAll('[data-when]').forEach(box => {
    const dateInput = box.querySelector('[name$="Date"]');
    const timeInput = box.querySelector('[name$="Time"]');
    const timeField = box.querySelector('[data-timefield]');
    const dateField = box.querySelector('[data-datefield]');

    const label = box.querySelector('[data-datelabel]');
    const paint = () => {
      box.querySelectorAll('.dayb').forEach(b =>
        b.classList.toggle('on', b.dataset.date === dateInput.value));
      box.querySelectorAll('[data-time]').forEach(b =>
        b.classList.toggle('on', b.dataset.time === timeInput.value));
      box.querySelector('[data-notime]').classList.toggle('on', !!dateInput.value && !timeInput.value);
      label.textContent = dateInput.value
        ? fmtDayLong(parseLocal(dateInput.value))
        : 'No date yet';
    };

    box.querySelectorAll('.dayb').forEach(b => b.addEventListener('click', () => {
      dateInput.value = b.dataset.date === dateInput.value ? '' : b.dataset.date;
      paint();
    }));
    box.querySelectorAll('[data-time]').forEach(b => b.addEventListener('click', () => {
      timeInput.value = b.dataset.time === timeInput.value ? '' : b.dataset.time;
      timeField.value = timeInput.value;
      paint();
    }));
    box.querySelector('[data-typeit]').addEventListener('click', () => {
      timeField.hidden = !timeField.hidden;
      if (!timeField.hidden) timeField.focus();
    });
    timeField.addEventListener('change', () => { timeInput.value = timeField.value; paint(); });
    box.querySelector('[data-notime]').addEventListener('click', () => {
      timeInput.value = ''; timeField.value = ''; paint();
    });
    box.querySelector('[data-clear]').addEventListener('click', () => {
      dateInput.value = ''; timeInput.value = ''; timeField.value = ''; paint();
    });
    box.querySelector('[data-otherdate]').addEventListener('click', () => {
      dateField.hidden = !dateField.hidden;
      if (!dateField.hidden) dateField.focus();
    });
    dateField.addEventListener('change', () => { dateInput.value = dateField.value; paint(); });

    // Bring the chosen day into view rather than leaving it scrolled off.
    const on = box.querySelector('.dayb.on');
    if (on) on.scrollIntoView({ block: 'nearest', inline: 'center' });
  });
}

function select(label, name, value, options) {
  return `<label class="field">
    <span>${esc(label)}</span>
    <select name="${name}">
      ${Object.entries(options).map(([k, v]) =>
        `<option value="${esc(k)}" ${k === value ? 'selected' : ''}>${esc(v.label || v)}</option>`).join('')}
    </select>
  </label>`;
}

/* ---------------------------------------------------------- edit: trip --- */

function editTrip(tr) {
  const t = tr || { id: null, name: '', start: '', end: '' };
  openSheet(tr ? 'Edit trip' : 'New trip', `
    ${field('Name', 'name', t.name, { placeholder: 'South America 2026' })}
    ${field('First day', 'start', t.start, { type: 'date' })}
    ${field('Last day', 'end', t.end, { type: 'date' })}
    ${tr ? `<button type="button" class="btn quiet" id="delTrip">Delete this trip</button>` : ''}
  `, async () => {
    const f = new FormData(formEl());
    const name = (f.get('name') || '').trim();
    if (!name) { toast('Give the trip a name'); return; }
    const rec = { id: t.id || uid(), name, start: f.get('start') || '', end: f.get('end') || '' };
    await db.put('trips', rec);
    await db.metaSet('activeTrip', rec.id);
    closeSheet();
    await load();
    render();
  });

  $('#delTrip')?.addEventListener('click', async () => {
    if (!confirm(`Delete “${t.name}” and everything in it? This cannot be undone.`)) return;
    for (const it of await db.byIndex('items', 'tripId', t.id)) {
      for (const fl of filesFor(it.id)) await db.del('files', fl.id);
      await db.del('items', it.id);
    }
    await db.del('trips', t.id);
    closeSheet();
    await load();
    render();
    toast('Trip deleted');
  });
}

/* ---------------------------------------------------------- edit: item --- */

// `seed` lets a gap marker or an imported file open the sheet already filled in.
function editItem(existing, { isNew: forceNew = false } = {}) {
  const it = existing ? { ...existing } : newItemDefaults();
  const isNew = forceNew || !existing;
  const pendingFiles = [];

  // Separate date and time boxes rather than one datetime-local. The native
  // combined picker is miserable on a phone, and a date can be known months
  // before the time is, which the combined control refuses to accept.
  openSheet(isNew ? 'Add to trip' : 'Edit', `
    ${select('What kind', 'kind', kindOf(it), KINDS)}
    ${field('Name it', 'title', it.title, { placeholder: 'Flight to Cusco' })}

    <div class="field-pair">
      <div data-only="transport" style="flex:1">
        ${field('From', 'from', it.from, { placeholder: 'Gatwick' })}
      </div>
      ${field('To', 'to', it.to, { placeholder: 'Cusco' })}
    </div>

    <p class="sheet-section">Starts</p>
    ${whenPicker('start', datePart(it.start), timePart(it.start))}

    <p class="sheet-section">Arrives or ends</p>
    ${whenPicker('end', datePart(it.end), timePart(it.end))}

    ${field('Bring', 'docs', it.docs, { placeholder: 'Passport, driving licence, PADI card' })}

    <p class="sheet-section">Cost</p>
    <div class="field-pair">
      ${field('How much', 'amount', it.amount, { type: 'number', attrs: 'step="0.01" min="0" inputmode="decimal"' })}
      ${field('Currency', 'currency', it.currency || 'GBP', { attrs: 'maxlength="3" autocapitalize="characters"' })}
    </div>
    ${select('Paying', 'payStatus', it.payStatus, PAY_STATUS)}
    ${select('With', 'payMethod', it.payMethod, PAY_METHOD)}

    <details class="more">
      <summary>Booking details and notes</summary>
      ${field('Reference', 'ref', it.ref, { placeholder: 'XK9P2T' })}
      ${field('Booked with', 'provider', it.provider, { placeholder: 'LATAM' })}
      ${field('Seat or vehicle', 'seat', it.seat, { placeholder: '14A' })}
      ${field('Leave this many minutes early', 'leadMinutes', it.leadMinutes ?? '', {
        type: 'number', placeholder: `${TRANSPORT_MODES[it.mode]?.lead ?? 0} by default`, attrs: 'min="0" step="5"' })}
      <label class="field"><span>Notes</span>
        <textarea name="notes" rows="4" placeholder="Key safe code, meeting point, who to ask for">${esc(it.notes)}</textarea>
      </label>
      <div id="fileList" class="chip-row"></div>
      <label class="btn">
        Attach a photo or PDF
        <input type="file" id="fileInput" accept="image/*,application/pdf" multiple hidden>
      </label>
      <p class="hint">Kept on this phone. Opens with no signal.</p>
    </details>

    ${isNew ? '' : `<button type="button" class="btn quiet" id="delItem">Delete this</button>`}
  `, async () => {
    const f = new FormData(formEl());
    const next = applyKind({
      ...it,
      tripId: state.tripId,
      title: (f.get('title') || '').trim(),
      from: (f.get('from') || '').trim(),
      to: (f.get('to') || '').trim(),
      seat: (f.get('seat') || '').trim(),
      docs: (f.get('docs') || '').trim(),
      start: joinWhen(f.get('startDate'), f.get('startTime')),
      end: joinWhen(f.get('endDate'), f.get('endTime')),
      leadMinutes: f.get('leadMinutes') === '' ? null : Number(f.get('leadMinutes')),
      provider: (f.get('provider') || '').trim(),
      ref: (f.get('ref') || '').trim().toUpperCase(),
      payStatus: f.get('payStatus'),
      payMethod: f.get('payMethod'),
      amount: f.get('amount') || '',
      currency: (f.get('currency') || '').trim().toUpperCase() || 'GBP',
      notes: (f.get('notes') || '').trim(),
    }, f.get('kind'));
    if (!next.title && !next.ref) { toast('Give it a name'); return; }
    if (!next.id) next.id = uid();
    state.lastKind = f.get('kind');
    await db.metaSet('lastKind', state.lastKind);
    for (const pending of pendingFiles) await db.put('files', { ...pending, itemId: next.id });
    closeSheet();
    await saveItem(next);
    toast('Saved');
  });

  const refreshFiles = () => {
    const all = [...(it.id ? filesFor(it.id) : []), ...pendingFiles];
    $('#fileList').innerHTML = all.length
      ? all.map(f => `<span class="chip">
          <button type="button" class="text-btn" data-open-file="${esc(f.id)}" style="padding:0">${esc(f.name)}</button>
          <button type="button" class="text-btn" data-rm="${esc(f.id)}" style="padding:0;color:var(--alert)">Remove</button>
        </span>`).join('')
      : `<p class="hint">Nothing attached.</p>`;

    $('#fileList').querySelectorAll('[data-open-file]').forEach(el => el.addEventListener('click', () => {
      const f = all.find(x => x.id === el.dataset.openFile);
      const url = URL.createObjectURL(f.blob);
      window.open(url, '_blank');
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    }));
    $('#fileList').querySelectorAll('[data-rm]').forEach(el => el.addEventListener('click', async () => {
      const id = el.dataset.rm;
      const i = pendingFiles.findIndex(x => x.id === id);
      if (i >= 0) pendingFiles.splice(i, 1);
      else { await db.del('files', id); state.files = await db.all('files'); }
      refreshFiles();
    }));
  };
  refreshFiles();

  $('#fileInput').addEventListener('change', e => {
    for (const file of e.target.files) {
      pendingFiles.push({ id: uid(), itemId: it.id, name: file.name, type: file.type, size: file.size, blob: file });
    }
    e.target.value = '';
    refreshFiles();
  });

  // "From" only means something when you are moving. Hide it otherwise.
  wireWhen($('#sheetBody'));

  const kindSel = formEl().querySelector('[name=kind]');
  const syncKind = () => {
    const type = KINDS[kindSel.value]?.type;
    $('#sheetBody').querySelectorAll('[data-only]').forEach(el => {
      el.style.display = el.dataset.only === type ? '' : 'none';
    });
  };
  kindSel.addEventListener('change', syncKind);
  syncKind();

  $('#delItem')?.addEventListener('click', () => deleteItem(it.id));
}

/* --------------------------------------------------------------- import --- */

function openImport() {
  openSheet('Add from a confirmation', `
    <p class="hint">Drop in a calendar invite, a wallet pass, a PDF or a screenshot, or just
      paste the text of the email. Whatever it works out lands in the normal form for you
      to check — nothing is saved until you say so.</p>

    <label class="btn" id="pickWrap">
      ${icon('inbox', { size: 18 })} Choose a file
      <input type="file" id="importPick" hidden
             accept=".ics,.pkpass,.pdf,image/*,text/plain,text/calendar,application/pdf">
    </label>

    <p class="sheet-section">Or paste the text</p>
    <label class="field">
      <span>Confirmation email, booking page, anything</span>
      <textarea id="pasteBox" rows="7" placeholder="Paste here…"></textarea>
    </label>
    <button type="button" class="btn primary" id="parsePaste">Read it</button>

    <p class="hint" id="importStatus"></p>
    <p class="hint">A photo of a ticket works, but reading pictures is the least reliable
      route and usually needs correcting. On an iPhone it is better to long-press the photo,
      select the text yourself and paste it above.</p>
  `, null);

  const status = msg => { $('#importStatus').textContent = msg || ''; };

  $('#importPick').addEventListener('change', async e => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      status('Reading…');
      const fields = await importFileToFields(file, status);
      status('');
      offerImported(fields);
    } catch (err) {
      status(err.message || 'That file could not be read.');
    }
  });

  $('#parsePaste').addEventListener('click', () => {
    const text = $('#pasteBox').value;
    const fields = parseBooking(text, { yearHint: parseLocal(trip()?.start)?.getFullYear() });
    if (!fields) { status('Nothing to read in that.'); return; }
    offerImported({ ...fields, source: 'pasted text' });
  });
}

// Everything an importer produces is a guess. Open the normal editor with the
// guesses filled in, and say plainly how much to trust them.
function offerImported(fields) {
  const it = applyKind(blankItem(state.tripId), fields.kind || 'other');
  Object.assign(it, {
    title: fields.title || '',
    from: fields.from || '',
    to: fields.to || '',
    seat: fields.seat || '',
    ref: fields.ref || '',
    provider: fields.provider || '',
    notes: fields.notes || '',
    amount: fields.amount || '',
    currency: fields.currency || 'GBP',
    start: joinWhen(fields.startDate, fields.startTime),
    end: joinWhen(fields.endDate, fields.endTime),
  });

  closeSheet();
  editItem(it, { isNew: true });

  const conf = fields.confidence || 'low';
  const line = conf === 'high'
    ? `Read from the ${fields.source || 'file'}. Worth a glance.`
    : `Best guess from the ${fields.source || 'text'} — check every field.`;
  const banner = document.createElement('p');
  banner.className = `import-banner ${conf}`;
  banner.textContent = line;
  $('#sheetBody').prepend(banner);
}

/* ---------------------------------------------------------------- rates --- */

// One number per currency, typed once. No network means no live rates, and a
// rate you set knowingly beats one the app invented.
function editRates() {
  const used = [...new Set(state.items.map(i => (i.currency || '').toUpperCase())
    .filter(c => c && c !== 'GBP'))];
  const known = Object.keys(state.rates || {});
  const all = [...new Set([...used, ...known])];

  openSheet('Exchange rates', `
    <p class="hint">How many of each currency you get for one pound. Roughly right is
      fine — this is for totting up a trip, not for accounting.</p>
    ${all.length
      ? all.map(c => field(`1 GBP buys this many ${c}`, `rate_${c}`, state.rates?.[c] ?? '', {
          type: 'number', attrs: 'step="0.0001" min="0" inputmode="decimal"',
        })).join('')
      : '<p class="hint">Nothing on this trip is priced in another currency yet.</p>'}
  `, async () => {
    const f = new FormData(formEl());
    const next = {};
    for (const [k, v] of f.entries()) {
      if (!k.startsWith('rate_')) continue;
      const n = Number(v);
      if (n > 0) next[k.slice(5)] = n;
    }
    await db.metaSet('rates', next);
    closeSheet();
    await load();
    render();
    toast('Rates saved');
  });
}

/* ------------------------------------------------------------- settings --- */

function openSettings() {
  const bytes = state.files.reduce((a, f) => a + (f.size || 0), 0);

  openSheet('Settings', `
    <p class="sheet-section">Trips</p>
    <div class="rowlist">
      ${state.trips.map(tr => `
        <div class="rowline ${tr.id === state.tripId ? 'on' : ''}">
          <button class="rowline-body" data-pick="${esc(tr.id)}">
            <span class="rowline-title">${esc(tr.name)}</span>
            <span class="rowline-sub">${esc([tr.start, tr.end].filter(Boolean).join(' to ') || 'No dates')}</span>
          </button>
          <button class="text-btn" data-edit-trip="${esc(tr.id)}">Edit</button>
        </div>`).join('')}
    </div>
    <button type="button" class="btn" id="newTrip">Start another trip</button>

    <p class="sheet-section">Add from a confirmation</p>
    <div class="panel">
      <p class="hint">Calendar invite, wallet pass, PDF, screenshot, or pasted email text.
        Whatever it can work out gets filled in for you to check.</p>
      <button type="button" class="btn" id="importBookingBtn">${icon('inbox', { size: 18 })} Read a booking</button>
    </div>

    <p class="sheet-section">Money</p>
    <div class="panel">
      <p class="hint">Exchange rates, so a trip in three currencies still adds up to one number.</p>
      <button type="button" class="btn" id="ratesBtn">Exchange rates</button>
    </div>

    <p class="sheet-section">Reminders</p>
    <div class="panel">
      <p class="hint">This app can't buzz you on its own. Your phone's Calendar can. Send the trip
        across and it handles the alarms itself, offline, with this closed.</p>
      <p class="hint">One nudge at each leave-by time, a day-before warning on flights, check in
        and check out for stays, and the evening before you first need cash.</p>
      <div class="btn-pair">
        <button type="button" class="btn" id="icsBtn">${icon('calendar', { size: 18 })} Send all</button>
        <button type="button" class="btn" id="icsTravelBtn">Travel only</button>
      </div>
      <p class="hint"><strong>Import into a new calendar of its own</strong> (Calendar → Calendars →
        Add Calendar). Sending again after you change the plan adds a second copy of everything, so
        delete that calendar first and re-send. The file is named after the trip to make it obvious
        which one to bin.</p>
    </div>

    <p class="sheet-section">Backup and sharing</p>
    <div class="panel">
      <p class="hint">One file holds every trip, item and attachment. AirDrop it across — no wifi
        or internet needed — and the other phone opens it with Restore.</p>
      <div class="btn-pair">
        <button type="button" class="btn" id="exportBtn">${icon('share', { size: 18 })} Back up</button>
        <button type="button" class="btn" id="importBtn">${icon('inbox', { size: 18 })} Restore</button>
      </div>
      <input type="file" id="importInput" accept=".json,application/json" hidden>
      <p class="hint">${state.files.length} attachment${state.files.length === 1 ? '' : 's'}, ${(bytes / 1048576).toFixed(1)} MB on this phone.</p>
      <p class="hint" id="quota"></p>
    </div>

    <p class="sheet-section">Version</p>
    <div class="panel">
      <p class="hint">This copy is <strong>${esc(APP_VERSION)}</strong>.</p>
      <button type="button" class="btn" id="updateBtn">Check for an update</button>
      <p class="hint" id="updateStatus"></p>
      <p class="hint">An installed app can keep running an old build after the new one has
        downloaded. If something described here is missing, force-quit it from the app
        switcher and open it again.</p>
    </div>

    <p class="sheet-section">Keeping it installed</p>
    <div class="panel">
      <p class="hint">Open in Safari, then Share and <strong>Add to Home Screen</strong>. Launch it from
        the icon rather than the browser, or iOS keeps two separate copies of your data.</p>
      <p class="hint">iOS can clear web storage after weeks of not opening an app. Back up before every trip.</p>
    </div>

    <button type="button" class="btn quiet" id="wipeBtn">Erase everything on this phone</button>
  `, null);

  const body = $('#sheetBody');
  body.querySelectorAll('[data-pick]').forEach(el => el.addEventListener('click', async () => {
    await db.metaSet('activeTrip', el.dataset.pick);
    closeSheet();
    await load();
    location.hash = '#/now';
    render();
  }));
  body.querySelectorAll('[data-edit-trip]').forEach(el => el.addEventListener('click', () =>
    editTrip(state.trips.find(x => x.id === el.dataset.editTrip))));
  $('#newTrip').addEventListener('click', () => editTrip(null));
  $('#updateBtn').addEventListener('click', async () => {
    $('#updateStatus').textContent = 'Checking…';
    $('#updateStatus').textContent = await checkForUpdate();
  });
  $('#importBookingBtn').addEventListener('click', openImport);
  $('#ratesBtn').addEventListener('click', editRates);
  $('#icsBtn').addEventListener('click', () => exportIcs(false));
  $('#icsTravelBtn').addEventListener('click', () => exportIcs(true));
  $('#exportBtn').addEventListener('click', exportAll);
  $('#importBtn').addEventListener('click', () => $('#importInput').click());
  $('#importInput').addEventListener('change', e => importFile(e.target.files[0]));
  $('#wipeBtn').addEventListener('click', async () => {
    if (!confirm('This erases every trip, item and attachment on this phone. Back up first. Continue?')) return;
    if (!confirm('Really erase everything? This cannot be undone.')) return;
    await db.clearAll();
    closeSheet();
    await load();
    render();
    toast('Erased');
  });
  showQuota();
}

// The browser decides how much room this gets and whether it survives being
// unused, so both are worth showing rather than hiding.
async function showQuota() {
  const el = $('#quota');
  if (!el || !navigator.storage?.estimate) return;
  try {
    const { usage = 0, quota = 0 } = await navigator.storage.estimate();
    const persisted = navigator.storage.persisted ? await navigator.storage.persisted() : false;
    el.textContent = `${(usage / 1048576).toFixed(1)} MB used of ${(quota / 1073741824).toFixed(2)} GB allowed. `
      + (persisted ? 'Storage is marked persistent.' : 'Storage is not persistent — back up regularly.');
  } catch { /* estimate unsupported; the totals above still show */ }
}

/* ------------------------------------------------------- export / import --- */

const blobToDataUrl = blob => new Promise((res, rej) => {
  const r = new FileReader();
  r.onload = () => res(r.result);
  r.onerror = rej;
  r.readAsDataURL(blob);
});

async function exportAll() {
  const files = [];
  for (const f of await db.all('files')) {
    files.push({ id: f.id, itemId: f.itemId, name: f.name, type: f.type, size: f.size, data: await blobToDataUrl(f.blob) });
  }
  const payload = {
    format: 'trips-export',
    version: 1,
    exportedAt: new Date().toISOString(),
    trips: await db.all('trips'),
    items: await db.all('items'),
    files,
  };
  await shareOrDownload(
    new Blob([JSON.stringify(payload)], { type: 'application/json' }),
    `trips-${new Date().toISOString().slice(0, 10)}.json`,
    'Trips backup'
  );
}

// travelOnly drops the meals and loose activities, which is usually what you
// want in a shared calendar you actually look at.
async function exportIcs(travelOnly = false) {
  const t = trip();
  if (!t) { toast('No trip selected'); return; }

  const items = travelOnly
    ? state.items.filter(it => it.type === 'transport' || it.type === 'stay')
    : state.items;

  if (!items.some(it => it.start)) { toast('Nothing has a date yet'); return; }

  const slug = (t.name || 'trip').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'trip';
  const name = travelOnly ? `${slug}-travel.ics` : `${slug}.ics`;
  const cal = { ...t, name: travelOnly ? `${t.name} (travel)` : t.name };
  await shareOrDownload(new Blob([buildIcs(cal, items)], { type: 'text/calendar' }), name, cal.name);
}

// The share sheet is the useful path on iOS: it reaches Calendar, Files and
// AirDrop in one go. A download link is the desktop fallback.
async function shareOrDownload(blob, name, title) {
  const file = new File([blob], name, { type: blob.type });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title });
      return;
    } catch (err) {
      if (err && err.name === 'AbortError') return;
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

async function importFile(file) {
  if (!file) return;
  let payload;
  try { payload = JSON.parse(await file.text()); }
  catch { toast('That is not a Trips backup'); return; }
  if (payload.format !== 'trips-export') { toast('That is not a Trips backup'); return; }

  const nTrips = payload.trips?.length || 0;
  const nItems = payload.items?.length || 0;
  if (!confirm(`Restore ${nTrips} trip(s) and ${nItems} item(s)? Anything already here with the same id is replaced by the incoming copy.`)) return;

  await db.putMany('trips', payload.trips || []);
  await db.putMany('items', payload.items || []);
  for (const f of payload.files || []) {
    await db.put('files', {
      id: f.id, itemId: f.itemId, name: f.name, type: f.type, size: f.size,
      blob: await (await fetch(f.data)).blob(),
    });
  }
  // Land on what was just restored rather than the earliest trip, which would
  // look like the restore did nothing.
  if (payload.trips?.length) await db.metaSet('activeTrip', payload.trips[0].id);
  closeSheet();
  await load();
  location.hash = '#/now';
  render();
  toast('Restored');
}

/* ---------------------------------------------------------------- wiring --- */

function wire() {
  view.querySelectorAll('[data-open]').forEach(el => el.addEventListener('click', ev => {
    ev.preventDefault();
    const it = state.items.find(x => x.id === el.dataset.open);
    if (it) editItem(it);
  }));

  view.querySelectorAll('[data-dismiss]').forEach(el => el.addEventListener('click', ev => {
    ev.stopPropagation();
    dismissGap(el.dataset.dismiss);
  }));

  // Tapping a gap opens a new item already dated for the day with the hole in it.
  view.querySelectorAll('[data-fix]').forEach(el => el.addEventListener('click', () => {
    const seed = blankItem(state.tripId);
    seed.start = el.dataset.fix;
    if (el.dataset.kind === 'bed') { seed.type = 'stay'; seed.mode = 'stay'; }
    editItem(seed, { isNew: true });
  }));

  view.querySelectorAll('[data-pay]').forEach(el => el.addEventListener('click', async ev => {
    ev.stopPropagation();
    const it = state.items.find(x => x.id === el.dataset.pay);
    it.settledAt = Date.now();
    await saveItem(it);
    toast('Marked paid');
  }));

  wireSwipe();
}

// A short drag left on a row reveals its action. Kept deliberately crude: no
// momentum, no animation frames, just enough to beat opening the editor.
function wireSwipe() {
  view.querySelectorAll('.stop-wrap').forEach(wrap => {
    if (!wrap.querySelector('.swipe-act')) return;
    const row = wrap.querySelector('.stop');
    let x0 = null, open = false;

    row.addEventListener('touchstart', e => { x0 = e.touches[0].clientX; }, { passive: true });
    row.addEventListener('touchmove', e => {
      if (x0 === null) return;
      const dx = e.touches[0].clientX - x0;
      if (dx < -12) { wrap.classList.add('swiped'); open = true; }
      if (dx > 12) { wrap.classList.remove('swiped'); open = false; }
    }, { passive: true });
    row.addEventListener('touchend', () => { x0 = null; }, { passive: true });

    // A tap anywhere else puts it back.
    row.addEventListener('click', e => {
      if (open) { e.preventDefault(); e.stopPropagation(); wrap.classList.remove('swiped'); open = false; }
    }, true);
  });
}

function paintChrome() {
  $('#addBtn').innerHTML = icon('plus', { size: 22 });
  $('#setBtn').innerHTML = icon('settings', { size: 20 });
  const tabIcons = { now: 'clock', plan: 'route', cash: 'wallet' };
  document.querySelectorAll('#tabs a').forEach(a => {
    a.querySelector('.tab-ic').innerHTML = icon(tabIcons[a.dataset.tab], { size: 21 });
  });
}

function init() {
  paintChrome();
  document.querySelectorAll('[data-close]').forEach(el => el.addEventListener('click', closeSheet));
  $('#addBtn').addEventListener('click', () => state.tripId ? editItem(null) : editTrip(null));
  $('#setBtn').addEventListener('click', openSettings);
  $('#tripBtn').addEventListener('click', openSettings);
  window.addEventListener('hashchange', () => { state.query = ''; render(); });

  // Keep the countdown honest without redrawing screens you are reading.
  setInterval(() => { if ((location.hash || '#/now') === '#/now') render(); }, 30000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) render(); });
}

// Bumped with the service worker cache. Shown in Settings so there is a way to
// tell what a phone is actually running — an installed PWA will happily keep
// serving a months-old build with no outward sign.
export const APP_VERSION = 'v10';

let swReg = null;
let reloading = false;

async function registerWorker() {
  if (!('serviceWorker' in navigator)) return;
  try {
    swReg = await navigator.serviceWorker.register('sw.js');

    // A new worker taking control means the code on this page is stale. Reload
    // once, immediately, rather than leaving the old version running.
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (reloading) return;
      reloading = true;
      location.reload();
    });

    swReg.update().catch(() => {});
  } catch { /* offline, or blocked — the app still works from cache */ }
}

export async function checkForUpdate() {
  if (!swReg) return 'This copy is not running a cached build.';
  try {
    await swReg.update();
    if (swReg.installing || swReg.waiting) return 'Update found — reloading.';
    return `Up to date (${APP_VERSION}).`;
  } catch {
    return 'Could not check — no connection.';
  }
}

(async function main() {
  init();
  await load();
  if (!location.hash) location.hash = '#/now';
  render();
  registerWorker();
  if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
})();
