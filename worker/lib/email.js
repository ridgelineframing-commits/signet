// Email delivery via Resend (https://resend.com). Free tier is plenty for this volume.
// Requires two secrets: RESEND_API_KEY and MAIL_FROM (a verified sender, e.g.
// "Signet <sign@mail.ridgeline.construction>").

async function send(env, { to, subject, html }) {
  if (!env.RESEND_API_KEY) {
    console.warn("RESEND_API_KEY not set — skipping email send:", subject, "->", to);
    return { skipped: true };
  }
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from: env.MAIL_FROM || "Signet <onboarding@resend.dev>",
        to,
        subject,
        html,
      }),
    });
    if (!res.ok) console.error("Resend send failed:", res.status, await res.text().catch(() => ""));
    return { ok: res.ok };
  } catch (e) {
    // Never let a mail outage bubble up and 500 a request — signing/OTP routes must still respond.
    console.error("Resend send threw:", e?.message || e);
    return { ok: false, error: String(e?.message || e) };
  }
}

// Escape any value that lands in an HTML email body. Several of these come from
// untrusted input — a signer types the decline reason, and recipient names/emails
// originate outside the app — so they must never be interpolated raw.
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const button = (url, label) =>
  `<a href="${encodeURI(url)}" style="display:inline-block;background:#6A4CF0;color:#fff;padding:12px 22px;border-radius:6px;text-decoration:none;font-weight:600;font-family:sans-serif">${esc(label)}</a>`;

const wrap = (body) => `
  <div style="font-family:Segoe UI,Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#1a2b3c">
    ${body}
    <p style="margin-top:32px;font-size:12px;color:#8a97a3">Sent via Signet — secure document signing.</p>
  </div>`;

export async function sendSigningInvite(env, { envelope, recipient, signUrl }) {
  const html = wrap(`
    <h2 style="margin-bottom:4px">${esc(envelope.sender_name || "Someone")} sent you a document to sign</h2>
    <p style="color:#4a5a68">${esc(envelope.title)}</p>
    ${envelope.message ? `<p style="background:#f4f6f8;padding:12px;border-radius:6px">${esc(envelope.message)}</p>` : ""}
    <p>${button(signUrl, "Review & Sign")}</p>
    <p style="font-size:13px;color:#8a97a3">This link is unique to you — please don't forward it.</p>
  `);
  return send(env, { to: recipient.email, subject: `Please sign: ${envelope.title}`, html });
}

export async function sendViewedNotice(env, { envelope, recipient }) {
  if (!envelope.sender_email) return;
  const html = wrap(`
    <p><strong>${esc(recipient.name)}</strong> opened <strong>${esc(envelope.title)}</strong>.</p>
  `);
  return send(env, { to: envelope.sender_email, subject: `Viewed: ${envelope.title}`, html });
}

export async function sendSignedNotice(env, { envelope, recipient }) {
  if (!envelope.sender_email) return;
  const html = wrap(`
    <p><strong>${esc(recipient.name)}</strong> signed <strong>${esc(envelope.title)}</strong>.</p>
  `);
  return send(env, { to: envelope.sender_email, subject: `Signed: ${envelope.title}`, html });
}

export async function sendDeclinedNotice(env, { envelope, recipient, reason }) {
  if (!envelope.sender_email) return;
  const html = wrap(`
    <p><strong>${esc(recipient.name)}</strong> declined to sign <strong>${esc(envelope.title)}</strong>.</p>
    ${reason ? `<p style="color:#8a2b2b">Reason: ${esc(reason)}</p>` : ""}
  `);
  return send(env, { to: envelope.sender_email, subject: `Declined: ${envelope.title}`, html });
}

export async function sendOtpCode(env, { envelope, recipient, code }) {
  const html = wrap(`
    <h2 style="margin-bottom:4px">Your verification code</h2>
    <p style="color:#4a5a68">Enter this code to sign <strong>${esc(envelope.title)}</strong>:</p>
    <p style="font-size:30px;font-weight:700;letter-spacing:6px;margin:18px 0">${esc(code)}</p>
    <p style="font-size:13px;color:#8a97a3">The code expires in 10 minutes. If you didn't request it, you can ignore this email.</p>
  `);
  return send(env, { to: recipient.email, subject: `Your code to sign: ${envelope.title}`, html });
}

export async function sendCompletedPacket(env, { envelope, downloadUrl, to }) {
  const html = wrap(`
    <h2>All parties have signed</h2>
    <p><strong>${esc(envelope.title)}</strong> is complete.</p>
    <p>${button(downloadUrl, "Download signed PDF")}</p>
  `);
  return send(env, { to, subject: `Completed: ${envelope.title}`, html });
}
