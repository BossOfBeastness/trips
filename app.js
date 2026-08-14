import { db, uid } from './db.js';
import {
  TRANSPORT_MODES, ITEM_TYPES, PAY_STATUS, PAY_METHOD,
  blankItem, leadFor, parseLocal, leaveByDate, groupByDay, sortItems,
  nextUp, cashPlan, itemsNeedingCash, fmtMoney, fmtTime, fmtDayLong,
  relative, dayDiff,
} from './model.js';
import { buildIcs } from './ics.js';

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
  toast._t = setTimeout(() => { t.hidden = true; }, 2600);
}

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

function trip() {
  return state.trips.find(t => t.id === state.tripId) || null;
}

function filesFor(itemId) {
  return state.files.filter(f => f.itemId === itemId);
}

async function saveItem(item) {
  if (!item.id) item.id = uid();
  item.updatedAt = Date.now();   // drives SEQUENCE so a re-imported .ics supersedes the old event
  await db.put('items', item);
  await load();
  render();
}

async function deleteItem(id) {
  if (!confirm('Delete this item? This cannot be undone.')) return;
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
  $('#tripName').textContent = t ? t.name : 'No trip yet';
  const route = (location.hash || '#/now').slice(2) || 'now';
  document.querySelectorAll('#tabs a').forEach(a => {
    a.classList.toggle('on', a.dataset.tab === route);
  });

  if (!t && route !== 'more') {
    view.innerHTML = emptyState();
    view.querySelector('[data-new-trip]')?.addEventListener('click', () => editTrip(null));
    return;
  }

  const views = { now: viewNow, plan: viewPlan, cash: viewCash, bookings: viewBookings, more: viewMore };
  (views[route] || viewNow)();
}

function emptyState() {
  return `
    <div class="empty">
      <div class="empty-glyph">🧭</div>
      <h2>No trips yet</h2>
      <p>Add a trip, then start dropping in flights, pickups and bookings as you plan them.</p>
      <button class="btn primary" data-new-trip>Create a trip</button>
    </div>`;
}

/* ------------------------------------------------------------- view: now --- */

function viewNow() {
  const now = new Date();
  const t = trip();
  const items = state.items;
  const next = nextUp(items, now);
  const tripStart = parseLocal(t.start);

  let html = '';

  if (tripStart && tripStart > now) {
    const d = dayDiff(tripStart, now);
    html += `<div class="countdown-strip">${d === 0 ? 'Leaving today' : `${d} day${d === 1 ? '' : 's'} until ${esc(t.name)}`}</div>`;
  }

  if (next) {
    html += heroCard(next, now);
  } else {
    html += `<div class="card muted-card"><p>Nothing scheduled ahead. Everything on this trip is in the past.</p></div>`;
  }

  // The rest of today + tomorrow, so you can glance at the shape of the day.
  const soon = sortItems(items).filter(it => {
    if (it === next) return false;
    const s = parseLocal(it.start);
    if (!s) return false;
    const dd = dayDiff(s, now);
    return s >= now && dd <= 1;
  });

  if (soon.length) {
    html += `<h3 class="section">Then</h3><div class="list">${soon.map(it => itemRow(it, now)).join('')}</div>`;
  }

  const cash = cashPlan(items).filter(c => c.firstNeeded && dayDiff(c.firstNeeded, now) <= 2);
  if (cash.length) {
    html += `<h3 class="section">Cash you need soon</h3>`;
    html += `<div class="list">` + cash.map(c => `
      <a class="row cash-row" href="#/cash">
        <div class="row-main">
          <div class="row-title">${esc(c.currency)} in hand</div>
          <div class="row-sub">${c.items.length} place${c.items.length === 1 ? '' : 's'} · first on ${esc(fmtDayLong(c.firstNeeded))}</div>
        </div>
        <div class="row-right"><strong>${esc(fmtMoney(c.certain + c.maybe, c.currency))}</strong></div>
      </a>`).join('') + `</div>`;
  }

  view.innerHTML = html;
  wireRows();
}

