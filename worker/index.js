import { Hono } from "hono";
import { PDFDocument } from "pdf-lib";
import { requireAdmin, issueSession } from "./lib/auth.js";
import {
  sendSigningInvite,
  sendViewedNotice,
  sendSignedNotice,
  sendDeclinedNotice,
  sendCompletedPacket,
} from "./lib/email.js";
import { flattenEnvelope, appendCertificatePage } from "./lib/pdf.js";
import { uuid, newToken, hashIp, nowIso, jsonError } from "./lib/util.js";

const app = new Hono();

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------
app.post("/api/auth/login", async (c) => {
  const { password } = await c.req.json().catch(() => ({}));
  if (!c.env.ADMIN_PASSWORD || password !== c.env.ADMIN_PASSWORD) {
    return jsonError("Wrong password", 401);
  }
  const token = await issueSession(c.env);
  return c.json({ token });
});

// ---------------------------------------------------------------------------
// Admin: envelopes
// ---------------------------------------------------------------------------
const admin = new Hono();
admin.use("*", requireAdmin);

admin.post("/envelopes", async (c) => {
  const form = await c.req.formData();
  const title = form.get("title") || "Untitled document";
  const message = form.get("message") || "";
  const senderName = form.get("senderName") || "";
  const senderEmail = form.get("senderEmail") || "";
  const file = form.get("file");
  const recipients = JSON.parse(form.get("recipients") || "[]");
  const fields = JSON.parse(form.get("fields") || "[]");

  if (!file) return jsonError("Missing PDF file");
  if (!recipients.length) return jsonError("Add at least one recipient");

  const envelopeId = uuid();
  const originalBytes = new Uint8Array(await file.arrayBuffer());
  const originalKey = `envelopes/${envelopeId}/original.pdf`;
  await c.env.FILES.put(originalKey, originalBytes, { httpMetadata: { contentType: "application/pdf" } });

  // Load once to validate the file is a real PDF and grab a page count.
  const doc = await PDFDocument.load(originalBytes).catch(() => null);
  if (!doc) return jsonError("That file doesn't look like a valid PDF");
  const pageCount = doc.getPageCount();

  const db = c.env.DB;
  await db
    .prepare(
      `INSERT INTO envelopes (id, title, status, original_key, page_count, sender_name, sender_email, message)
       VALUES (?, ?, 'draft', ?, ?, ?, ?, ?)`
    )
    .bind(envelopeId, title, originalKey, pageCount, senderName, senderEmail, message)
    .run();

  const recipientIdByIndex = [];
  for (const r of recipients) {
    const id = uuid();
    recipientIdByIndex.push(id);
    await db
      .prepare(
        `INSERT INTO recipients (id, envelope_id, name, email, role, sign_order, token, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`
      )
      .bind(id, envelopeId, r.name, r.email, r.role || "signer", r.order ?? 1, newToken())
      .run();
  }

  for (const f of fields) {
    const recipientId = recipientIdByIndex[f.recipientIndex];
    if (!recipientId) continue;
    await db
      .prepare(
        `INSERT INTO fields (id, envelope_id, recipient_id, type, page, x, y, w, h, required, label)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(uuid(), envelopeId, recipientId, f.type, f.page, f.x, f.y, f.w, f.h, f.required ? 1 : 0, f.label || "")
      .run();
  }

  await logEvent(db, envelopeId, null, "created", `${recipients.length} recipient(s), ${fields.length} field(s)`);

  const sendNow = form.get("sendNow") !== "false";
  if (sendNow) {
    await sendToNextGroup(c.env, envelopeId, { justCreated: true });
  }

  return c.json({ id: envelopeId });
});

admin.get("/envelopes", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT e.*,
       (SELECT COUNT(*) FROM recipients r WHERE r.envelope_id = e.id) as recipient_count,
       (SELECT COUNT(*) FROM recipients r WHERE r.envelope_id = e.id AND r.status = 'signed') as signed_count
     FROM envelopes e ORDER BY e.created_at DESC`
  ).all();
  return c.json({ envelopes: results });
});

admin.get("/envelopes/:id", async (c) => {
  const data = await getEnvelopeFull(c.env.DB, c.req.param("id"));
  if (!data) return jsonError("Not found", 404);
  return c.json(data);
});

admin.post("/envelopes/:id/void", async (c) => {
  const id = c.req.param("id");
  await c.env.DB.prepare(`UPDATE envelopes SET status = 'voided', voided_at = ? WHERE id = ?`)
    .bind(nowIso(), id)
    .run();
  await logEvent(c.env.DB, id, null, "voided", "");
  return c.json({ ok: true });
});

admin.post("/envelopes/:id/remind/:recipientId", async (c) => {
  const { id, recipientId } = c.req.param();
  const env = c.env;
  const envelope = await env.DB.prepare(`SELECT * FROM envelopes WHERE id = ?`).bind(id).first();
  const recipient = await env.DB.prepare(`SELECT * FROM recipients WHERE id = ?`).bind(recipientId).first();
  if (!envelope || !recipient) return jsonError("Not found", 404);
  const signUrl = `${env.APP_URL}/sign?t=${recipient.token}`;
  await sendSigningInvite(env, { envelope, recipient, signUrl });
  await logEvent(env.DB, id, recipient.id, "reminded", "");
  return c.json({ ok: true });
});

admin.get("/envelopes/:id/download", async (c) => {
  const envelope = await c.env.DB.prepare(`SELECT * FROM envelopes WHERE id = ?`).bind(c.req.param("id")).first();
  if (!envelope) return jsonError("Not found", 404);
  const key = envelope.final_key || envelope.original_key;
  const obj = await c.env.FILES.get(key);
  if (!obj) return jsonError("File missing", 404);
  return new Response(obj.body, { headers: { "content-type": "application/pdf" } });
});

app.route("/api/admin", admin);

// ---------------------------------------------------------------------------
// Public: signer flow (token-gated, no login)
// ---------------------------------------------------------------------------
app.get("/api/sign/:token", async (c) => {
  const token = c.req.param("token");
  const db = c.env.DB;
  const recipient = await db.prepare(`SELECT * FROM recipients WHERE token = ?`).bind(token).first();
  if (!recipient) return jsonError("Invalid or expired link", 404);
  const envelope = await db.prepare(`SELECT * FROM envelopes WHERE id = ?`).bind(recipient.envelope_id).first();
  if (!envelope) return jsonError("Not found", 404);

  if (recipient.status === "pending" || recipient.status === "notified") {
    await db
      .prepare(`UPDATE recipients SET status = 'viewed', viewed_at = ? WHERE id = ?`)
      .bind(nowIso(), recipient.id)
      .run();
    await logEvent(db, envelope.id, recipient.id, "viewed", "");
    await sendViewedNotice(c.env, { envelope, recipient });
  }

  const { results: fields } = await db
    .prepare(`SELECT * FROM fields WHERE recipient_id = ? ORDER BY page, y`)
    .bind(recipient.id)
    .all();

  const { results: allRecipients } = await db
    .prepare(`SELECT name, role, sign_order, status FROM recipients WHERE envelope_id = ? ORDER BY sign_order`)
    .bind(envelope.id)
    .all();

  return c.json({
    envelope: { id: envelope.id, title: envelope.title, message: envelope.message, page_count: envelope.page_count, status: envelope.status },
    recipient: { id: recipient.id, name: recipient.name, email: recipient.email, role: recipient.role, status: recipient.status },
    fields,
    otherRecipients: allRecipients,
    pdfUrl: `/api/sign/${token}/pdf`,
  });
});

app.get("/api/sign/:token/pdf", async (c) => {
  const token = c.req.param("token");
  const recipient = await c.env.DB.prepare(`SELECT * FROM recipients WHERE token = ?`).bind(token).first();
  if (!recipient) return jsonError("Invalid link", 404);
  const envelope = await c.env.DB.prepare(`SELECT * FROM envelopes WHERE id = ?`).bind(recipient.envelope_id).first();
  const obj = await c.env.FILES.get(envelope.original_key);
  if (!obj) return jsonError("File missing", 404);
  return new Response(obj.body, { headers: { "content-type": "application/pdf" } });
});

app.post("/api/sign/:token/decline", async (c) => {
  const token = c.req.param("token");
  const { reason } = await c.req.json().catch(() => ({}));
  const db = c.env.DB;
  const recipient = await db.prepare(`SELECT * FROM recipients WHERE token = ?`).bind(token).first();
  if (!recipient) return jsonError("Invalid link", 404);
  const envelope = await db.prepare(`SELECT * FROM envelopes WHERE id = ?`).bind(recipient.envelope_id).first();

  await db
    .prepare(`UPDATE recipients SET status = 'declined', declined_at = ?, decline_reason = ? WHERE id = ?`)
    .bind(nowIso(), reason || "", recipient.id)
    .run();
  await db.prepare(`UPDATE envelopes SET status = 'declined' WHERE id = ?`).bind(envelope.id).run();
  await logEvent(db, envelope.id, recipient.id, "declined", reason || "");
  await sendDeclinedNotice(c.env, { envelope, recipient, reason });
  return c.json({ ok: true });
});

app.post("/api/sign/:token", async (c) => {
  const token = c.req.param("token");
  const body = await c.req.json().catch(() => null);
  if (!body) return jsonError("Bad request");
  const db = c.env.DB;

  const recipient = await db.prepare(`SELECT * FROM recipients WHERE token = ?`).bind(token).first();
  if (!recipient) return jsonError("Invalid or expired link", 404);
  if (recipient.status === "signed") return jsonError("You've already signed this document");

  const envelope = await db.prepare(`SELECT * FROM envelopes WHERE id = ?`).bind(recipient.envelope_id).first();
  if (!envelope || ["voided", "declined", "completed"].includes(envelope.status)) {
    return jsonError("This document is no longer available for signing");
  }

  const { results: myFields } = await db
    .prepare(`SELECT * FROM fields WHERE recipient_id = ?`)
    .bind(recipient.id)
    .all();

  const values = body.values || {}; // { [fieldId]: { text?: string, image?: base64 } }
  for (const f of myFields) {
    const v = values[f.id];
    if (f.required && (!v || (!v.text && !v.image))) {
      return jsonError(`Missing required field: ${f.label || f.type}`);
    }
  }

  for (const f of myFields) {
    const v = values[f.id];
    if (!v) continue;
    await db
      .prepare(
        `INSERT INTO field_values (field_id, value_text, value_image, filled_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(field_id) DO UPDATE SET value_text = excluded.value_text, value_image = excluded.value_image, filled_at = excluded.filled_at`
      )
      .bind(f.id, v.text || null, v.image || null, nowIso())
      .run();
  }

  const ipHash = await hashIp(c.req.raw);
  await db
    .prepare(
      `UPDATE recipients SET status = 'signed', signed_at = ?, ip_hash = ?, user_agent = ? WHERE id = ?`
    )
    .bind(nowIso(), ipHash, c.req.header("User-Agent") || "", recipient.id)
    .run();
  await logEvent(db, envelope.id, recipient.id, "signed", "");
  await sendSignedNotice(c.env, { envelope, recipient });

  await sendToNextGroup(c.env, envelope.id, {});

  return c.json({ ok: true });
});

app.get("/api/sign/:token/final", async (c) => {
  const token = c.req.param("token");
  const recipient = await c.env.DB.prepare(`SELECT * FROM recipients WHERE token = ?`).bind(token).first();
  if (!recipient) return jsonError("Invalid link", 404);
  const envelope = await c.env.DB.prepare(`SELECT * FROM envelopes WHERE id = ?`).bind(recipient.envelope_id).first();
  if (!envelope?.final_key) return jsonError("Not ready yet", 404);
  const obj = await c.env.FILES.get(envelope.final_key);
  if (!obj) return jsonError("File missing", 404);
  return new Response(obj.body, { headers: { "content-type": "application/pdf" } });
});

// Anything else under /api/* that didn't match above is a genuine 404 — Cloudflare
// already serves every real static file in ./public before the Worker ever runs
// (see the [assets] block in wrangler.toml), so we don't need a manual fallback here.
app.notFound((c) => jsonError("Not found", 404));

// -----------------------------------------------------------------------------
// Shared helpers
// -----------------------------------------------------------------------------

async function logEvent(db, envelopeId, recipientId, event, detail) {
  await db
    .prepare(`INSERT INTO audit_events (id, envelope_id, recipient_id, event, detail) VALUES (?, ?, ?, ?, ?)`)
    .bind(uuid(), envelopeId, recipientId || null, event, detail || "")
    .run();
}

async function getEnvelopeFull(db, id) {
  const envelope = await db.prepare(`SELECT * FROM envelopes WHERE id = ?`).bind(id).first();
  if (!envelope) return null;
  const { results: recipients } = await db
    .prepare(`SELECT * FROM recipients WHERE envelope_id = ? ORDER BY sign_order, name`)
    .bind(id)
    .all();
  const { results: fields } = await db.prepare(`SELECT * FROM fields WHERE envelope_id = ?`).bind(id).all();
  const { results: audit } = await db
    .prepare(`SELECT * FROM audit_events WHERE envelope_id = ? ORDER BY created_at`)
    .bind(id)
    .all();
  return { envelope, recipients, fields, audit };
}

/**
 * Determines who should be notified next given current sign_order progress,
 * sends their invite emails, and — if every signer/approver has now signed —
 * flattens the final PDF, appends the certificate page, stores it, marks the
 * envelope completed, and emails everyone the finished document.
 */
async function sendToNextGroup(env, envelopeId, { justCreated } = {}) {
  const db = env.DB;
  const envelope = await db.prepare(`SELECT * FROM envelopes WHERE id = ?`).bind(envelopeId).first();
  const { results: recipients } = await db
    .prepare(`SELECT * FROM recipients WHERE envelope_id = ? ORDER BY sign_order`)
    .bind(envelopeId)
    .all();

  const signers = recipients.filter((r) => r.role !== "cc");
  const allSigned = signers.every((r) => r.status === "signed");

  if (allSigned) {
    await completeEnvelope(env, envelope, recipients);
    return;
  }

  const pendingSigners = signers.filter((r) => r.status !== "signed" && r.status !== "declined");
  if (!pendingSigners.length) return;
  const nextOrder = Math.min(...pendingSigners.map((r) => r.sign_order));
  const dueNow = pendingSigners.filter((r) => r.sign_order === nextOrder && (justCreated ? true : r.status === "pending"));

  // On creation, notify the whole first group. On subsequent calls, only notify
  // recipients in the now-current group who haven't been notified yet.
  const toNotify = justCreated
    ? recipients.filter((r) => r.role !== "cc" && r.sign_order === nextOrder)
    : dueNow.filter((r) => r.status === "pending");

  for (const recipient of toNotify) {
    const signUrl = `${env.APP_URL}/sign?t=${recipient.token}`;
    await sendSigningInvite(env, { envelope, recipient, signUrl });
    await db
      .prepare(`UPDATE recipients SET status = 'notified', notified_at = ? WHERE id = ?`)
      .bind(nowIso(), recipient.id)
      .run();
    await logEvent(db, envelopeId, recipient.id, "sent", `order ${recipient.sign_order}`);
  }

  if (justCreated) {
    await db
      .prepare(`UPDATE envelopes SET status = 'sent', sent_at = ? WHERE id = ?`)
      .bind(nowIso(), envelopeId)
      .run();
  } else {
    await db.prepare(`UPDATE envelopes SET status = 'partially_signed' WHERE id = ?`).bind(envelopeId).run();
  }
}

async function completeEnvelope(env, envelope, recipients) {
  const db = env.DB;
  const originalObj = await env.FILES.get(envelope.original_key);
  const originalBytes = new Uint8Array(await originalObj.arrayBuffer());

  const { results: fields } = await db.prepare(`SELECT * FROM fields WHERE envelope_id = ?`).bind(envelope.id).all();
  const { results: values } = await db
    .prepare(
      `SELECT fv.* FROM field_values fv JOIN fields f ON f.id = fv.field_id WHERE f.envelope_id = ?`
    )
    .bind(envelope.id)
    .all();
  const valueByField = Object.fromEntries(values.map((v) => [v.field_id, v]));
  const fieldsWithValues = fields.map((f) => ({ ...f, value: valueByField[f.id] }));

  let flattened = await flattenEnvelope({ originalBytes, fields: fieldsWithValues });

  const { results: audit } = await db
    .prepare(`SELECT * FROM audit_events WHERE envelope_id = ? ORDER BY created_at`)
    .bind(envelope.id)
    .all();
  flattened = await appendCertificatePage(flattened, {
    envelope: { ...envelope, completed_at: nowIso() },
    recipients,
    auditEvents: audit,
  });

  const finalKey = `envelopes/${envelope.id}/final.pdf`;
  await env.FILES.put(finalKey, flattened, { httpMetadata: { contentType: "application/pdf" } });

  await db
    .prepare(`UPDATE envelopes SET status = 'completed', completed_at = ?, final_key = ? WHERE id = ?`)
    .bind(nowIso(), finalKey, envelope.id)
    .run();
  await logEvent(db, envelope.id, null, "completed", "");

  // Email everyone the finished packet. Each recipient gets a link tied to their
  // own token; the sender (who has no token of their own) reuses the first
  // recipient's — the /final route accepts any valid token for this envelope.
  const finalUrl = (token) => `${env.APP_URL}/api/sign/${token}/final`;
  const sent = new Set();
  for (const r of recipients) {
    if (!r.email || sent.has(r.email)) continue;
    sent.add(r.email);
    await sendCompletedPacket(env, { envelope, downloadUrl: finalUrl(r.token), to: r.email });
  }
  if (envelope.sender_email && !sent.has(envelope.sender_email)) {
    await sendCompletedPacket(env, { envelope, downloadUrl: finalUrl(recipients[0]?.token || ""), to: envelope.sender_email });
  }
}

export default app;
