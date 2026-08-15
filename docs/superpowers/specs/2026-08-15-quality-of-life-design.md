# Trips — quality-of-life round

Design agreed 15 August 2026. Covers date entry, timeline rows, coverage checks,
money totals, small interaction fixes, and importing bookings.

## 1. Date and time entry

Replaces `datetime-local`, which is painful on a phone and refuses a date whose
time is unknown.

**Day strip.** Horizontally scrollable days from `trip.start - 2` to
`trip.end + 2`. Tap to select. A day already holding something carries a dot.
Two days of padding cover travel either side of the trip proper.

**Time chips.** `06:00 09:00 12:00 15:00 18:00 21:00`, plus:
- **Type it** — reveals a plain `type="time"` field
- **Not yet** — stores a date with no time

**Fallbacks.**
- Trip has no dates: 14 days from today.
- Date outside the window: an **Another date** chip revealing `type="date"`.

Storage is unchanged: `YYYY-MM-DD` or `YYYY-MM-DDTHH:mm`.

## 2. Timeline row

Departure over arrival in the time column, joined by a hairline connector, with
a warm `+1` / `+3` when the arrival lands on a later day. The offset is counted
in calendar days, not elapsed hours.

Cost keeps its own right-hand column, with a small `cash owed` label beneath it
when unpaid cash is due. No icon beside the amount — colour plus label is enough,
and the icon was what made it feel cramped.

Spine alignment is corrected: node centres and gap dashes sit on the line.

`arr` is removed. No abbreviations.

## 3. Coverage checks

One pure function, `coverageGaps(trip, items, dismissed)`, returns gaps of two
kinds:

- **`bed`** — a night between the first and last day not covered by a stay.
  A night spent on transport whose span crosses that night does not count as
  missing; you are not sleeping anywhere by choice.
- **`transit`** — the last placed item of one day is somewhere different from
  the first placed item of the next, with no transport between them.

Surfaced at three depths from that one result:

1. **Next** — one quiet line when anything is open.
2. **Plan** — a ribbon of two thin bars per day, travel above, bed below.
   Solid means covered, dashed means nothing.
3. **Timeline** — a dashed marker with `?` on the spine at the gap, tapping it
   opens a new item pre-filled for that day.

Every gap is dismissible per trip, stored as `dismissed: ["bed:2026-09-24"]` on
the trip record. Without this, camping and night buses nag forever.

## 4. Money

The **Cash** tab becomes **Money**:

- Trip total converted to GBP at the top, split paid versus still owed.
- Existing per-currency cash sections below, unchanged.

Rates are entered once in Settings, one line per currency, stored in `meta` as
`{ PEN: 4.7, USD: 1.27 }` meaning `1 GBP = n`. No live rates: the app is offline,
and asking for one number per currency beats inventing one. Amounts in a currency
with no rate are listed separately rather than silently dropped from the total.

## 5. Small interactions

- Plan scrolls to today when the trip is running.
- Swiping a row left reveals **Mark paid** for cash owed.
- A new item defaults to the day being viewed and the kind added last.

## 6. Importing a booking

Every source becomes text or fields; one parser handles the rest. Nothing saves
silently — an import always lands in the edit sheet for confirmation.

```
.ics     ─┐
.pkpass  ─┤
paste    ─┼──► parser ──► pre-filled edit sheet ──► user confirms
PDF      ─┤
image    ─┘
```

**Exact sources** (structured, high confidence):
- `.ics` — airline and hotel confirmation attachments. Already understood by the
  app, since it writes them.
- `.pkpass` — an Apple Wallet zip holding `pass.json`. Unzipped with the native
  `DecompressionStream`, no library.

**Text sources** (pattern matched, needs checking):
- Pasted text. iOS Live Text makes this the practical route for a photo.
- PDF, via `pdf.js`.
- Image, via `tesseract.js`. Best effort and labelled as such: photographs of
  tickets are its weakest input and will often need correcting.

`pdf.js` and `tesseract.js` are **lazy-loaded on first use and then cached**, so
the offline shell stays as small as it is today and neither is downloaded by
someone who never imports.

**Parser** recognises flight numbers (`BA2551`), airport codes, booking
references (six-character alphanumeric), dates in common formats, 24- and
12-hour times, and amounts with currency. Every field it fills is a guess
presented for confirmation, never a fact.

## Structure

| File | Holds |
|---|---|
| `model.js` | existing logic, plus trip totals and the day-offset helper |
| `coverage.js` | `coverageGaps` and its supporting predicates |
| `parse.js` | text to item fields |
| `importers.js` | `.ics`, `.pkpass`, PDF and image adapters |
| `app.js` | day strip, ribbon, gap markers, swipe, import sheet |
| `app.css` | strip, ribbon, markers, time column |

Logic that would ruin a trip if wrong — coverage, totals, parsing, day offsets —
lives in pure modules with tests, not in view code. That separation is what
caught the cash total reading `0.00` as "nothing owed" rather than "not known".

## Not doing

- Live exchange rates. Needs a network.
- Sending bookings to an LLM to parse. Better results, but it would send your
  itinerary to a third party and require a connection. Both are the opposite of
  what this app is.