function heroCard(it, now) {
  const start = parseLocal(it.start);
  const leave = leaveByDate(it);
  const meta = ITEM_TYPES[it.type] || ITEM_TYPES.other;
  const icon = it.type === 'transport' ? (TRANSPORT_MODES[it.mode]?.icon || meta.icon) : meta.icon;
  const overdue = leave && leave < now;

  let leaveBlock = '';
  if (leave) {
    leaveBlock = `
      <div class="leave ${overdue ? 'urgent' : ''}">
        <div class="leave-label">${overdue ? 'Should have left' : 'Leave by'}</div>
        <div class="leave-time">${esc(fmtTime(leave))}</div>
        <div class="leave-rel">${esc(relative(leave, now))} · ${leadFor(it)} min before</div>
      </div>`;
  }

  const route = [it.from, it.to].filter(Boolean).map(esc).join(' <span class="arrow">→</span> ');
  const bits = [];
  if (it.provider) bits.push(esc(it.provider));
  if (it.ref) bits.push(`<span class="ref">${esc(it.ref)}</span>`);
  if (it.seat) bits.push(esc(it.seat));

  const payBadge = paymentBadge(it);

  return `
    <div class="card hero" data-edit="${esc(it.id)}">
      <div class="hero-top">
        <span class="hero-icon">${icon}</span>
        <div>
          <div class="hero-when">${esc(fmtDayLong(start))} · ${esc(fmtTime(start))}</div>
          <div class="hero-title">${esc(it.title || meta.label)}</div>
          ${route ? `<div class="hero-route">${route}</div>` : ''}
        </div>
      </div>
      ${leaveBlock}
      ${bits.length ? `<div class="hero-bits">${bits.join(' · ')}</div>` : ''}
      ${payBadge}
      ${it.notes ? `<div class="hero-notes">${esc(it.notes)}</div>` : ''}
      <div class="hero-countdown">${esc(relative(start, now))}</div>
    </div>`;
}

function paymentBadge(it) {
  const st = PAY_STATUS[it.payStatus];
  if (!st) return '';
  if (it.settledAt) return `<div class="pay-badge done">Paid ✓</div>`;
  if (!st.needsMoney) return '';
  const cashy = it.payMethod === 'cash';
  const amt = it.amount ? fmtMoney(it.amount, it.currency) : 'amount unknown';
  return `<div class="pay-badge ${cashy ? 'cash' : ''}">${cashy ? '💵 Cash needed' : '💳 Pay on arrival'} · ${esc(amt)}</div>`;
}

/* ------------------------------------------------------------ view: plan --- */

function viewPlan() {
  const now = new Date();
  const groups = groupByDay(state.items);
  if (!groups.size) {
    view.innerHTML = `<div class="empty"><div class="empty-glyph">🗓</div><h2>Nothing planned</h2>
      <p>Tap ＋ to add your first flight, pickup or booking.</p></div>`;
    return;
  }
  let html = '';
  for (const [key, items] of groups) {
    const d = key === 'unscheduled' ? null : parseLocal(key);
    const isToday = d && dayDiff(d, now) === 0;
    html += `<h3 class="section ${isToday ? 'today' : ''}">${d ? esc(fmtDayLong(d)) : 'No date yet'}${isToday ? ' <span class="pill">today</span>' : ''}</h3>`;
    html += `<div class="list">${items.map(it => itemRow(it, now)).join('')}</div>`;
  }
  view.innerHTML = html;
  wireRows();
}

function itemRow(it, now) {
  const start = parseLocal(it.start);
  const meta = ITEM_TYPES[it.type] || ITEM_TYPES.other;
  const icon = it.type === 'transport' ? (TRANSPORT_MODES[it.mode]?.icon || meta.icon) : meta.icon;
  const leave = leaveByDate(it);
  const past = start && start < now;
  const route = [it.from, it.to].filter(Boolean).map(esc).join(' → ');
  const sub = [route, it.provider && esc(it.provider), it.ref && esc(it.ref)].filter(Boolean).join(' · ');
  const cashy = !it.settledAt && PAY_STATUS[it.payStatus]?.needsMoney && (it.payMethod === 'cash' || it.payMethod === 'either');
  const nFiles = filesFor(it.id).length;

  return `
    <button class="row ${past ? 'past' : ''}" data-edit="${esc(it.id)}">
      <div class="row-time">${start ? esc(fmtTime(start)) : '—'}</div>
      <div class="row-main">
        <div class="row-title">${icon} ${esc(it.title || meta.label)}</div>
        ${sub ? `<div class="row-sub">${sub}</div>` : ''}
        ${leave ? `<div class="row-leave">leave ${esc(fmtTime(leave))}</div>` : ''}
      </div>
      <div class="row-right">
        ${cashy ? `<span class="tag cash">${it.payMethod === 'cash' ? '💵' : '💳'} ${esc(it.amount ? fmtMoney(it.amount, it.currency) : '?')}</span>` : ''}
        ${nFiles ? `<span class="tag">📎${nFiles}</span>` : ''}
      </div>
    </button>`;
}

