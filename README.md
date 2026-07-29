# Signet

A browser-first PDF editor with an optional self-hosted e-signature workflow. Editing is the
main product; signature requests are a secondary tool. The hosted pieces run on your own
Cloudflare account.

- **PDF editor** — an Adobe-style 3-pane editor (tool rail, page thumbnails, zoomable canvas,
  contextual properties panel). Type text **directly on the page**, draw freehand, drop
  shapes (rectangle/ellipse/line/arrow), insert images, highlight, hand/pan, merge,
  reorder/delete/rotate pages, extract pages, insert blank pages, watermark, page numbers,
  draw/type/upload a signature to stamp yourself, and redaction (with an optional "flatten"
  mode that rasterizes the page so the text underneath is truly gone, not just painted over).
- **Edit text (OCR)** — reads a scanned/flat page with bundled OCR (Tesseract, no network) and
  lets you edit its existing text in place, Adobe-style; edited lines are patched into the
  export. *Note:* the patch covers the original visually but the original text stays in the
  file's text layer — for true removal of sensitive text, use Redact → Apply & flatten.

  Everything above is 100% client-side — nothing you edit touches the network until you
  Download or Send. All libraries (pdf.js, pdf-lib, the webfont, the OCR engine) are
  self-hosted under `public/vendor/`, so there are no third-party CDN dependencies at runtime.
- **Send for signature** — from the editor, add recipients with a signing order, drop
  signature/initials/date/text/checkbox fields onto the pages per recipient, and send.
  Recipients get an emailed link (no login) to review and sign. Once everyone's signed, Signet
  stamps every field onto the PDF, appends a certificate-of-completion page (who signed, when,
  hashed IP), and emails the finished document to everyone. Track status in the **Requests**
  drawer.

## Architecture

```
Cloudflare Worker  (worker/index.js)   — API + serves the static files in public/
Cloudflare D1      (schema.sql)        — envelopes, recipients, fields, values, audit log
Cloudflare R2                          — stores original + completed PDFs
Resend                                 — sends the invite / notification / completed emails
```

## Useful agents (editor-first roadmap)

Agents should propose visible document changes, not become a generic chat panel. The highest
value order is:

1. **Document QA agent** — scans for clipped content, blank pages, inconsistent page sizes,
   missing form values, and likely OCR errors. It returns a page-linked checklist.
2. **Redaction assistant** — suggests names, addresses, account numbers, and other sensitive
   regions, but never applies or flattens a redaction without the user's explicit confirmation.
3. **Form builder agent** — detects likely fields and proposes text, checkbox, date, and
   signature boxes. The user reviews the overlays before anything is added.
4. **Batch cleanup agent** — applies a confirmed recipe (rotate, crop, OCR, watermark, page
   numbering, compression) across several open PDFs and reports exceptions.

Implement these behind one typed proposal format: every proposal names a document, page,
operation, normalized coordinates, confidence, and explanation. Render proposals as overlays
and a diff/checklist; only an explicit **Apply** action may modify the PDF. Keep deterministic
operations in the browser. If a model is later added, make cloud analysis opt-in and send only
the minimum extracted text or page images needed for the selected task. This keeps the editor
useful without handing an autonomous agent irreversible document or sending authority.

Nothing here needs a server you manage — it's all Cloudflare's edge platform, so cost at your
volume will be effectively $0/month (Workers, D1, and R2 all have generous free tiers; Resend's
free tier covers 3,000 emails/month).

## One-time setup

**1. Install prerequisites** (on your own machine, not in this folder — anywhere with Node):

```bash
npm install -g wrangler
cd signet
npm install
wrangler login          # opens a browser, authorizes wrangler against your Cloudflare account
```

**2. Create the D1 database**

> Already provisioned for the live deployment — `wrangler.toml` has the real `database_id` and
> the schema is migrated. These steps are only for standing up a fresh copy from scratch.

```bash
wrangler d1 create signet-db
```

