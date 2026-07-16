-- Signet D1 schema
-- Apply with: wrangler d1 execute signet-db --file=./schema.sql --remote

DROP TABLE IF EXISTS audit_events;
DROP TABLE IF EXISTS field_values;
DROP TABLE IF EXISTS fields;
DROP TABLE IF EXISTS recipients;
DROP TABLE IF EXISTS envelopes;

CREATE TABLE envelopes (
  id            TEXT PRIMARY KEY,        -- uuid
  title         TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'draft',   -- draft | sent | partially_signed | completed | voided | declined
  original_key  TEXT NOT NULL,           -- R2 key of the source PDF
  final_key     TEXT,                    -- R2 key of the flattened, fully-signed PDF (set on completion)
  page_count    INTEGER NOT NULL DEFAULT 1,
  sender_name   TEXT,
  sender_email  TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  sent_at       TEXT,
  completed_at  TEXT,
  voided_at     TEXT,
  message       TEXT,                   -- optional note included in the invite email
  require_otp   INTEGER NOT NULL DEFAULT 0  -- 1 = signers must verify an emailed code before signing
);

CREATE TABLE recipients (
  id            TEXT PRIMARY KEY,        -- uuid
  envelope_id   TEXT NOT NULL REFERENCES envelopes(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'signer',  -- signer | approver | cc
  sign_order    INTEGER NOT NULL DEFAULT 1,      -- recipients with equal order sign in parallel
  token         TEXT NOT NULL UNIQUE,            -- opaque signing link token
  status        TEXT NOT NULL DEFAULT 'pending', -- pending | notified | viewed | signed | declined
  notified_at   TEXT,
  viewed_at     TEXT,
  signed_at     TEXT,
  declined_at   TEXT,
  decline_reason TEXT,
  ip_hash       TEXT,
  user_agent    TEXT,
  otp_hash      TEXT,                    -- SHA-256 of the current email verification code
  otp_expires   TEXT,                    -- ISO expiry for the code
  otp_verified  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE fields (
  id            TEXT PRIMARY KEY,        -- uuid
  envelope_id   TEXT NOT NULL REFERENCES envelopes(id) ON DELETE CASCADE,
  recipient_id  TEXT NOT NULL REFERENCES recipients(id) ON DELETE CASCADE,
  type          TEXT NOT NULL,           -- signature | initials | date | text | checkbox
  page          INTEGER NOT NULL,        -- 0-indexed page number
  x             REAL NOT NULL,           -- fraction of page width (0-1)
  y             REAL NOT NULL,           -- fraction of page height (0-1), measured from top
  w             REAL NOT NULL,
  h             REAL NOT NULL,
  required      INTEGER NOT NULL DEFAULT 1,
  label         TEXT
);

CREATE TABLE field_values (
  field_id      TEXT PRIMARY KEY REFERENCES fields(id) ON DELETE CASCADE,
  value_text    TEXT,                   -- for text/date/checkbox
  value_image   TEXT,                   -- base64 PNG for signature/initials
  filled_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE audit_events (
  id            TEXT PRIMARY KEY,
  envelope_id   TEXT NOT NULL REFERENCES envelopes(id) ON DELETE CASCADE,
  recipient_id  TEXT REFERENCES recipients(id) ON DELETE SET NULL,
  event         TEXT NOT NULL,          -- created | sent | viewed | signed | declined | completed | voided
  detail        TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_recipients_envelope ON recipients(envelope_id);
CREATE INDEX idx_fields_envelope ON fields(envelope_id);
CREATE INDEX idx_fields_recipient ON fields(recipient_id);
CREATE INDEX idx_audit_envelope ON audit_events(envelope_id);