/* ------------------------------------------------------------ view: cash --- */

function viewCash() {
  const plan = cashPlan(state.items);
  const settled = state.items.filter(it => it.settledAt);

  if (!plan.length && !settled.length) {
    view.innerHTML = `<div class="empty"><div class="empty-glyph">💷</div><h2>No cash owed</h2>
      <p>Mark a booking as “Pay at the place” with a cash method and it shows up here.</p></div>`;
    return;
  }

  let html = '';
  for (const c of plan) {
    html += `
      <div class="card cash-card">
        <div class="cash-head">
          <div>
            <div class="cash-cur">${esc(c.currency)}</div>
            ${c.firstNeeded ? `<div class="cash-when">first needed ${esc(fmtDayLong(c.firstNeeded))}</div>` : ''}
          </div>
          <div class="cash-total">
            <strong>${esc(fmtMoney(c.certain, c.currency))}</strong>
            <span>cash only</span>
          </div>
        </div>
        ${c.maybe ? `<div class="cash-maybe">+ ${esc(fmtMoney(c.maybe, c.currency))} that could go on card</div>` : ''}
        <div class="cash-items">
          ${c.items.map(it => {
            const d = parseLocal(it.start);
            return `<div class="cash-item">
              <label class="tick"><input type="checkbox" data-settle="${esc(it.id)}"><span></span></label>
              <button class="cash-item-main" data-edit="${esc(it.id)}">
                <div class="row-title">${esc(it.title || 'Untitled')}</div>
                <div class="row-sub">${d ? esc(fmtDayLong(d)) : 'no date'} · ${esc(PAY_METHOD[it.payMethod]?.label || '')}</div>
              </button>
              <div class="cash-amt">${esc(it.amount ? fmtMoney(it.amount, it.currency) : '?')}</div>
            </div>`;
          }).join('')}
        </div>
      </div>`;
  }

  if (settled.length) {
    html += `<h3 class="section">Settled</h3><div class="list">` + settled.map(it => `
      <div class="row settled">
        <div class="row-main">
          <div class="row-title">${esc(it.title || 'Untitled')}</div>
          <div class="row-sub">${esc(it.amount ? fmtMoney(it.amount, it.currency) : '')}</div>
        </div>
        <button class="link" data-unsettle="${esc(it.id)}">undo</button>
      </div>`).join('') + `</div>`;
  }

  view.innerHTML = html;
  wireRows();

  view.querySelectorAll('[data-settle]').forEach(el => {
    el.addEventListener('change', async () => {
      const it = state.items.find(x => x.id === el.dataset.settle);
      it.settledAt = Date.now();
      await saveItem(it);
      toast('Marked as paid');
    });
  });
  view.querySelectorAll('[data-unsettle]').forEach(el => {
    el.addEventListener('click', async () => {
      const it = state.items.find(x => x.id === el.dataset.unsettle);
      it.settledAt = null;
      await saveItem(it);
    });
  });
}

/* -------------------------------------------------------- view: bookings --- */

