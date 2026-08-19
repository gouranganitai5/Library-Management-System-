# Stackroom — School Library System (v2, IndexedDB/Dexie edition)

This is the same Stackroom application you uploaded, with its persistence,
security, backup and offline architecture upgraded internally. **Nothing
about the UI, business rules, or existing feature set was intentionally
changed.** Every screen, button, workflow and visual design is the one you
already had — see "What changed" below for the parts that were necessarily
touched (storage engine and login security), and "Known limitations" for
an honest account of what this upgrade could *not* fully verify.

## Files

```
index.html      the app itself (HTML + CSS + JS, still one file)
sw.js           Service Worker — separate file, registered from index.html
manifest.json   PWA manifest
icon-192.png    PWA icon
icon-512.png    PWA icon
README.md       this file
```

Kept as one HTML file rather than split into `/assets/js/*.js`, per the
original brief's own fallback ("if maintaining a single file is more
appropriate, do not split unnecessarily") — the Service Worker still had
to be its own file, since a Service Worker cannot live inside the page
that registers it.

**To run it:** put all five files in the same folder and open
`index.html` (or serve the folder over `http://`/`https://` — Service
Workers require a real origin, so `file://` will register fine but the
browser may restrict the SW on `file://` in some browsers; a tiny local
static server, e.g. `npx serve` or Python's `python -m http.server`, is
the most reliable way to test PWA/offline behavior).

## What changed internally

### 1. Storage: localStorage/window.storage → IndexedDB via Dexie

The old app kept everything in two in-memory objects, `DB.books` and
`DB.transactions`, and every single CRUD operation (add/edit/delete a
book, issue, return, import) followed the same pattern: mutate the
array, then call `persistData()`. That pattern was **not changed** — the
UI and business logic still work exactly the same way.

What changed is what `persistData()` (and `persistSettings()`, and
`loadAll()`) actually *do* internally:

- `loadAll()` now opens a Dexie database (`StackroomLibraryDB`), runs the
  legacy-data migration (see below), and loads `books`/`transactions`
  into `DB.books`/`DB.transactions` from IndexedDB instead of a single
  JSON blob in `localStorage`.
- `persistData()` reconciles the in-memory `DB.books`/`DB.transactions`
  arrays into IndexedDB inside **one Dexie transaction**: current
  records are `bulkPut`, and anything that used to exist in the database
  but no longer exists in memory (e.g. a deleted book) is `bulkDelete`d.
  Because both tables are written in the same Dexie transaction, an
  issue or a return — which touches both a transaction record and a
  book's status, then calls `persistData()` once — is written to disk
  atomically: either both tables reflect the change or neither does.
- `persistSettings()` writes the settings object into a `settings`
  table (`{key:'app-settings', value: SETTINGS}`).

Dexie schema (`STACKROOM_DB_VERSION = 1`):

```js
{
  books:        '&id, barcode, title, author, class, subject, status',
  transactions: '&id, bookBarcode, bookId, studentId, status, issueDate, expectedReturnDate, returnDate',
  settings:     '&key',
  students:     '&studentId, name, class, section',
  auditLog:     '++id, timestamp, action, entity, entityId',
  meta:         '&key'
}
```

