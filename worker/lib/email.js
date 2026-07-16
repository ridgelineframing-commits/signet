// Email delivery via Resend (https://resend.com). Free tier is plenty for this volume.
// Requires two secrets: RESEND_API_KEY and MAIL_FROM (a verified sender, e.g.
// "Signet <sign@mail.ridgeline.construction>").

async function send(env, { to, subject, html }) {
  if (!env.RESEND_API_KEY) {
    console.warn("RESEND_API_KEY not set — skipping email send:", subject, "->", to);
    return { skipped: true };
  }
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
  if (!res.ok) {
    const text = await res.text();
    console.error("Resend send failed:", res.status, text);
  }
  return res;
}

const button = (url, label) =>
  `<a href="${url}" style="display:inline-block;background:#1a2b3c;color:#fff;padding:12px 22px;border-radius:6px;text-decoration:none;font-weight:600;font-family:sans-serif">${label}</a>`;

const wrap = (body) => `
  <div style="font-family:Segoe UI,Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#1a2b3c">
    ${body}
    <p style="margin-top:32px;font-size:12px;color:#8a97a3">Sent via Signet — secure document signing.</p>
  </div>`;

export async function sendSigningInvite(env, { envelope, recipient, signUrl }) {
  const html = wrap(`
    <h2 style="margin-bottom:4px">${envelope.sender_name || "Someone"} sent you a document to sign</h2>
    <p style="color:#4a5a68">${envelope.title}</p>
    ${envelope.message ? `<p style="background:#f4f6f8;padding:12px;border-radius:6px">${envelope.message}</p>` : ""}
    <p>${button(signUrl, "Review & Sign")}</p>
    <p style="font-size:13px;color:#8a97a3">This link is unique to you — please don't forward it.</p>
  `);
  return send(env, { to: recipient.email, subject: `Please sign: ${envelope.title}`, html });
}

export async function sendViewedNotice(env, { envelope, recipient }) {
  if (!envelope.sender_email) return;
  const html = wrap(`
    <p><strong>${recipient.name}</strong> opened <strong>${envelope.title}</strong>.</p>
  `);
  return send(env, { to: envelope.sender_email, subject: `Viewed: ${envelope.title}`, html });
}

export async function sendSignedNotice(env, { envelope, recipient }) {
  if (!envelope.sender_email) return;
  const html = wrap(`
    <p><strong>${recipient.name}</strong> signed <strong>${envelope.title}</strong>.</p>
  `);
  return send(env, { to: envelope.sender_email, subject: `Signed: ${envelope.title}`, html });
}

export async function sendDeclinedNotice(env, { envelope, recipient, reason }) {
  if (!envelope.sender_email) return;
  const html = wrap(`
    <p><strong>${recipient.name}</strong> declined to sign <strong>${envelope.title}</strong>.</p>
    ${reason ? `<p style="color:#8a2b2b">Reason: ${reason}</p>` : ""}
  `);
  return send(env, { to: envelope.sender_email, subject: `Declined: ${envelope.title}`, html });
}

export async function sendCompletedPacket(env, { envelope, downloadUrl, to }) {
  const html = wrap(`
    <h2>All parties have signed</h2>
    <p><strong>${envelope.title}</strong> is complete.</p>
    <p>${button(downloadUrl, "Download signed PDF")}</p>
  `);
  return send(env, { to, subject: `Completed: ${envelope.title}`, html });
}
