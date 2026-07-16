# Signet — project notes for Claude Code

Self-hosted PDF editor with e-signature requests built in, for Ridgeline Construction. Lives
entirely on Zac's own Cloudflare account (Workers + D1 + R2). Runs standalone — separate from
the Yardstick takeoff tool.

## Current status (as of this handoff)

**It's live**: https://signet.ridgeline.workers.dev — deployed, working, password-protected.

Already provisioned on Cloudflare (do not re-create these):
- Worker: `signet`
- D1 database: `signet-db` (id in `wrangler.toml`), schema already migrated
- R2 bucket: `signet-files`
- Secrets already set via `wrangler secret put`: `ADMIN_PASSWORD`, `SESSION_SECRET`, `APP_URL`.
  Secrets are write-only — nobody can read the current values back, only overwrite them. If
  Zac needs the password changed, just `wrangler secret put ADMIN_PASSWORD` again and redeploy
  isn't even required (secrets apply immediately).
- **Not yet set**: `RESEND_API_KEY` / `MAIL_FROM`. Email sending (invites, reminders, completed
  docs) currently no-ops silently — the app works fully for editing, and the send-for-signature
  flow will create the envelope, but recipients won't get an email until Resend is configured.
  See README.md "Set up Resend" section.

Auth: single shared `ADMIN_PASSWORD` unlocks the whole app for whoever's using it — no
per-user accounts. Session tokens are HMAC-signed with `SESSION_SECRET`, stored in the
browser's `localStorage`, and don't expire on their own — changing `ADMIN_PASSWORD` doesn't
invalidate already-issued tokens.

## Architecture

```
worker/index.js         Hono app — all /api/* routes, serves public/ as static assets
worker/lib/auth.js       session token signing/verification
worker/lib/email.js      Resend wrapper (no-ops if RESEND_API_KEY unset)
worker/lib/pdf.js        server-side pdf-lib helpers (flattening signed envelopes)
worker/lib/util.js       misc
public/index.html        sender app shell (login screen + app layout, no inline JS)
public/app.js             all sender-side JS: PDF editor engine, tool rail, envelope wizard,
                          requests drawer — this is where most feature work happens
public/sign.html          signer-facing page, token-based (?t=...), no login
schema.sql                D1 schema: envelopes, recipients, fields, field_values, audit_events
```

The PDF editor (public/app.js) is 100% client-side — pdf-lib + pdf.js in the browser, nothing
touches the network until you hit Download or Send for signature. The envelope/signing flow is
the only part that talks to the Worker API.

## UI redesign (most recent major change)

The app was rebuilt into an Adobe-style 3-pane editor (left tool rail, thumbnail rail, single-
page zoomable canvas, contextual right properties panel) based on a design mockup Zac provided
via Claude Design. Wired up and fully working: Select, Text (bold/italic/underline/color),
Signature/Initials (draw/type/upload, panel-embedded), Highlight, Redact (drag + "Apply &
flatten" permanently rasterizes), Watermark, Page numbers, Organize (rotate/duplicate/delete/
extract/insert blank — acts on the currently-viewed page).

**Now implemented** (previously stubbed): Draw/pen (freehand ink), Shapes (rectangle/ellipse/
line/arrow), Image insert, and the Hand/pan tool — all wired end-to-end (canvas interaction →
marker rendering → pdf-lib bake on export). Text is edited **directly on the page** (the marker
is contenteditable; the right panel is a style inspector), not staged in the side panel.

Tool-rail icons are inline SVG line-icons (see `public/index.html`), not unicode glyphs.

## Day-to-day

```bash
npm install              # first time
npx wrangler login        # authorize this machine against Zac's Cloudflare account
npm run dev                # local dev against simulated D1/R2
npm run deploy              # ship to the live Worker — this affects the real signet.ridgeline.workers.dev
npm run tail                 # stream logs from the live Worker
```

`npm run deploy` is a real, immediate, live deploy — there's no staging environment. Be sure
before running it.

## Known rough edges

- No true PDF password/encryption support (pdf-lib limitation, client-side).
- Signing order: recipients sharing the same "order" number sign in parallel; the next order
  number is notified only once the current one is fully signed.
- The redesign was built and syntax-checked but not click-tested in a real browser by the
  agent that built it (sandbox had no working headless browser) — it *was* verified live via
  Claude-in-Chrome browser automation in one later session and confirmed working end to end
  for login. Worth a thorough manual pass before relying on it for a real signature request.
- `wrangler` here is v3.114.17 (outdated, v4 available) — fine for now, consider upgrading if
  you hit compatibility issues.

## Who's touching what

Zac asked for Claude Code to take over active development on this project going forward. The
Cowork agent that built it will stay hands-off on deploys unless explicitly asked back in, to
avoid two agents pushing to the same live Worker at once.
