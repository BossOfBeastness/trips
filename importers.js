// Adapters that turn a dropped file into either exact fields or plain text.
// Text goes on to parse.js; exact sources skip the guessing entirely.
//
// pdf.js and tesseract.js are fetched on first use and then cached by the
// service worker, so the offline shell stays small and nobody who never imports
// pays for them.

import { parseBooking } from './parse.js';

const PDFJS_URL = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.6.82/build/pdf.min.mjs';
const PDFJS_WORKER = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.6.82/build/pdf.worker.min.mjs';
const TESSERACT_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.esm.min.js';

/* ------------------------------------------------------------------ .ics --- */

function unfold(text) {
  return text.replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, '');
}

function unescapeText(s) {
  return s.replace(/\\n/gi, '\n').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\');
}

// 20260911T120000 or 20260911T110000Z or 20260911
function icsDate(value, tzUtc) {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(value.trim());
  if (!m) return { date: '', time: '' };
  const date = `${m[1]}-${m[2]}-${m[3]}`;
  if (!m[4]) return { date, time: '' };
  if (m[7] || tzUtc) {
    // UTC stamp: shift into the phone's own zone so the times read correctly.
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], 0));
    const p2 = n => String(n).padStart(2, '0');
    return {
      date: `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`,
      time: `${p2(d.getHours())}:${p2(d.getMinutes())}`,
    };
  }
  return { date, time: `${m[4]}:${m[5]}` };
}

export function fromIcs(text) {
  const body = unfold(String(text));
  const block = body.split(/BEGIN:VEVENT/i)[1];
  if (!block) return null;

  const field = name => {
    const re = new RegExp(`^${name}([^:\\r\\n]*):(.*)$`, 'im');
    const m = re.exec(block);
    return m ? { params: m[1] || '', value: unescapeText(m[2].trim()) } : null;
  };

  const start = field('DTSTART');
  const end = field('DTEND');
  const summary = field('SUMMARY');
  const location = field('LOCATION');
  const description = field('DESCRIPTION');
  if (!start) return null;

  const s = icsDate(start.value, /UTC/i.test(start.params));
  const e = end ? icsDate(end.value, /UTC/i.test(end.params)) : { date: '', time: '' };

  // The summary and description still get pattern-matched, because that is
  // where an airline hides the flight number and reference.
  const guessed = parseBooking(
    [summary?.value, location?.value, description?.value].filter(Boolean).join('\n')
  ) || {};

  return {
    ...guessed,
    title: summary?.value || guessed.title || '',
    to: location?.value || guessed.to || '',
    startDate: s.date,
    startTime: s.time,
    endDate: e.date,
    endTime: e.time,
    notes: description?.value || '',
    confidence: 'high',
    source: 'calendar file',
  };
}

/* --------------------------------------------------------------- .pkpass --- */

