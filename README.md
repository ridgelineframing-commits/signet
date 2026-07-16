# Signet

A self-hosted PDF toolkit + e-signature app — the DocuSign-style piece you asked for, kept
separate from Yardstick. Runs entirely on your own Cloudflare account.

- **PDF Toolkit tab** — merge, split, reorder/delete/rotate pages, extract pages, insert
  blank pages, watermark, page numbers, click-to-place text, draw/type/upload a signature to
  stamp on a document yourself, and redaction (with an optional "flatten" mode that rasterizes
  the page so the text underneath is truly gone, not just painted over). 100% client-side —
  nothing you edit here touches the network.
- **Envelopes tab** — upload a PDF, add recipients with a signing order, drop signature/
  initials/date/text/checkbox fields onto the pages per recipient, send. Recipients get an
  emailed link (no login) to review and sign. Once everyone's signed, Signet stamps every
  field onto the PDF, appends a certificate-of-completion page (who signed, when, hashed IP),
  and emails the finished document to everyone.

## Architecture

```
Cloudflare Worker  (worker/index.js)   — API + serves the static files in public/
Cloudflare D1      (schema.sql)        — envelopes, recipients, fields, values, audit log
Cloudflare R2                          — stores original + completed PDFs
Resend                                 — sends the invite / notification / completed emails
```

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

```bash
wrangler d1 create signet-db
```

This prints a `database_id` — paste it into `wrangler.toml` in place of
`REPLACE_WITH_D1_DATABASE_ID`. Then load the schema:

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

## Day-to-day

- `npm run dev` — run locally against a local D1/R2 simulation for testing changes.
- `npm run deploy` — ship changes.
- `npm run tail` — live-stream logs from the deployed Worker (handy if an email doesn't send).
- Schema changes: edit `schema.sql`, then re-run the relevant migrate command. D1 doesn't
  auto-migrate — for anything beyond the initial load you'll want additive `ALTER TABLE`
  statements run by hand so you don't wipe existing envelopes.

## Notes & honest limitations

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
