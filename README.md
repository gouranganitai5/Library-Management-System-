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

### 7. Secure admin PIN recovery (new)

A locally-generated **recovery code** lets the admin reset a forgotten
PIN without a server, without any master/backdoor code, and without
touching library data. It's a second, independent authentication
mechanism layered on top of the existing PIN — nothing about the PIN
login flow itself changed except the addition of a "Forgot PIN?" link.

**Generation & format.** `generateRecoveryCode()` builds a
`XXXX-XXXX-XXXX-XXXX` code entirely from `crypto.getRandomValues()`
over a 32-character alphabet that excludes visually-ambiguous
characters (`0/O`, `1/I/L`), giving ~80 bits of entropy. It is never
derived from the PIN, a timestamp, the school name, student data,
device info, or a counter, and never uses `Math.random()`.

**Storage.** The plaintext code is never written anywhere. Only a
PBKDF2-SHA256 verifier (150,000 iterations, its own random salt —
never the PIN's salt) is stored, in a new `meta` row keyed
`recoveryVerifier`, structurally identical in spirit to the existing
`authVerifier` row but completely separate:

```js
{ key:'recoveryVerifier', saltB64, iterations, hashB64, kdf:'PBKDF2-SHA256', version:1, createdAt }
```

**Setup / regeneration.** From Settings → Security, "Set Up Recovery
Code" (or "Regenerate Recovery Code" once one exists) first opens a
Confirm Admin PIN modal — regeneration is never allowed just because
the app is already open. On success, `initializeRecoveryCode()`
generates a fresh code + fresh salt and atomically replaces the
`recoveryVerifier` row in one Dexie transaction (old verifier and old
code are invalidated in the same write), then shows the code exactly
once in a modal that has no close button and requires an "I have
securely recorded my recovery code" checkbox before it can be
dismissed. The code is held only in a short-lived local variable
(`pendingRecoveryCode`) for the life of that modal and is cleared —
and the DOM text reset to placeholder dots — the instant it closes.

**Recovery flow.** "Forgot PIN?" on the login screen (visible only
once a PIN actually exists to recover) opens a two-stage modal: enter
the recovery code → `verifyRecoveryCode()` normalizes formatting
(case/spaces/hyphens only — never fuzzy-matches actual characters),
re-derives a verifier with the stored salt/iterations, and compares it
to the stored hash with `secureEqualBytes()`, a constant-time
byte-array comparison with no early exit. A correct code unlocks a
"choose a new 4-digit PIN" step; `resetPinWithRecovery()` then calls
the existing, unmodified `setAuthPin()` — which touches only the
`authVerifier` row — and nothing else. Books, transactions, students,
settings, and audit history are never read or written by this path.

**Rate limiting.** Recovery attempts have their own lockout, tracked in
`meta` rows separate from the PIN's own lockout (`recoveryFailCount`/
`recoveryLockUntil`): 5 wrong attempts → 30s, doubling per additional
failure, capped at 5 minutes, surviving reloads, never permanent. A
wrong code always shows the same generic "could not be verified"
message — it never reveals whether a recovery code exists, or any
stored salt/hash/iteration detail.

**Audit trail.** `recovery_code_initialized` / `recovery_code_regenerated`
/ `pin_reset_via_recovery` events are written through the existing
`writeAuditLog()` — same table, same non-fatal try/catch behavior as
every other audit event. None of these entries ever contain the
recovery code, the PIN, or any derived secret — only the action name,
entity, and a short human-readable description.

**Backup isolation.** `encryptBackupPayload()` was not changed and
still reads only `books`/`transactions`/`students`/`auditLog` — it
never reads the `meta` table at all, so the recovery verifier, salt,
and lockout state can never end up in an exported backup, encrypted or
otherwise.

**Service Worker isolation.** `sw.js` only ever intercepts `GET`
requests for the app shell and the CDN runtime hosts (see below) — it
has no knowledge of IndexedDB or of any recovery data, so there is
nothing new to isolate there beyond the existing cache-version bump.

### 8. One student, one active book (new business rule)

`activeIssueForStudent(studentId)` looks up any transaction with
`status==='issued'` whose (trimmed, case-normalized) `studentId`
matches — identity is always the Student ID, never the name, so two
students who happen to share a name are never conflated, and a
student's own ID is never rewritten. Returned/historical transactions
never count and are never touched or deleted.