This prints a `database_id` — paste it into `wrangler.toml` under `[[d1_databases]]`. Then load
the schema:

```bash
npm run db:migrate
```

**3. Create the R2 bucket**

```bash
wrangler r2 bucket create signet-files
```

(Name already matches `wrangler.toml` — no further edit needed unless you rename it.)

**4. Set up Resend (email delivery)**

1. Sign up at https://resend.com (free tier: 3,000 emails/month, 100/day).
2. Add and verify a sending domain — since you own `ridgeline.construction`, add something
   like `mail.ridgeline.construction` under **Domains** in Resend, then add the 3 DNS records
   it gives you (TXT/DKIM + a return-path CNAME) at your DNS host. If that domain is on
   Cloudflare DNS already, this is copy/paste into the Cloudflare DNS tab.
3. Create an API key under **API Keys**.

**5. Set secrets** (these never go in `wrangler.toml` / git):

```bash
wrangler secret put RESEND_API_KEY        # the key from step 4
wrangler secret put MAIL_FROM             # e.g. "Signet <sign@mail.ridgeline.construction>"
wrangler secret put ADMIN_PASSWORD        # the password that unlocks your dashboard
wrangler secret put SESSION_SECRET        # run: openssl rand -hex 32
wrangler secret put APP_URL               # the URL you'll deploy to, e.g. https://signet.ridgeline.construction
```

**6. Deploy**

```bash
npm run deploy
```

