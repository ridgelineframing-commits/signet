-- Adds opt-in email OTP verification for signing.
-- Apply to the LIVE database (additive, non-destructive):
--   wrangler d1 execute signet-db --file=./migrations/001_add_otp.sql --remote
-- (schema.sql already includes these columns for fresh installs — do NOT run schema.sql
--  against the live DB, it drops every table.)

ALTER TABLE envelopes  ADD COLUMN require_otp  INTEGER NOT NULL DEFAULT 0;
ALTER TABLE recipients ADD COLUMN otp_hash     TEXT;
ALTER TABLE recipients ADD COLUMN otp_expires  TEXT;
ALTER TABLE recipients ADD COLUMN otp_verified INTEGER NOT NULL DEFAULT 0;