The rule is enforced at **two** points, matching requirement 31 (never
rely on the UI alone):
1. An early warning when moving from student details to the book scan
   step ("Continue to book scan").
2. The **mandatory, final** re-check inside the `issueConfirmBtn`
   handler, immediately before the transaction object is built and
   pushed — this is what actually prevents a second active loan, even
   if the first check passed and something changed in between (another
   tab, a duplicate click, etc). This re-check reads the same
   `DB.transactions` snapshot that the existing atomic `persistData()`
   Dexie write already commits from, so no new race window is
   introduced.

### 9. QR camera scanner reliability fix

Root cause: the previous camera scan configuration used a **fixed
pixel `qrbox`** (`{width:220, height:130}`). `html5-qrcode` can't scan
a region larger than the actual rendered video — on any phone or
container narrower than ~220px (common in this app's own fluid
`width:100%` scanner frame, especially in portrait mobile layouts),
the requested scan box didn't fit inside the video and detection
silently failed or never engaged.

Fix: `qrbox` is now a function that sizes the scan region as a
percentage of whichever viewfinder dimension is smaller, so it always
fits inside the actual video regardless of screen size or orientation.
Alongside that:

- `formatsToSupport` is restricted to `Html5QrcodeSupportedFormats.QR_CODE`
  (camera path and image-upload path) — this app only ever
  generates/expects QR codes via scanning, and narrowing the format
  search space also reduces per-frame decode work.
- A `scanProcessed` guard ignores any decode callback after the first
  one in a given scan session, so a QR code still in frame while
  `stop()` is asynchronously tearing down the camera can never fire
  the issue/return/add-book workflow twice from one physical scan.
- A `scannerStarting` guard prevents a second `start()` from
  overlapping a first one still in flight (e.g. a fast double-tap on
  "Start Camera"), which could previously race two `Html5Qrcode`
  instances against the same camera/DOM node.
- Manual barcode entry, QR image upload, QR generation (single and
  bulk), and every existing scanner-toggle/placeholder/cleanup call
  site are unchanged.

### 10. Recovery-code input bug fix (root cause)

The "Forgot PIN?" flow was opening a modal that was effectively
unusable. Root cause was two separate bugs stacked on top of each
other, both now fixed:

1. **Z-index stacking.** `#loginScreen` (the full-screen login card) has
   `z-index:500`; the shared `.modal-overlay` class used by every modal
   in the app has `z-index:200`. Any modal opened while the login
   screen is still showing — which is exactly when "Forgot PIN?" opens
   its modal — rendered **behind** the opaque login screen and was
   invisible and unclickable. Fixed with a two-selector CSS override
   (`#recoveryModalOverlay, #recoveryCodeModalOverlay{ z-index:600; }`)
   that raises only these two modals above the login screen, without
   touching the shared `.modal-overlay` stacking used everywhere else.
2. **Keyboard capture.** A global `keydown` listener feeds every digit
   key into the PIN keypad's buffer whenever the login screen is
   visible — including while a modal is open on top of it. Typing a
   recovery code (which contains digits) was silently also driving the
   hidden PIN buffer, and reaching 4 digits there could trigger a
   background PIN-verification attempt. Fixed by having that listener
   bail out whenever any `.modal-overlay.open` exists in the document.

With both fixed, the recovery-code `<input type="text">` — which
already had correct `autocomplete`, `autocapitalize`, `spellcheck`,
focus-on-open, Enter-to-submit, and clear-on-close behavior from the
previous update — is now actually visible, focused, and fully usable.

### 11. Recovery code setup — first-time-only

Previously, recovery-code setup was never shown automatically at all
(only reachable via Settings → Security). It's now triggered exactly
once, immediately after the very first admin PIN is created
(`loginMode==='setup-confirm'` success path) — and only there. Logging
out and back in, refreshing the page, or any later login never
triggers it again; Settings → Security continues to show "Set Up
Recovery Code" for a pre-existing install that has a PIN but no
recovery code yet (e.g. one upgraded from before recovery codes
existed), and "Regenerate Recovery Code" once one is configured — both
still gated by current-PIN reauthentication, unchanged from before.

### 12. Exactly one beep per successful scan (Web Audio API)