function viewBookings() {
  const q = state.query.toLowerCase();
  const withRefs = sortItems(state.items).filter(it =>
    it.ref || it.provider || filesFor(it.id).length
  ).filter(it => !q || JSON.stringify(it).toLowerCase().includes(q));

  let html = `<div class="search"><input type="search" id="q" placeholder="Search refs, places, notes" value="${esc(state.query)}"></div>`;

  if (!withRefs.length) {
    html += `<div class="empty"><div class="empty-glyph">🎟</div><h2>No confirmations</h2>
      <p>Add a booking reference or attach a PDF to an item and it lands here.</p></div>`;
  } else {
    html += `<div class="list">` + withRefs.map(it => {
      const d = parseLocal(it.start);
      const files = filesFor(it.id);
      return `<div class="row booking">
        <div class="row-main">
          <div class="row-title">${esc(it.title || 'Untitled')}</div>
          <div class="row-sub">${[d && fmtDayLong(d), it.provider].filter(Boolean).map(esc).join(' · ')}</div>
          ${it.ref ? `<div class="bigref" data-copy="${esc(it.ref)}">${esc(it.ref)} <span class="copy">copy</span></div>` : ''}
          ${files.length ? `<div class="files">${files.map(f =>
            `<button class="file-chip" data-file="${esc(f.id)}">📄 ${esc(f.name)}</button>`).join('')}</div>` : ''}
        </div>
        <button class="link" data-edit="${esc(it.id)}">edit</button>
      </div>`;
    }).join('') + `</div>`;
  }

  view.innerHTML = html;
  wireRows();

  const q0 = $('#q');
  q0.addEventListener('input', () => {
    state.query = q0.value;
    const pos = q0.selectionStart;
    viewBookings();
    const q1 = $('#q');
    q1.focus();
    q1.setSelectionRange(pos, pos);
  });

  view.querySelectorAll('[data-copy]').forEach(el => {
    el.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(el.dataset.copy); toast('Reference copied'); }
      catch { toast('Copy failed — long-press to select'); }
    });
  });
  view.querySelectorAll('[data-file]').forEach(el => {
    el.addEventListener('click', () => openFile(el.dataset.file));
  });
}

function openFile(id) {
  const f = state.files.find(x => x.id === id);
  if (!f) return;
  const url = URL.createObjectURL(f.blob);
  window.open(url, '_blank');
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

/* ------------------------------------------------------------ view: more --- */

function viewMore() {
  const t = trip();
  let html = `<h3 class="section">Trips</h3><div class="list">`;
  for (const tr of state.trips) {
    html += `<div class="row ${tr.id === state.tripId ? 'on' : ''}">
      <button class="row-main" data-pick-trip="${esc(tr.id)}">
        <div class="row-title">${esc(tr.name)}</div>
        <div class="row-sub">${[tr.start, tr.end].filter(Boolean).map(esc).join(' → ') || 'no dates'}</div>
      </button>
      <button class="link" data-edit-trip="${esc(tr.id)}">edit</button>
    </div>`;
  }
  html += `</div><button class="btn" data-new-trip>＋ New trip</button>`;

  const bytes = state.files.reduce((a, f) => a + (f.size || 0), 0);
  html += `
    <h3 class="section">Backup &amp; sharing</h3>
    <div class="card">
      <p class="hint">No signal needed. Export writes one file with every trip, item and attachment. AirDrop it to your partner, then they use Import.</p>
      <div class="btn-row">
        <button class="btn" id="exportBtn">Export file</button>
        <button class="btn" id="importBtn">Import file</button>
      </div>
      <input type="file" id="importInput" accept=".json,application/json" hidden>
      <p class="hint small">${state.files.length} attachment${state.files.length === 1 ? '' : 's'} · ${(bytes / 1048576).toFixed(1)} MB stored on this phone.</p>
      <p class="hint small" id="quota"></p>
    </div>

    <h3 class="section">Phone reminders</h3>
    <div class="card">
      <p class="hint">This app cannot buzz you on its own. The phone's Calendar can. Send the trip across and iOS handles the alarms itself — offline, app closed.</p>
      <p class="hint small">You get a nudge at each <strong>leave by</strong> time, at every departure, at check in and check out, and the evening before you first need cash.</p>
      <button class="btn" id="icsBtn">Send trip to Calendar</button>
      <p class="hint small">Import it into a calendar of its own (Calendar → Add Calendar) so you can delete the lot in one go when the plan changes.</p>
    </div>

    <h3 class="section">Keeping it installed</h3>
    <div class="card">
      <p class="hint">Open in Safari → Share → <strong>Add to Home Screen</strong>. Launch it from the icon, not the browser, or iOS may clear the data.</p>
      <p class="hint">iOS can wipe web storage if the app sits unused for weeks. Export a backup before every trip.</p>
    </div>

    <div class="card danger-card">
      <button class="btn danger" id="wipeBtn">Erase everything on this phone</button>
    </div>`;

  view.innerHTML = html;

  view.querySelectorAll('[data-pick-trip]').forEach(el => el.addEventListener('click', async () => {
    await db.metaSet('activeTrip', el.dataset.pickTrip);
    await load();
    location.hash = '#/now';
    render();
  }));
  view.querySelectorAll('[data-edit-trip]').forEach(el => el.addEventListener('click', () => {
    editTrip(state.trips.find(x => x.id === el.dataset.editTrip));
  }));
  view.querySelector('[data-new-trip]').addEventListener('click', () => editTrip(null));
  showQuota();
  $('#icsBtn').addEventListener('click', exportIcs);
  $('#exportBtn').addEventListener('click', exportAll);
  $('#importBtn').addEventListener('click', () => $('#importInput').click());
  $('#importInput').addEventListener('change', e => importFile(e.target.files[0]));
  $('#wipeBtn').addEventListener('click', async () => {
    if (!confirm('This erases every trip, item and attachment stored on this phone. Export a backup first. Continue?')) return;
    if (!confirm('Really erase everything? This cannot be undone.')) return;
    await db.clearAll();
    await load();
    render();
    toast('Erased');
  });
  if (!t) view.querySelectorAll('.row.on').forEach(el => el.classList.remove('on'));
}

// Worth surfacing: the browser decides how much room this app gets, and
// whether it survives being unused. Both matter once photos go in here.
async function showQuota() {
  const el = $('#quota');
  if (!el || !navigator.storage?.estimate) return;
  try {
    const { usage = 0, quota = 0 } = await navigator.storage.estimate();
    const persisted = navigator.storage.persisted ? await navigator.storage.persisted() : false;
    el.textContent = `Browser allowance: ${(usage / 1048576).toFixed(1)} MB used of ${(quota / 1073741824).toFixed(2)} GB · `
      + (persisted ? 'storage is marked persistent' : 'storage is NOT persistent — back up regularly');
  } catch { /* estimate unsupported; the attachment total above still shows */ }
}

/* ------------------------------------------------------- export / import --- */

function blobToDataUrl(blob) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = rej;
    r.readAsDataURL(blob);
  });
}