Wrangler prints a `*.workers.dev` URL — that already works. To use your own domain
(`signet.ridgeline.construction`), go to the Worker in the Cloudflare dashboard → **Settings →
Domains & Routes → Add → Custom domain**, and follow the prompt (it adds the DNS record for you
since your domain's already on Cloudflare). Then update the `APP_URL` secret to match and
redeploy.

**7. Try it**

Open the app, log in with `ADMIN_PASSWORD`, and either use the PDF Toolkit tab immediately (no
setup needed for that half) or create a test envelope addressed to yourself under Envelopes.

## Continuous deployment

The Worker is connected to this GitHub repo via **Cloudflare Workers Builds**, so every push to
`main` builds and deploys automatically — no manual `npm run deploy` needed. Build settings on
the `signet` Worker (Settings → Build):

- **Production branch:** `main`
- **Deploy command:** `npx wrangler deploy`  (no separate build command; there is no `build` script)
- **Root directory:** `/`

Two things auto-deploy does **not** do:

1. **Database migrations.** Deploys ship code, not schema. Additive column changes must be run
   once by hand (Cloudflare dashboard → D1 → `signet-db` → Console, or `wrangler d1 execute`).
   See `migrations/` — e.g. `migrations/001_add_otp.sql` for the email-OTP columns.
2. **Secrets.** These live on the Worker (`wrangler secret put …`) and persist across deploys.

## Day-to-day

- `npm run dev` — run locally against a local D1/R2 simulation for testing changes.
- `npm test` — run the payload and field-validation test suite.
- `npm run deploy` — ship changes manually (rarely needed now that pushes to `main` auto-deploy).
- `npm run tail` — live-stream logs from the deployed Worker (handy if an email doesn't send).
- Schema changes: edit `schema.sql`, then re-run the relevant migrate command. D1 doesn't
  auto-migrate — for anything beyond the initial load you'll want additive `ALTER TABLE`
  statements run by hand so you don't wipe existing envelopes.

## Install it as an app (PDF "Open with")

Signet is a PWA, so on any device it can be installed and registered as a PDF handler —
open a PDF from your file manager / email and it launches straight into the editor, no
browser chrome.

### Windows installer

The `desktop/` wrapper packages the hosted editor as a locked-down Electron application. It
disables Node.js access in the remote page, enables renderer sandboxing and context isolation,
denies browser permission requests and popups, and blocks navigation away from the configured
Signet origin.

```powershell
npm install
npm run desktop:make
```

The no-admin installer is written to:

`out/make/squirrel.windows/x64/Signet-PDF-Editor-Setup.exe`

The installer is unsigned unless a Windows code-signing certificate is added to the Squirrel
maker configuration. An unsigned build still installs, but Windows SmartScreen may identify it
as coming from an unknown publisher.

- **Desktop (Chrome/Edge) & ChromeOS:** visit the site, install it (the install icon in the
  address bar, or ⋮ → *Install Signet*). Once installed it registers as a `.pdf` handler and
  appears in the OS "Open with" list. You can also *share* a PDF to it.
- **iPad/iPhone (Safari):** *Share → Add to Home Screen*. iOS doesn't expose a system-wide
  default-PDF-app hook to web apps, but the installed icon opens the full editor and you can
  *Share → Signet* a PDF into it.
- **Android tablets:** install the signed **APK** below — it registers as a real PDF viewer,
  so "Open with → Signet" and "set as default" work like any native app.

### Android APK (for the tablets)

`android/` holds a [Bubblewrap](https://github.com/GoogleChromeLabs/bubblewrap) Trusted Web
Activity project that wraps the live site in a native shell with a PDF `VIEW` intent filter
(and the share target). To (re)build:

```bash
cd android
./build-apk.sh          # installs Bubblewrap + its own JDK/SDK on first run, then builds
```

Output is `android/app-release-signed.apk` — sideload it (`adb install -r app-release-signed.apk`,
or copy it over and tap it with "install from this source" allowed). On first launch Android
verifies the app against `https://signet.ridgeline.workers.dev/.well-known/assetlinks.json`;
that file publishes the signing key's SHA-256 fingerprint, which is what lets the app open the
site (and PDFs) full-screen without an address bar.

**Keep `android/signet-release.keystore` safe and backed up** (it's gitignored — a signing key
is a secret). You need the *same* keystore to ship any future update, and its fingerprint must
match `assetlinks.json`. If you ever regenerate the keystore, update the fingerprint in
`public/.well-known/assetlinks.json` (the script prints it) and redeploy before installing.

## Notes & honest limitations

- **Email OTP for signing (optional).** When creating a signature request you can tick
  "Require each signer to verify a one-time code." Each signer must then request a 6-digit code
  (emailed to them) and enter it before they can sign; the code is stored only as a salted
  SHA-256 hash and expires in 10 minutes. This needs Resend configured — Signet refuses to
  create an OTP-required envelope when email isn't set up, so signers can never be locked out.
  Adds columns via `migrations/001_add_otp.sql` (`npm run db:migrate:otp` against the live DB).
- **Auth is single-password, single-tenant.** There's one shared `ADMIN_PASSWORD` for whoever
  sends envelopes — fine for you and your team sharing one login, not built for
  customer-facing multi-account use. Say the word if you want real per-user accounts later.
- **No true PDF encryption/password-protection tool** — pdf-lib (the library everything here
  is built on) doesn't support that client-side. Everything else on the "conceivable PDF
  tools" list is implemented for real.
- **Redaction**: the default redact tool draws an opaque box — the text is still in the PDF
  underneath unless you also check "flatten redactions" before downloading, which rasterizes
  every page to an image. Use that when redacting anything sensitive.
- **Signing order**: recipients with the same "order" number are notified together (parallel);
  the next order number is only notified once everyone in the current one has signed
  (sequential). Set everyone to order `1` for an all-at-once send.
- I built and syntax-checked everything here, but I have not run a live end-to-end send
  (that needs your actual Cloudflare account + a verified Resend domain, which only you can
  provision). Test with an envelope addressed to yourself first.

## Want me to actually deploy it for you?

I can run all of the above from here if you hand me a **Cloudflare API token** (Workers/D1/R2
edit permissions) and your **account ID**, plus a **Resend API key** once you've verified a
sending domain. Otherwise, the steps above are copy-paste and should take about 15 minutes.