A single shared `AudioContext` (lazily created/resumed from the same
tap that starts a scanner, to satisfy the browser's user-gesture
requirement) drives `playScanBeep()` — a short synthesized sine-wave
blip, no audio file or external dependency. It is called from each
scanner call site's own **accept** branch — i.e. only after the
decoded payload has actually been validated as usable (a real book
found for Issue/Return, a well-formed Book/Student QR for Add Book) —
never from the raw camera-decode callback. That placement matters: an
invalid QR, a QR of the wrong type (see below), or a duplicate callback
for a QR still sitting in front of the camera never produces a beep,
only a genuinely-accepted scan does. Manual barcode typing never
beeps, only actual scans (camera or image-upload) do.

### 13. Wrong-QR-type guards (Book vs Student)

A new `detectQrPayloadType(text)` classifier (separate from, and never
altering, the existing `parseScannedPayload()` used to actually read a
Book QR) distinguishes a Student QR (`{"type":"student",...}`) from a
Book QR (has `.barcode`) from a plain non-JSON barcode string. Every
Book-QR scanner (Add Book, Issue, Return — camera and image-upload
paths) now rejects a scanned Student QR with "Please scan a Book QR
Code." without touching the form's existing fields, and the new
Student QR scanner (see below) rejects a scanned Book QR the same way
with "Please scan a Student QR Code." On a wrong-type rejection the
camera scanner is explicitly kept running (the internal `scanProcessed`
guard is reset) so the admin can immediately rescan the right code
without restarting the camera.

### 14. Multiple-book special permission (per-student, Admin-controlled)

The one-student-one-active-book rule from the previous update is now
**conditional** rather than absolute. A new `allowMultipleBooks`
boolean lives directly on the existing `students` table record (no
second database, no Dexie schema/version bump — IndexedDB stores don't
require every property to be declared as an index, only ones actually
queried by, and `studentId` already is the primary key) and defaults to
`false`/absent for every existing and new student.

- `studentAllowsMultipleBooks(studentId)` / `setStudentMultiBookPermission(studentId, allow)`
  read and upsert just that flag, preserving whatever name/class/
  section already exists on the record.
- A checkbox in Issue Book Stage 1 ("Allow Multiple Books") reflects and
  toggles the current student's permission live, persists immediately,
  and is audit-logged (`student_multi_book_enabled` /
  `student_multi_book_disabled`) — never the PIN, never any secret.
- Both enforcement points from the previous update — the early warning
  at "Continue to book scan" and the **mandatory, final** re-check
  inside `issueConfirmBtn` immediately before the transaction is
  created — now check `studentAllowsMultipleBooks()` first and skip the
  one-book block entirely when it's true. The final check re-reads the
  permission from the database itself (not the Stage-1 checkbox's
  in-memory state), so it can't go stale between steps.
- Disabling the permission later never touches existing transactions —
  it only affects whether a *new* additional loan is blocked; a
  student's existing multiple active loans remain valid and returning
  any of them still works normally. This is inherent to the design
  (the check only ever runs at new-issue time) rather than a separate
  code path that needed to "preserve" anything.

### 15. Scan Student QR during Issue Book

Issue Book Stage 1 now has a Manual Entry / Scan Student QR toggle
(scoped to its own `#issueStudentIdToggle` container — see the code
comment there about why it couldn't reuse the existing generic
`.scanner-toggle button` selector without colliding with the unrelated
Camera/Manual toggle used later for the Book QR scan in Stage 2).
Scanning a Student QR auto-populates Student ID, Name, and Class/
Section, shows a clear success state, and lets the admin continue
straight to the book scan — manual entry remains fully available and
unchanged. The student's multiple-book-permission checkbox is refreshed
immediately after a successful scan, same as after manually typing/
blurring the Student ID field.

### 16. Student Bulk QR Code generation

The Bulk QR view gained a Book Information / Student Information
sub-tab (`#bulkQrTypeToggle`) sitting above the existing (untouched)
Book Bulk QR Generator panel. The Student panel is a parallel,
independent implementation that deliberately mirrors the Book
generator's architecture rather than sharing mutable state with it:

- **Template & sample download** — `Download Sample Student Excel`
  produces a real `.xlsx` (via the same `XLSX` library already used for
  the Book sample) with the exact required headers (`Student ID / Roll
  Number`, `Student Name`, `Class / Section`) and 5 realistic sample
  rows. The existing Book sample download is untouched and both remain
  available side by side.