async function dataUrlToBlob(url) {
  return (await fetch(url)).blob();
}

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

async function exportIcs() {
  const t = trip();
  if (!t) { toast('No trip selected'); return; }
  const dated = state.items.filter(it => it.start);
  if (!dated.length) { toast('Nothing with a date yet'); return; }
  const slug = (t.name || 'trip').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'trip';
  await shareOrDownload(
    new Blob([buildIcs(t, state.items)], { type: 'text/calendar' }),
    `${slug}.ics`,
    t.name
  );
}

// The share sheet is the useful path on iOS: it reaches Calendar, Files and
// AirDrop. A plain download link is the desktop fallback.
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
  try {
    payload = JSON.parse(await file.text());
  } catch {
    toast('That file is not a Trips backup');
    return;
  }
  if (payload.format !== 'trips-export') {
    toast('That file is not a Trips backup');
    return;
  }
  const counts = { trips: payload.trips?.length || 0, items: payload.items?.length || 0 };
  if (!confirm(`Merge ${counts.trips} trip(s) and ${counts.items} item(s) from this file? Anything with the same id is overwritten by the incoming copy.`)) return;

  await db.putMany('trips', payload.trips || []);
  await db.putMany('items', payload.items || []);
  // Land on what was just imported, rather than silently falling back to the
  // earliest trip and looking like the import did nothing.
  if (payload.trips?.length) await db.metaSet('activeTrip', payload.trips[0].id);
  for (const f of payload.files || []) {
    await db.put('files', { id: f.id, itemId: f.itemId, name: f.name, type: f.type, size: f.size, blob: await dataUrlToBlob(f.data) });
  }
  await load();
  render();
  toast('Imported');
}

/* ----------------------------------------------------------- edit sheets --- */

