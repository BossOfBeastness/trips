import { db, uid } from './db.js';
import {
  TRANSPORT_MODES, ITEM_TYPES, PAY_STATUS, PAY_METHOD, KINDS,
  kindOf, applyKind, blankItem, leadFor, parseLocal, leaveByDate, groupByDay, sortItems,
  nextUp, cashPlan, fmtMoney, fmtTime, fmtDayLong, fmtDayShort, fmtDayNum, fmtWeekday,
  relative, dayDiff, hasTime, datePart, timePart, joinWhen,
} from './model.js';
import { buildIcs } from './ics.js';
import { icon, ICON_FOR_KIND } from './icons.js';

const state = {
  trips: [],
  tripId: null,
  items: [],
  files: [],
  query: '',
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
    html += `<div class="trail">`;
    let prevDay = null;
    for (const [key, items] of groupByDay(shown)) {
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
      html += `<h2 class="day-label ${today ? 'today' : ''}">${d ? esc(fmtDayLong(d)) : 'No date yet'}</h2>`;
      html += items.map(it => stopRow(it, now, q)).join('');
    }
    html += `</div>`;
  }

  view.innerHTML = html;
  wire();

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

function stopRow(it, now, q) {
  const start = parseLocal(it.start);
  const done = start && start < now;
  const isNext = nextUp(state.items, now)?.id === it.id;

  const end = parseLocal(it.end);
  // Arrival matters as much as departure when you are the one travelling.
  const arrive = end && hasTime(it.end) ? `arr ${fmtTime(end)}` : '';

  let sub = '';
  if (q && it.ref) sub = `<span class="stop-sub ref selectable">${esc(it.ref)}</span>`;
  else {
    const bits = [
      (it.from || it.to) ? [it.from, it.to].filter(Boolean).join(' to ') : it.provider,
      arrive,
    ].filter(Boolean);
    if (bits.length) sub = `<span class="stop-sub">${esc(bits.join(' · '))}</span>`;
  }

  const owes = !it.settledAt && PAY_STATUS[it.payStatus]?.needsMoney
    && (it.payMethod === 'cash' || it.payMethod === 'either');

  // Cost sits in the margin like a note pencilled beside the entry.
  const cost = it.amount
    ? `<span class="cost ${owes ? 'owed' : ''}">${esc(fmtMoney(it.amount, it.currency))}</span>`
    : (owes ? `<span class="cost owed">cash</span>` : '');

  return `
    <button class="stop ${done ? 'done' : ''} ${isNext ? 'now' : ''}" data-open="${esc(it.id)}">
      <span class="node">${icon(iconFor(it), { size: 15 })}</span>
      <span class="stop-time">${start ? esc(hasTime(it.start) ? fmtTime(start) : 'all day') : '—'}</span>
      <span class="stop-body">
        <span class="stop-title">${esc(it.title || 'Untitled')}</span>
        ${sub}
      </span>
      ${cost}
    </button>`;
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

  let html = '';
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

function editItem(existing) {
  const it = existing ? { ...existing } : blankItem(state.tripId);
  const isNew = !existing;
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

    <p class="sheet-section">When</p>
    <div class="field-pair">
      ${field('Date', 'startDate', datePart(it.start), { type: 'date' })}
      ${field('Time', 'startTime', timePart(it.start), { type: 'time' })}
    </div>
    <div class="field-pair">
      ${field('Arrives / ends', 'endDate', datePart(it.end), { type: 'date' })}
      ${field('Time', 'endTime', timePart(it.end), { type: 'time' })}
    </div>

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

(async function main() {
  init();
  await load();
  if (!location.hash) location.hash = '#/now';
  render();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
})();