- **Import & validation** — header matching tolerates case, extra
  whitespace, and common header variants (`normalizeStudentHeaderKey`);
  Student ID, Name, and Class/Section are all required, blank rows are
  silently skipped, and any other invalid/duplicate-within-file row is
  marked invalid with a specific reason shown in a per-row preview list
  — one bad row never stops the rest of the file from processing.
- **QR payload** — `{"type":"student","version":1,"studentId":...,
  "studentName":...,"class":...,"section":""}`. `section` is always
  emitted empty and the whole "Class / Section" cell goes into `class`
  unchanged: this app's live Issue Book form (`issueStudentClass`) has
  always treated class/section as one combined field, so that's the
  data model this preserves rather than guessing a split that could
  misparse real values.
- **PDF layout** — identical A4, 5×5, ≤25-per-page grid math, dotted
  cutting-line cell borders, and the same `drawScissors()` cutting-mark
  helper as the existing Book Bulk QR PDF; nothing about the Book
  layout was changed to build this.
- Like the Book generator, this **only produces a printable PDF** — it
  does not write anything into the `students` table, matching the
  existing Book generator's behavior of never writing into `DB.books`
  either. Generation is audit-logged
  (`student_bulk_qr_generated`, count + page count only).

### 17. Multiple encrypted backup import — merge, not restore

The import file picker now accepts multiple files at once
(`<input ... multiple>`) and the entire import path was rewritten
around a shared `mergeSingleBackupPayload()` merge function instead of
the previous single-file `runImport()`:

- Each selected file is read and JSON/wrapper-checked independently;
  files that aren't valid JSON or aren't a recognizable encrypted
  Stackroom backup are recorded as failed immediately and never block
  the rest of the batch.
- **One password prompt covers the whole batch** (the common case for
  "select several backups at once" is the same admin, same password);
  a file that fails to decrypt with it — wrong password, corrupted,
  tampered — is recorded as a failed file with a generic reason and the
  rest of the batch still proceeds. No error message ever includes the
  password, a derived key, a hash, or a salt.
