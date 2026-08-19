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

## Database & migration versions

- `STACKROOM_DB_VERSION = 1` (Dexie schema version — **unchanged**; no
  schema migration was required for this update, since recovery
  metadata lives in the existing generic `&key` `meta` store)
- `STACKROOM_APP_VERSION = '2.1.0'` (bumped — new recovery, one-book,
  and scanner-reliability features; no destructive migration involved)
- `STACKROOM_SCHEMA_VERSION = 2` (unchanged — this is the existing
  *backup file* schema version, not the database version)

To add a future schema change: add `libraryDB.version(2).stores({...})`
below the existing `version(1)` block (Dexie migrates automatically),
and bump `STACKROOM_DB_VERSION`. To ship a new Service Worker cache
set, bump `CACHE_VERSION` at the top of `sw.js` — the `activate` handler
deletes any cache from a previous version automatically.
`CACHE_VERSION` was bumped to `stackroom-v2` in this update so that
clients pick up the new recovery/one-book/scanner code instead of
serving a stale cached `index.html`.

## Verification report

**Statically verified** (I did not have a live browser with network
access in the environment I built this in, so nothing below claims to
have been *run* unless stated):

- The full inline script parses successfully under Node's JS parser
  (`node --check`) after every edit — no syntax errors, including after
  the recovery/one-book/scanner changes in this update.
- Every existing top-level function name and every new one added in
  this update (`generateRecoveryCode`, `normalizeRecoveryCode`,
  `secureEqualBytes`, `deriveRecoveryHashBytes`,
  `getRecoveryVerifierRecord`, `recoveryConfigured`,
  `initializeRecoveryCode`, `regenerateRecoveryCode`,
  `getRecoveryLockoutState`, `recordRecoveryFailure`,
  `resetRecoveryFailureState`, `verifyRecoveryCode`,
  `resetPinWithRecovery`, `activeIssueForStudent`,
  `normalizeStudentId`, plus the modal wiring functions) are unique
  within the app's IIFE scope — checked by scripted grep, no
  accidental redeclaration.
- Every `document.getElementById('literal-id')` call in the file
  (253 total, including every one added by this update) targets an id
  that actually exists in the markup — verified with a script that
  diffed every literal call site against every `id="..."` in the HTML;
  zero missing.
- No duplicate `id="..."` attributes anywhere in the file.
- HTML tag balance (`<div>`/`</div>`, `<script>`/`</script>`) is even
  after all edits (307/307 divs, 7/7 scripts).
- Source-audited for accidental secret exposure per the checklist in
  the brief: every `console.error` call in the file logs only a caught
  exception object, never a PIN, recovery code, verifier, or salt; the
  recovery code exists only in the short-lived `pendingRecoveryCode`
  local (cleared on modal close) and is never assigned into `settings`,
  `localStorage`, a URL, or the backup payload; `encryptBackupPayload()`
  reads only `books`/`transactions`/`students`/`auditLog` and never
  touches `meta` at all, so the recovery verifier/salt/lockout state
  cannot reach a backup file.
- Every Dexie API call used, including the new
  `libraryDB.transaction('rw', libraryDB.meta, ...)` atomic
  recovery-metadata write, was checked against Dexie's documented API
  surface.

**Not run end-to-end in a real browser** — I was not able to launch a
headless browser with the CDN scripts (Dexie, html5-qrcode, etc.)
loading successfully in the sandboxed environment I built this in (no
outbound network from that specific tool). That means: the migration
path, the issue/return atomic write, the new login/PIN-setup flow, the
backup export/import round-trip, **and every part of this update — PIN
recovery setup/regeneration/reset, the one-book-per-student
enforcement, and the QR scanner reliability fix — have been carefully
traced through the code but not exercised live.** I'd treat this build
as a strong, carefully-reasoned pass that needs a real smoke test in an
actual browser before you rely on it for real library data or a real
recovery event. At minimum, please walk through:

- First-run PIN setup → Settings → Security → "Set Up Recovery Code" →
  confirm PIN → confirm the code is shown once, the checkbox gates the
  "Done" button, and the code is not shown again.
- Log out → "Forgot PIN?" → enter the recovery code → set a new PIN →
  log in with the new PIN → confirm books/transactions/students/settings
  are all untouched.
- Deliberately enter a wrong recovery code 5+ times → confirm the
  lockout message appears and counts down, and that it clears after a
  successful recovery.
- Settings → Security → "Regenerate Recovery Code" → confirm the old
  code no longer works for recovery and the new one does.
- Issue a book to a student, then try to issue a second book to the
  same Student ID before returning the first → confirm it's rejected
  with the existing book title/due date shown; return the book → issue
  again → confirm it now succeeds; try two different students who share
  a name → confirm both succeed independently.
- Camera QR scan on an actual phone (the scanner reliability fix
  specifically targets narrow mobile viewports) for Add Book, Issue
  Book, and Return Book; confirm a single scan never double-fires
  (e.g. never shows two "Issued" stamps for one tap).
- Export an encrypted backup after setting up recovery, open the JSON
  file in a text editor, and confirm no recovery code, verifier, or
  salt string appears anywhere in it.

Please treat anything unexpected in that pass as a bug report I'd want
to fix rather than an acceptable gap.

- Existing features preserved: **yes, by construction** — this update
  only added new functions/modals and inserted small, targeted checks
  at two existing call sites (`issueToStep2`, `issueConfirmBtn`) and
  two existing functions (`startScanner`, `stopScanner`); no existing
  function was rewritten, renamed, or had its existing behavior removed.
- IndexedDB implemented: yes.
- Dexie implemented: yes.
- Legacy data migration implemented: yes, not live-tested.
- Web Crypto backup preserved: yes, format unchanged, not live-tested.
- Backup restore: implemented, not live-tested.
- Service Worker implemented: yes, cache version bumped to
  `stackroom-v2`, not live-tested (see CDN caveat above).
- Offline support: implemented for the app shell; CDN libraries require
  one successful online load first (see limitation above). PIN
  recovery, code regeneration, and the one-book rule are all pure
  IndexedDB/Web Crypto operations and require no network at all once
  the app shell is cached.
- PWA support: manifest + icons present, not live-tested for
  installability.
- Login security: real PBKDF2-verified PIN with lockout, replacing the
  clock-based pseudo-PIN; 4-digit UI length is a known limitation
  (see above). Now paired with an independent, equally
  PBKDF2/lockout-protected recovery-code mechanism — implemented,
  not live-tested.
- One-book-per-student rule: implemented at both the early-warning and
  final-confirm points — not live-tested.
- QR scanner reliability fix: implemented (responsive `qrbox`,
  QR-only format restriction, duplicate-scan guard) — not live-tested;
  this is the one area I'd most want a real phone/browser smoke test
  on, since camera behavior varies meaningfully across devices in ways
  static review can't fully capture.
- Database version: 1 (unchanged — no schema migration needed for this
  update). Migration marker: `meta.migrationVersion`.
- Known limitations: 4-digit PIN keyspace (mitigated by lockout); CDN
  libraries not vendored (mitigated by SW caching after first load);
  no live browser test was performed on this build, including for the
  recovery, one-book, and scanner changes added here.