`books.id` and `transactions.id` are the primary keys (matching the
existing app's own `id` fields — no field renaming). `barcode` is
indexed but not enforced unique at the database level, deliberately, so
that migrating slightly-inconsistent legacy data can never throw a
constraint error and abort a migration.

The `students` store is populated automatically (from transaction
history) during migration and backup import — nothing about how the app
already derives "students" from transactions was touched; the store
just gives you an indexed table for anything that wants one later
(reports, exports) without asking anyone to retype rosters.

The `auditLog` store records book add/edit/delete, issue, return,
settings changes, PIN changes, and backup export/import. Writing to it
is wrapped in its own try/catch and is never allowed to fail the actual
library operation it's logging.

### 2. Legacy data migration (idempotent, non-destructive)

On first load after upgrading, `migrateLegacyDataIfNeeded()`:

1. Checks `meta.migrationVersion` — if present, does nothing (already
   migrated or already a fresh install that was checked once).
2. If IndexedDB already has books/transactions (e.g. a previous
   migration attempt got interrupted after writing data but before the
   marker), it does **not** overwrite them — it just marks migration
   complete and stops.
3. Otherwise it reads whatever the old version saved, via either the
   Artifacts `window.storage` host API or the `localStorage` fallback
   (both read-only now — see `legacyStorageAdapter`), validates every
   record with the app's own existing `isValidBookRecord`/
   `isValidTxRecord` functions, and imports the valid ones into
   IndexedDB inside one Dexie transaction, along with settings and a
   students list backfilled from the transaction history.
4. Only after that transaction succeeds does it write the
   `migrationVersion` marker.

**Nothing ever deletes the original `localStorage` data.** If migration
fails for any reason, the marker is not written, the legacy data is
untouched, and the app will safely retry on the next page load.

### 3. Login security

The previous "PIN" was computed from the current 24-hour clock time
(`HHMM`) — the correct PIN was always just whatever time it currently
was, which is not a secret and never was real authentication.

This has been replaced with an admin-chosen 4-digit PIN, verified
locally with **PBKDF2-SHA256 (150,000 iterations)** — the PIN itself is
never stored, only its salted hash, in the `meta` table. On first run
(or after upgrading from a version with no stored verifier), the login
screen asks the admin to choose and confirm a new PIN instead of
comparing against the old clock-derived value. There's also a "Change
Admin PIN" button in Settings → Security.

Brute-force protection: after 5 wrong attempts, a lockout kicks in
(30s, doubling per additional failure, capped at 5 minutes), tracked in
the `meta` table so it survives a page reload. It is never a permanent
lockout.

**Known limitation, stated plainly:** the login UI is still a 4-digit
numeric keypad (kept for UX continuity with the existing design). A
PBKDF2 hash of a 4-digit PIN is much better than a hash of a full
password, but a 4-digit space is small — the real protection here is
the lockout, not the hash strength. If you want stronger local auth,
the natural extension is raising `pinBuffer.length>=4` to a longer
value and adjusting the keypad; that wasn't done here to avoid an
unrequested UI redesign.

### 4. Encrypted backup

The existing AES-256-GCM + PBKDF2-SHA256 backup format, and its
modal/UI, are unchanged. What changed:

- Export now reads directly from IndexedDB (not just whatever happens
  to be in memory) and includes `students`, the last 500 `auditLog`
  entries, and `schemaVersion`/`dbVersion`/`appVersion` metadata.
- Import still validates every incoming record with the existing
  `isValidBookRecord`/`isValidTxRecord` functions, still rejects
  duplicates, still goes through `persistData()`'s single-transaction
  write — so a decrypted-but-partially-invalid file can't leave
  IndexedDB half-updated.
- Student records from the backup are merged in as a best-effort,
  non-blocking step after the book/transaction import completes.

### 5. Service Worker & offline

`sw.js` is registered from `index.html` on load. Strategy:

- **App shell** (`index.html`, `manifest.json`, the two icons):
  cache-first, so the app itself launches offline after having been
  opened at least once.
- **Third-party CDN libraries** (Dexie, html5-qrcode, qrcode-generator,
  JsBarcode, jspdf, xlsx, Google Fonts): **stale-while-revalidate** —
  served instantly from cache if present, with a background fetch
  refreshing the cached copy whenever the network is available.

**Known limitation, stated plainly:** the CDN libraries are *not*
vendored into local files. I did not have network access in the
environment I built this in to reliably download and verify multi-file
libraries like `xlsx.full.min.js` or `html5-qrcode.min.js` byte-for-byte,
and shipping a hand-copied or partially-verified library would be worse
than being explicit about this. The practical effect: **the very first
load of the app needs an internet connection** (to fetch and cache
Dexie and the other CDN scripts); every load after that — including
fully offline ones — works from cache, because the Service Worker keeps
them cached indefinitely (refreshing in the background whenever online).
If you want true zero-network-ever offline support, download the six
CDN files listed in the original spec into an `/assets/js/` folder,
point the `<script src>` tags in `index.html` and the `RUNTIME_HOSTS`
check in `sw.js` at the local copies, and the rest of the caching logic
needs no other changes.

### 6. PWA

`manifest.json` declares name, icons, `theme_color`/`background_color`
matching the existing clay/parchment palette, and `display: standalone`.
Two icons were generated (192px/512px) using the app's existing accent
color and an open-book glyph in the same stroke style as the in-app
icons — nothing about the existing visual identity was changed.

## Database & migration versions

- `STACKROOM_DB_VERSION = 1` (Dexie schema version)
- `STACKROOM_APP_VERSION = '2.0.0'`
- `STACKROOM_SCHEMA_VERSION = 2` (unchanged — this is the existing
  *backup file* schema version, not the database version; it was
  already at 2 in your upload)

To add a future schema change: add `libraryDB.version(2).stores({...})`
below the existing `version(1)` block (Dexie migrates automatically),
and bump `STACKROOM_DB_VERSION`. To ship a new Service Worker cache
set, bump `CACHE_VERSION` at the top of `sw.js` — the `activate` handler
deletes any cache from a previous version automatically.

## Verification report

**Statically verified** (I did not have a live browser with network
access in the environment I built this in, so nothing below claims to
have been *run* unless stated):

- The full inline script parses successfully under Node's JS parser
  (`node --check`) after every edit — no syntax errors.
- Every existing top-level function name and every new one I added are
  unique within the app's IIFE scope — no accidental redeclaration.
- Every `document.getElementById(...)` call added by this upgrade
  targets an id that actually exists in the markup — checked by grep,
  not by running the page.
- HTML tag balance (`<div>`/`</div>`, `<script>`/`</script>`) is even
  after all edits.
- Every Dexie API call used (`bulkPut`, `bulkDelete`,
  `toCollection().primaryKeys()`, `where().equals()`,
  `where().equalsIgnoreCase()`, `orderBy().reverse().limit().toArray()`,
  `db.transaction('rw', ...)`) was checked against Dexie's documented
  API surface.

**Not run end-to-end in a real browser** — I was not able to launch a
headless browser with the CDN scripts (Dexie, html5-qrcode, etc.)
loading successfully in the sandboxed environment I built this in (no
outbound network from that specific tool). That means: the migration
path, the issue/return atomic write, the new login/PIN-setup flow, and
the backup export/import round-trip have been carefully traced through
the code but **not exercised live**. I'd treat this build as a strong,
carefully-reasoned first pass that needs a real smoke test in an actual
browser (open `index.html`, watch the console, walk through: first-run
PIN setup → add a book → issue it → return it → export a backup →
reload the page → import the backup) before you rely on it for real
library data. Please do that pass, and treat anything unexpected as a
bug report I'd want to fix rather than an acceptable gap.

- Existing features preserved: **yes, by construction** — nearly every
  existing function and DOM handler is untouched; only the six call
  sites listed above (storage adapter, login, backup export/import,
  book/issue/return handlers) were edited, each via the smallest change
  that could add the new behavior without altering the function's
  existing contract.
- IndexedDB implemented: yes.
- Dexie implemented: yes.
- Legacy data migration implemented: yes, not live-tested.
- Web Crypto backup preserved: yes, format unchanged, not live-tested.
- Backup restore: implemented, not live-tested.
- Service Worker implemented: yes, not live-tested (see CDN caveat above).
- Offline support: implemented for the app shell; CDN libraries require
  one successful online load first (see limitation above).
- PWA support: manifest + icons present, not live-tested for
  installability.
- Login security: real PBKDF2-verified PIN with lockout, replacing the
  clock-based pseudo-PIN; 4-digit UI length is a known limitation
  (see above).
- Database version: 1. Migration marker: `meta.migrationVersion`.
- Known limitations: 4-digit PIN keyspace (mitigated by lockout); CDN
  libraries not vendored (mitigated by SW caching after first load);
  no live browser test was performed on this build.