// A .pkpass is a plain zip. Browsers can inflate raw deflate natively, so this
// needs no library — just enough of the zip central directory to find pass.json.
async function inflateRaw(bytes) {
  const ds = new DecompressionStream('deflate-raw');
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function readZipEntry(buf, wanted) {
  const dv = new DataView(buf);
  const bytes = new Uint8Array(buf);

  // Walk local file headers: signature 0x04034b50.
  for (let i = 0; i < bytes.length - 4; i++) {
    if (dv.getUint32(i, true) !== 0x04034b50) continue;
    const method = dv.getUint16(i + 8, true);
    const compSize = dv.getUint32(i + 18, true);
    const nameLen = dv.getUint16(i + 26, true);
    const extraLen = dv.getUint16(i + 28, true);
    const nameStart = i + 30;
    const name = new TextDecoder().decode(bytes.subarray(nameStart, nameStart + nameLen));
    if (name !== wanted) continue;

    const dataStart = nameStart + nameLen + extraLen;
    const data = bytes.subarray(dataStart, dataStart + compSize);
    if (compSize === 0) continue;                 // streamed entry, sizes in the trailer
    return method === 0 ? data : await inflateRaw(data);
  }
  return null;
}

export async function fromPkpass(file) {
  const raw = await readZipEntry(await file.arrayBuffer(), 'pass.json');
  if (!raw) return null;
  const pass = JSON.parse(new TextDecoder().decode(raw));

  const kindMap = { boardingPass: 'flight', eventTicket: 'activity', generic: 'other' };
  const style = Object.keys(kindMap).find(k => pass[k]) || 'generic';
  const body = pass[style] || {};
  const fields = [
    ...(body.primaryFields || []), ...(body.secondaryFields || []),
    ...(body.auxiliaryFields || []), ...(body.headerFields || []),
    ...(body.backFields || []),
  ];
  const byKey = k => fields.find(f => (f.key || '').toLowerCase().includes(k))?.value;

  let kind = kindMap[style];
  if (style === 'boardingPass' && body.transitType) {
    kind = { PKTransitTypeAir: 'flight', PKTransitTypeTrain: 'train',
             PKTransitTypeBus: 'bus', PKTransitTypeBoat: 'ferry' }[body.transitType] || kind;
  }

  const when = pass.relevantDate ? new Date(pass.relevantDate) : null;
  const p2 = n => String(n).padStart(2, '0');

  return {
    kind,
    title: [pass.organizationName, byKey('flight') || pass.description].filter(Boolean).join(' '),
    from: body.primaryFields?.[0]?.value || byKey('origin') || byKey('depart') || '',
    to: body.primaryFields?.[1]?.value || byKey('destination') || byKey('arriv') || '',
    seat: byKey('seat') || '',
    ref: pass.serialNumber?.length <= 10 ? pass.serialNumber : (byKey('confirmation') || byKey('pnr') || ''),
    provider: pass.organizationName || '',
    startDate: when ? `${when.getFullYear()}-${p2(when.getMonth() + 1)}-${p2(when.getDate())}` : '',
    startTime: when ? `${p2(when.getHours())}:${p2(when.getMinutes())}` : '',
    endDate: '', endTime: '', amount: '', currency: '',
    confidence: 'high',
    source: 'wallet pass',
  };
}

/* ------------------------------------------------------------------- PDF --- */

let pdfLib = null;
export async function pdfToText(file, onProgress) {
  if (!pdfLib) {
    onProgress?.('Fetching the PDF reader, one time only…');
    pdfLib = await import(/* @vite-ignore */ PDFJS_URL);
    pdfLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
  }
  onProgress?.('Reading the PDF…');
  const doc = await pdfLib.getDocument({ data: await file.arrayBuffer() }).promise;
  const pages = [];
  for (let i = 1; i <= Math.min(doc.numPages, 5); i++) {
    const content = await (await doc.getPage(i)).getTextContent();
    // Rebuild lines from item positions; pdf.js hands back fragments, not lines.
    const rows = new Map();
    for (const item of content.items) {
      const y = Math.round(item.transform[5]);
      if (!rows.has(y)) rows.set(y, []);
      rows.get(y).push({ x: item.transform[4], s: item.str });
    }
    const lines = [...rows.entries()]
      .sort((a, b) => b[0] - a[0])
      .map(([, parts]) => parts.sort((a, b) => a.x - b.x).map(p => p.s).join(' ').trim())
      .filter(Boolean);
    pages.push(lines.join('\n'));
  }
  return pages.join('\n');
}

/* ------------------------------------------------------------------- OCR --- */

let tesseract = null;
export async function imageToText(file, onProgress) {
  if (!tesseract) {
    onProgress?.('Fetching the text reader, one time only…');
    tesseract = await import(/* @vite-ignore */ TESSERACT_URL);
  }
  onProgress?.('Reading the picture…');
  const worker = await tesseract.createWorker('eng', 1, {
    logger: m => m.status === 'recognizing text'
      && onProgress?.(`Reading the picture… ${Math.round(m.progress * 100)}%`),
  });
  try {
    const { data } = await worker.recognize(file);
    return data.text || '';
  } finally {
    await worker.terminate();
  }
}

/* ------------------------------------------------------------- dispatch --- */

export async function importFileToFields(file, onProgress) {
  const name = (file.name || '').toLowerCase();
  const type = file.type || '';

  if (name.endsWith('.ics') || type.includes('calendar')) {
    const fields = fromIcs(await file.text());
    if (fields) return fields;
    throw new Error('That calendar file has no event in it.');
  }

  if (name.endsWith('.pkpass') || type.includes('pkpass')) {
    const fields = await fromPkpass(file);
    if (fields) return fields;
    throw new Error('That wallet pass could not be read.');
  }

  if (name.endsWith('.pdf') || type === 'application/pdf') {
    const text = await pdfToText(file, onProgress);
    if (!text.trim()) throw new Error('That PDF has no text in it — it is probably a scan. Try a screenshot instead.');
    return { ...parseBooking(text), source: 'PDF' };
  }

  if (type.startsWith('image/')) {
    const text = await imageToText(file, onProgress);
    if (!text.trim()) throw new Error('No text could be read from that picture.');
    return { ...parseBooking(text), source: 'picture', confidence: 'low' };
  }

  const text = await file.text();
  if (!text.trim()) throw new Error('That file is empty.');
  return { ...parseBooking(text), source: 'file' };
}
