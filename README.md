# Trips

An offline itinerary for two people. Installable on an iPhone, works with no signal,
no App Store, no Apple developer fee, no backend.

Built as a plain PWA: no framework, no build step, no dependencies. Every file it
serves is one it ships.

## What it does

- **Now** — the next thing that matters, with a big *leave by* time worked back from
  the departure (150 min for a flight, 20 for a bus, and so on; overridable per item).
  Goes red once that time has passed.
- **Plan** — the whole trip, grouped by day.
- **Cash** — the point of the app. Anything marked *pay at the place* with a cash
  method is totalled per currency, so you know what to draw out before you go and
  what is still owed once you are there. Tick items off as you hand the money over.
- **Refs** — every booking reference and attached PDF/photo in one searchable list.
- **More** — trips, calendar export, backup/restore, storage status.

## Offline reminders

The app cannot wake itself up to nudge you; iOS Calendar can. **More → Send trip to
Calendar** writes an `.ics` and opens the share sheet, so it goes straight into
Calendar. Every alarm then fires on-device, offline, with this app closed:

| Alarm | When |
| --- | --- |
| Leave now | at the item's *leave by* time (150 min before a flight, 20 before a bus…) |
| Departure | at the departure itself |
| Check in / check out | an hour before each, for stays |
| Draw out cash | 18:00 the evening before you first need notes, per currency |

Stays split into check-in and check-out events rather than one multi-day block.
Times are written as floating local time, so they read the same wherever the phone
is. Import into a calendar of its own so an outdated plan can be deleted in one go —
re-importing after edits is more likely to duplicate events than replace them.

Attachments (boarding passes, booking PDFs, photos of a confirmation) are stored on
the phone and open with no signal.

## Running it locally

```
node tools/serve.js          # http://localhost:8123
node tools/test-model.mjs    # itinerary + cash logic
node tools/test-ics.mjs      # calendar export
node tools/make-icons.js     # regenerate icons
```

Service workers need a secure context. `localhost` counts; a LAN IP over plain HTTP
does not — so testing on the phone means deploying it.

## Getting it onto the phone

1. Deploy the folder anywhere that serves HTTPS. Free options: drag the folder onto
   [Netlify Drop](https://app.netlify.com/drop), or push to GitHub and turn on Pages.
2. Open the URL in **Safari** (not Chrome — only Safari can install to the home screen).
3. Share → **Add to Home Screen**.
4. Launch it from the icon. Data belongs to the installed app; opening it in the
   browser tab afterwards may show a separate, empty copy.

After the first load the service worker has cached everything, so it opens in
airplane mode.

## Sharing between two phones

There is no server, so there is no automatic sync. Two paths:

- **Same URL, both phones** — each phone keeps its own copy. Fine when one of you
  maintains the plan.
- **Export / Import** — More → Export writes a single `.json` holding every trip,
  item and attachment, and opens the iOS share sheet, so AirDrop works with no
  wifi or internet. The other phone uses Import. Same-id records are overwritten by
  the incoming copy, so the exporter wins.

Export is also the backup. iOS can evict a web app's storage if it goes unused for
a long stretch — the app asks for persistent storage and reports on the More screen
whether it got it, but export before every trip regardless.

## Layout

| File | Role |
| --- | --- |
| `index.html` | Shell: top bar, view container, tab bar, edit sheet |
| `app.js` | State, views, editors, export/import |
| `model.js` | Pure logic — lead times, cash totals, grouping, formatting |
| `ics.js` | RFC 5545 calendar builder, alarms included |
| `db.js` | IndexedDB wrapper (`trips`, `items`, `files`, `meta`) |
| `sw.js` | Cache-first service worker. **Bump `CACHE` when shipping changes.** |
| `tools/` | Dev-only: static server, tests, icon generator |

`model.js` holds anything that would ruin a trip if it were wrong, and
`tools/test-model.mjs` covers it.