function openSheet(title, bodyHtml, onSave) {
  $('#sheetTitle').textContent = title;
  $('#sheetBody').innerHTML = bodyHtml;
  $('#sheet').hidden = false;
  document.body.classList.add('locked');
  $('#sheetSave').onclick = onSave;
}

function closeSheet() {
  $('#sheet').hidden = true;
  document.body.classList.remove('locked');
}

function field(label, name, value, opts = {}) {
  const type = opts.type || 'text';
  return `<label class="field ${opts.cls || ''}">
    <span>${esc(label)}</span>
    <input name="${name}" type="${type}" value="${esc(value ?? '')}" ${opts.placeholder ? `placeholder="${esc(opts.placeholder)}"` : ''} ${opts.attrs || ''}>
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

function editTrip(tr) {
  const t = tr || { id: null, name: '', start: '', end: '' };
  openSheet(tr ? 'Edit trip' : 'New trip', `
    ${field('Trip name', 'name', t.name, { placeholder: 'Lisbon, October' })}
    ${field('First day', 'start', t.start, { type: 'date' })}
    ${field('Last day', 'end', t.end, { type: 'date' })}
    ${tr ? `<button class="btn danger" id="delTrip">Delete trip</button>` : ''}
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
    if (!confirm(`Delete "${t.name}" and every item in it? This cannot be undone.`)) return;
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

function editItem(existing) {
  const it = existing ? { ...existing } : blankItem(state.tripId);
  const isNew = !existing;
  const modeDefault = TRANSPORT_MODES[it.mode]?.lead ?? 0;

  const html = `
    ${select('Kind', 'type', it.type, ITEM_TYPES)}
    ${field('What is it', 'title', it.title, { placeholder: 'BA2551 to Faro' })}

    <div data-only="transport">
      ${select('Mode', 'mode', it.mode, TRANSPORT_MODES)}
      ${field('From', 'from', it.from, { placeholder: 'Gatwick' })}
      ${field('To', 'to', it.to, { placeholder: 'Faro' })}
      ${field('Seat / vehicle', 'seat', it.seat, { placeholder: '14A' })}
    </div>

    ${field('Starts', 'start', it.start, { type: 'datetime-local' })}
    ${field('Ends (optional)', 'end', it.end, { type: 'datetime-local' })}
    ${field('Leave this many minutes early', 'leadMinutes', it.leadMinutes ?? '', {
      type: 'number', placeholder: `default ${modeDefault} min`, attrs: 'min="0" step="5"' })}

    <h4 class="sheet-section">Booking</h4>
    ${field('Provider', 'provider', it.provider, { placeholder: 'Europcar' })}
    ${field('Reference', 'ref', it.ref, { placeholder: 'XK9P2T' })}

    <h4 class="sheet-section">Money</h4>
    ${select('Payment', 'payStatus', it.payStatus, PAY_STATUS)}
    ${select('Method', 'payMethod', it.payMethod, PAY_METHOD)}
    <div class="field-row">
      ${field('Amount', 'amount', it.amount, { type: 'number', attrs: 'step="0.01" min="0"' })}
      ${field('Currency', 'currency', it.currency, { placeholder: 'EUR', attrs: 'maxlength="3" autocapitalize="characters"' })}
    </div>

    <h4 class="sheet-section">Notes</h4>
    <label class="field"><span>Anything else</span>
      <textarea name="notes" rows="3" placeholder="Key safe code, meeting point, who to ask for">${esc(it.notes)}</textarea>
    </label>

    <h4 class="sheet-section">Attachments</h4>
    <div id="fileList" class="file-list"></div>
    <label class="btn file-add">
      Attach a photo or PDF
      <input type="file" id="fileInput" accept="image/*,application/pdf" multiple hidden>
    </label>
    <p class="hint small">Stored on this phone, opens with no signal.</p>

    ${isNew ? '' : `<button class="btn danger" id="delItem">Delete item</button>`}
  `;

  openSheet(isNew ? 'New item' : 'Edit item', html, async () => {
    const f = new FormData(formEl());
    const next = {
      ...it,
      id: it.id,
      tripId: state.tripId,
      type: f.get('type'),
      title: (f.get('title') || '').trim(),
      mode: f.get('mode'),
      from: (f.get('from') || '').trim(),
      to: (f.get('to') || '').trim(),
      seat: (f.get('seat') || '').trim(),
      start: f.get('start') || '',
      end: f.get('end') || '',
      leadMinutes: f.get('leadMinutes') === '' ? null : Number(f.get('leadMinutes')),
      provider: (f.get('provider') || '').trim(),
      ref: (f.get('ref') || '').trim().toUpperCase(),
      payStatus: f.get('payStatus'),
      payMethod: f.get('payMethod'),
      amount: f.get('amount') || '',
      currency: (f.get('currency') || '').trim().toUpperCase(),
      notes: (f.get('notes') || '').trim(),
    };
    if (!next.title && !next.ref) { toast('Give it a title'); return; }
    if (!next.id) next.id = uid();

    // Attachments picked before the item existed were parked under a temp id.
    for (const pending of pendingFiles) {
      await db.put('files', { ...pending, itemId: next.id });
    }
    pendingFiles.length = 0;

    closeSheet();
    await saveItem(next);
    toast('Saved');
  });

  const pendingFiles = [];
  const refreshFiles = () => {
    const existingFiles = it.id ? filesFor(it.id) : [];
    const all = [...existingFiles, ...pendingFiles];
    $('#fileList').innerHTML = all.length
      ? all.map(f => `<div class="file-chip-row">
          <button type="button" class="file-chip" data-open="${esc(f.id)}">📄 ${esc(f.name)}</button>
          <button type="button" class="link danger" data-rm="${esc(f.id)}">remove</button>
        </div>`).join('')
      : `<p class="hint small">Nothing attached.</p>`;

    $('#fileList').querySelectorAll('[data-open]').forEach(el => el.addEventListener('click', () => {
      const f = all.find(x => x.id === el.dataset.open);
      const url = URL.createObjectURL(f.blob);
      window.open(url, '_blank');
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    }));
    $('#fileList').querySelectorAll('[data-rm]').forEach(el => el.addEventListener('click', async () => {
      const id = el.dataset.rm;
      const idx = pendingFiles.findIndex(x => x.id === id);
      if (idx >= 0) pendingFiles.splice(idx, 1);
      else { await db.del('files', id); state.files = await db.all('files'); }
      refreshFiles();
    }));
  };
  refreshFiles();

  $('#fileInput').addEventListener('change', async e => {
    for (const file of e.target.files) {
      pendingFiles.push({ id: uid(), itemId: it.id, name: file.name, type: file.type, size: file.size, blob: file });
    }
    e.target.value = '';
    refreshFiles();
  });

  const syncTypeFields = () => {
    const type = formEl().querySelector('[name=type]').value;
    $('#sheetBody').querySelectorAll('[data-only]').forEach(el => {
      el.style.display = el.dataset.only === type ? '' : 'none';
    });
  };
  formEl().querySelector('[name=type]').addEventListener('change', syncTypeFields);
  syncTypeFields();

  $('#delItem')?.addEventListener('click', () => deleteItem(it.id));
}

/* ---------------------------------------------------------------- wiring --- */

function wireRows() {
  view.querySelectorAll('[data-edit]').forEach(el => {
    el.addEventListener('click', ev => {
      ev.preventDefault();
      const it = state.items.find(x => x.id === el.dataset.edit);
      if (it) editItem(it);
    });
  });
}

function init() {
  document.querySelectorAll('[data-close]').forEach(el => el.addEventListener('click', closeSheet));
  $('#addBtn').addEventListener('click', () => {
    if (!state.tripId) { editTrip(null); return; }
    editItem(null);
  });
  $('#tripBtn').addEventListener('click', () => { location.hash = '#/more'; });
  window.addEventListener('hashchange', render);

  // Keep the countdown honest without a full re-render storm.
  setInterval(() => {
    if ((location.hash || '#/now') === '#/now') render();
  }, 30000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) render(); });
}

(async function main() {
  init();
  await load();
  if (!location.hash) location.hash = '#/now';
  render();
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  if (navigator.storage && navigator.storage.persist) {
    navigator.storage.persist().catch(() => {});
  }
})();
