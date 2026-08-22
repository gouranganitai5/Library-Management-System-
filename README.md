# Stackroom — School Library System

Offline-capable, single-file school library management system: book registry, QR/barcode-based issue & return, student records, reports, and encrypted local backups. Runs entirely in the browser as an installable PWA — no backend server required.

## Files

| File | Purpose |
|---|---|
| `index.html` | The entire application — markup, styles, and all JavaScript logic. |
| `sw.js` | Service worker: caches the app shell and required CDN scripts for offline use. |
| `manifest.json` | PWA manifest (name, icons, theme colors, standalone display). |
| `SECURITY_AUDIT_REPORT.md` | Record of a security hardening pass — encryption architecture, auth changes, XSS/CSP protections, and known limitations. Read this before deploying. |

## Requirements

- Any modern browser with IndexedDB and Web Crypto support.
- Internet access on first load (to fetch the CDN dependencies below); fully offline afterward via the service worker.
- A device camera is optional — QR/barcode scanning also supports manual entry and image upload.

### Dependencies (loaded from CDN, no build step)

- [Dexie](https://dexie.org/) — IndexedDB wrapper
- [html5-qrcode](https://github.com/mebjas/html5-qrcode) — camera QR/barcode scanning
- [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) — QR code generation
- [JsBarcode](https://github.com/lindell/JsBarcode) — barcode generation
- [jsPDF](https://github.com/parallax/jsPDF) — PDF export (bulk QR sheets, reports)
- [SheetJS (xlsx)](https://sheetjs.com/) — Excel import/export

A Content-Security-Policy meta tag restricts script/style sources to `'self'` plus these exact CDN origins.

## Running it

No build or install step — it's a static site.

```bash
# any static file server works, e.g.:
npx serve .
# or just open index.html directly in a browser
```

For PWA installability and service-worker caching to work as intended, serve it over `http://localhost` or HTTPS (not `file://`).

## Core features

- **Dashboard** — at-a-glance counts and quick stats.
- **Book Registry** — add/edit/delete books, copies, shelf location; generate book QR codes/barcodes.
- **Student management** — manual entry or bulk import; per-student QR code generation (including bulk PDF sheets); "Allow Multiple Books" permission per student.
- **Issue Book** — three-stage guided workflow (see below).
- **Return Book** — QR/barcode scan or manual entry, early-return handling, fine calculation.
- **Records** — Issued / Overdue / Returned transaction history.
- **Audit log** — key actions (issues, returns, permission changes, resets) are logged.
- **Backup & restore** — encrypted, password-protected export/import with bounded PBKDF2 iterations and record validation on import.
- **PIN-protected access** with session expiration.
- **Responsive UI** for desktop and mobile, installable as a PWA.

## Issue Book workflow

Three stages, enforced end-to-end so the UI can never be relied on alone:

1. **Identify the Student** (`issueStage1`)
   Scan the student's QR code or use Manual Entry to fill in Student ID / Name / Class. The **"ISSUE BOOK"** button validates this information (including the "Allow Multiple Books" / existing-active-loan check) and, if valid, advances to Stage 2. It does **not** create a transaction.

2. **Scan/Enter the Book** (`issueStage2`)
   Camera scan, manual barcode entry, or QR image upload. Book availability, Lost/Damaged status, and duplicate/unavailable handling are checked here.

3. **Confirm & Issue** (`issueStage3`)
   Displays a summary and issue/return dates. Pressing **"Issue Book"** re-runs the authoritative eligibility and availability checks one final time immediately before creating the transaction — this is the only step that actually writes a transaction, updates book status, persists to IndexedDB, and writes the audit log.

After a successful issue, the form resets (`resetIssueFlow()`) and Stage 1 is shown again with **"Scan Student QR" selected by default** — ready for the next student without the operator having to switch modes manually. This does not request camera permission on its own; the camera only starts on an explicit "Start Camera" tap.

Key functions to know if you're modifying this flow: `showIssueStage()`, `resetIssueFlow()`, `processIssueBarcode()`, `startScanner()` / `stopScanner()`, and the `issueConfirmBtn` click handler.

## Data & security model

See `SECURITY_AUDIT_REPORT.md` for full detail. Summary:

- All application data (books, transactions, students, settings, audit log) is stored in IndexedDB, encrypted with AES-256-GCM (random IV per record); only `barcode` and `studentId` remain as plaintext indexes.
- The Data Encryption Key is a non-extractable `CryptoKey`, independent of the login PIN.
- PIN comparison is constant-time; sessions carry a 12-hour absolute expiration.
- All external input (QR payloads, Excel imports, backup files) is validated for type, length, and shape before use.
- Backups are password-encrypted exports with bounded PBKDF2 iteration counts and a file-size cap.
- **Threat model note:** this protects against casual inspection of raw IndexedDB data and a broad range of injection/validation gaps. It does not protect against malicious code already running on the page's origin or a compromised browser/device — see the audit report's "Remaining limitations" section.

## Known limitations

- No audit-log viewer in the UI (entries are recorded and included in backups, but not displayed).
- CDN libraries are not vendored — the app depends on those origins being reachable and untampered (mitigated by CSP scoping).
- No HTTP-level security headers (HSTS, COOP, etc.) — add these at your hosting layer.