- Every book/transaction/**student** record from every successfully-
  decrypted file is validated (`isValidBookRecord` / `isValidTxRecord` /
  new `isValidStudentRecord`) and deduplicated by its real identifier
  (barcode+ID for books, transaction ID, Student ID) against both the
  **current live database** and every other file already merged in the
  same batch — never a naive string/object comparison. A duplicate is
  skipped, never overwritten; an invalid or blank record is skipped;
  neither ever aborts the rest of the file or the batch.
- Student records imported this way get `allowMultipleBooks` defaulted
  to `false` when the field is absent from an older backup — backward
  compatible, never rejects an otherwise-valid legacy backup over a
  field it predates.
- The actual database write is still a **single** atomic step
  regardless of how many files were merged: all books/transactions
  across the whole batch are folded into the in-memory `DB.books` /
  `DB.transactions` arrays first, then written once via the existing
  `persistData()` (one Dexie `'rw'` transaction), with one
  `students.bulkPut()` for every newly-accepted student and one
  consolidated `backup_imported` audit-log entry for the whole batch.
- A detailed report renders after every import: total files, files
  succeeded/failed (with reasons), records added by type, and a
  scrollable **File / Type / ID / Reason** table listing every skipped
  or failed record/file — nothing sensitive (no password, key, hash,
  or salt) ever appears in it.

## Database & migration versions

- `STACKROOM_DB_VERSION = 1` (Dexie schema version — **unchanged**; no
  schema migration was required for this update either, since
  `allowMultipleBooks` is stored as a plain unindexed property on the
  existing `students` table record, exactly like `recoveryVerifier`
  before it lived as a plain record in the existing `meta` store)
- `STACKROOM_APP_VERSION = '2.2.0'` (bumped — recovery-code input bug
  fix, first-time-only recovery setup, scan beep, wrong-QR-type guards,
  multiple-book permission, Student Bulk QR, multi-file backup merge;
  no destructive migration involved in any of it)
- `STACKROOM_SCHEMA_VERSION = 2` (unchanged — this is the existing
  *backup file* schema version, not the database version)

To add a future schema change: add `libraryDB.version(2).stores({...})`
below the existing `version(1)` block (Dexie migrates automatically),
and bump `STACKROOM_DB_VERSION`. To ship a new Service Worker cache
set, bump `CACHE_VERSION` at the top of `sw.js` — the `activate` handler
deletes any cache from a previous version automatically.
`CACHE_VERSION` was bumped to `stackroom-v3` in this update so that
clients pick up all of the above instead of serving a stale cached
`index.html`.

## Verification report

**This update includes a real-browser test pass** (see below) — the
previous limitation ("no live browser in this environment") has been
partially lifted: a local Chromium binary and Playwright were
available, so this round was verified by actually running the app,
not just by static code review.

### Real-browser testing performed

**Environment constraint:** this sandbox has no outbound network
access at all — not from the browser, not from `npm`/`pip` — so the
app's real CDN dependencies (Dexie, html5-qrcode, qrcode-generator,
JsBarcode, jsPDF, XLSX) could not be loaded from their real CDN URLs.
To still get genuine functional coverage rather than skip live testing
entirely, a **local Dexie-compatible shim backed by real native
IndexedDB** was built (not a mock — actual IndexedDB reads/writes,
implementing exactly the subset of Dexie's API this app calls), plus
lightweight stubs for the QR/PDF/Excel libraries (real Canvas API for
QR image generation, real page-count math for jsPDF, a self-consistent
in-memory workbook for XLSX). AES-GCM/PBKDF2 backup encryption needed
no stub at all — `crypto.subtle` is a native browser API. These test
harnesses are **not part of the delivered app** — only used locally to
drive `index.html` in a real browser for this verification pass.

Four independent Playwright test suites were run against real
Chromium, driving the actual UI (clicks, typing, keyboard events,
screenshots, computed-style/z-index/hit-testing checks) — **83 of 83
checks passed**, with one caveat below on Bulk QR file parsing:

- **Recovery-code system (36/36)** — this is the actual bug reported.
  First-time PIN setup → recovery code auto-shown once, gated by the
  confirmation checkbox → does **not** reappear after logout/login →
  "Forgot PIN?" now opens a modal confirmed via real computed z-index
  (600, beating the login screen's 500), real hit-testing (the input
  is the actual topmost element at its own coordinates, not covered),
  and real auto-focus → typed digits land in the recovery field and
  verifiably do **not** leak into the hidden PIN dots (the exact
  keyboard-capture bug) → full reset-PIN-via-recovery round trip (old
  PIN rejected, new PIN works) → repeated wrong codes trigger lockout →
  full regeneration round trip (old code rejected, new code accepted).
- **Books, Issue/Return, one-book rule, multi-book permission (18/18)**
  — added books, issued a book via manual barcode entry, confirmed the
  one-student-one-book rule blocks a second loan with the right
  message, enabled "Allow Multiple Books" and confirmed a second loan
  now succeeds, confirmed the active-loan-count label updates, returned
  a book, disabled the permission afterward and confirmed the
  **existing** second loan is untouched while a new third loan is
  correctly blocked, and confirmed two students sharing a name but not
  an ID are never conflated.
- **Wrong-QR-type guards, Student QR scan, multi-file backup merge
  (18/18)** — simulated camera decodes (via a test-only hook standing
  in for real camera hardware, which no automated environment can
  exercise) confirmed a Student QR is rejected with "Please scan a
  Book QR Code." without corrupting the form, that the camera keeps
  running for an immediate correct rescan, and the reverse case for the
  Student scanner. Then: exported a real encrypted backup (genuine
  AES-GCM/PBKDF2 via `crypto.subtle`, genuine file download via
  `expect_download`), added more data, exported a second (superset)
  backup, deliberately corrupted a third fake file, and imported all
  three at once — confirmed the report shows 2 of 3 files succeeded,
  the corrupted file is listed as failed by name, overlapping records
  between the two real backups were correctly deduplicated (each book
  appears exactly once after merge, not doubled), and no password/salt/
  hash ever appears in the report text.
- **Bulk QR UI + mobile responsiveness (11/11)** — Book/Student
  sub-tab switching works and doesn't disturb the other panel, both
  sample-download buttons run without throwing, the Generate PDF
  buttons stay correctly disabled with no data loaded, no horizontal
  overflow at a 375px mobile viewport (dashboard and with the recovery
  modal open), and the hamburger menu correctly reaches the sidebar's
  Logout button on mobile.

**What this real-browser pass could NOT cover, and why:**
- Actual QR camera scanning (real hardware — no automated environment,
  headless or otherwise, can exercise a real camera; the wrong-type-
  guard and populate-fields logic downstream of a decode WAS verified,
  via simulating what a real decode callback delivers).
- Real `.xlsx` binary parsing for Student/Book Bulk QR uploads — the
  XLSX stub used here doesn't implement real spreadsheet binary
  format, so the upload→parse path itself wasn't exercised end-to-end
  this round (the tab-switching, sample-download, and disabled-until-
  data-loaded UI states were verified instead). The row-validation
  logic itself (header alias matching, required-field checks,
  duplicate-in-file detection) was verified by static code review, not
  by running it against a real file.
- Real PDF visual rendering (the jsPDF stub tracks page-count math for
  real but doesn't rasterize actual PDF bytes).
- Installability/PWA behavior and the Service Worker's actual offline
  cache-first behavior (both need a real hosted origin+manifest
  install prompt, not just a local static file server).

**One real bug was suspected, investigated, and ruled out:** during
this pass, Issue Book's confirm step initially appeared to hang. Deep
investigation (screenshots, polling the DOM every 100ms, an explicit
`unhandledrejection` listener) traced it conclusively to the **test
script**, not the app: Playwright's `.fill()` already fires a native
`change` event, and the test was *also* manually dispatching a second
`change` event right after — double-triggering the barcode handler's
scheduled UI transition, so a second, stale transition would fire
*after* the test had already clicked "Issue Book" and moved on,
re-hiding the reset form. Removing the redundant trigger fixed it
immediately, and the full flow — including the exact same one-book and
multi-book-permission scenarios — passed cleanly afterward. No
application code changed as a result of this investigation.

### Previously statically verified (still holds)



- The full inline script parses successfully under Node's JS parser
  (`node --check`) after every edit in this session, including the
  final combined state with all of: the recovery-modal bug fix, the
  first-time-only recovery setup, the scan beep, the wrong-QR-type
  guards, the multiple-book permission, Student Bulk QR, and the
  multi-file backup merge.
- Every function name in the file — existing and newly added this
  session (`playScanBeep`, `ensureAudioCtx`, `detectQrPayloadType`,
  `activeIssuesForStudent`, `getStudentRecord`,
  `studentAllowsMultipleBooks`, `setStudentMultiBookPermission`,
  `refreshMultiBookToggleForStudent`, `processStudentBulkRows`,
  `renderStudentBulkPreview`, `normalizeStudentHeaderKey`,
  `readFileAsText`, `mergeSingleBackupPayload`, `isValidStudentRecord`,
  `renderImportReport`, plus every modal-wiring function from the
  previous session) — is unique within the app's IIFE scope; no
  accidental redeclaration.
- Every `document.getElementById('literal-id')` call in the file
  (289 total after this session's additions) targets an id that
  actually exists in the markup — verified by script, zero missing.
- No duplicate `id="..."` attributes anywhere in the file.
- HTML tag balance (`<div>`/`</div>`, `<script>`/`</script>`) is even
  after every edit this session (346/346 divs, 7/7 scripts, at the
  final state).
- Source-audited again for secret exposure: every `console.error` call
  in the file (13 total) logs only a caught exception object, never a
  PIN, recovery code, verifier, salt, or backup password; every backup
  import failure message (bad JSON, wrong wrapper, wrong password,
  tampered file) is a fixed generic string, never derived from the
  actual cryptographic failure detail.
- Every function referenced by the new Student Bulk QR / multi-backup
  code (`qrToPngDataUrl`, `drawScissors`, `bookCopies`, `todayISO`,
  `hasWebCrypto`, `isEncryptedBackupWrapper`, `validateBarcodeFormat`,
  `findBookByBarcode`, `availableCopiesFor`, `syncBookAutoStatus`,
  `persistData`, `writeAuditLog`, `escapeHtml`, `showToast`) was
  confirmed to actually exist in the file before being called, by
  scripted occurrence-count check.
- Caught and fixed one real scoping bug during this session's own
  review, before it ever shipped: the new Student-ID Manual/Scan-QR
  toggle initially reused the same `.scanner-toggle button` CSS class
  as the pre-existing Book-QR Camera/Manual toggle in Issue Stage 2.
  Since the wiring code originally selected by that shared class name
  document-wide within `#view-issue`, the two toggles would have
  fought over each other's click handling. Fixed by giving each its
  own id (`#issueStudentIdToggle`, `#issueBookScanToggle`) and scoping
  every listener to it.

**Not run end-to-end in a real browser** — same limitation as before:
no headless browser with the CDN scripts (Dexie, html5-qrcode, XLSX,
jsPDF) loading successfully in this sandboxed environment. Every item
below has been carefully traced through the code but not exercised
live. Please walk through, in addition to the previous session's
checklist:

- Open the app fresh, confirm "Forgot PIN?" now actually opens a
  visible, focused, typeable Recovery Code field on top of the login
  screen (this was the actual bug reported) — type a code with digits
  in it and confirm the background PIN dots never light up.
- First-time setup on a brand-new install: confirm the recovery-code
  display modal appears automatically right after PIN creation, then
  log out and back in and confirm it does **not** appear again.
- Issue a book to a student, confirm the "Allow Multiple Books"
  checkbox is disabled until a Student ID is entered, then toggle it on
  and confirm a second book can now be issued to the same student;
  toggle it back off and confirm a *third* book is blocked while the
  first two remain listed as active loans.
- In Issue Book, switch to "Scan Student QR", scan a Student QR
  generated by the new Student Bulk QR tool, and confirm the three
  fields populate and the multi-book checkbox reflects that student's
  actual saved permission.
- Try scanning a Book QR where a Student QR is expected (and vice
  versa) and confirm the "Please scan a ___ QR Code" message appears
  with no beep and no field corruption, and that the camera keeps
  running for an immediate retry.
- Confirm exactly one beep per successful scan across Add Book, Issue,
  Return, and the new Student scanner — and no beep at all for an
  invalid or wrong-type QR, or for manual barcode typing.
- Bulk-generate Student QR codes for 26 and for 51 sample students and
  confirm 2 and 3 PDF pages respectively, with scissors marks matching
  the existing Book QR PDF's style.
- Export two backups from two different points in time (so they share
  some records and each has some new ones), then select **both** files
  at once in Import and confirm: the report shows both files
  succeeded, only the genuinely-new records were added, every
  already-existing/duplicate record is listed in the skipped table with
  a correct reason, and no existing data was altered. Then try adding a
  third, deliberately corrupted file to the same selection and confirm
  it's reported as a failed file while the other two still import.

Please treat anything unexpected in that pass as a bug report I'd want
to fix rather than an acceptable gap.

- Existing features preserved: **yes, by construction** — every change
  this session was either a new function/modal/panel, or a small
  targeted edit at a specific existing call site (the two scanner
  functions' decode paths, `issueToStep2`/`issueConfirmBtn`, the single
  import handler which was replaced by a functionally-equivalent-plus-
  multi-file version). No unrelated existing function was rewritten,
  renamed, or had its prior behavior removed; the Book Bulk QR
  Generator, Book sample Excel download, and Book QR PDF layout are
  byte-for-byte the same code paths as before this session.
- Recovery-code input bug: root-caused (modal z-index + keyboard
  capture) and fixed — not live-tested.
- Recovery-code first-time-only setup: implemented — not live-tested.
- Scan beep: implemented (Web Audio, one shared `AudioContext`) — not
  live-tested; this is inherently hard to verify statically since it
  depends on real browser audio permission/gesture behavior.
- Wrong-QR-type guards: implemented for every Book/Student scanner
  pair — not live-tested.
- Multiple-book permission: implemented, including the disable-doesn't-
  touch-existing-loans guarantee (inherent to the design, not a
  separate code path) — not live-tested.
- Student Bulk QR (Excel template, sample download, validation, PDF
  with scissors marks): implemented, mirroring the existing Book
  generator's architecture exactly — not live-tested; PDF generation
  in particular needs a real browser to confirm the visual layout.
- Multi-file encrypted backup import/merge: implemented with per-file
  isolation, real-identifier deduplication against both the live
  database and the rest of the batch, and a detailed skip/failure
  report — not live-tested; this is the piece I'd most want a real
  round-trip test on, since it's the most structurally complex change
  in this session.
- Database version: 1 (unchanged — `allowMultipleBooks` needed no
  schema migration, same as recovery metadata before it).
- Known limitations carried over: 4-digit PIN keyspace (mitigated by
  lockout); CDN libraries not vendored (mitigated by SW caching after
  first load); no live browser test was performed this session either,
  for any of the 17 documented changes above.

