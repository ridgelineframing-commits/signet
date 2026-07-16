// Server-side PDF stamping — runs in the Worker with pdf-lib (pure JS, no native deps,
// so it works fine on the Workers runtime). Field coordinates are stored as fractions
// (0-1) of page width/height with y measured from the TOP of the page (how the frontend
// draws them over a pdf.js canvas); pdf-lib's origin is bottom-left, so we flip y here.

import { PDFDocument, rgb, StandardFonts } from "pdf-lib";
import { base64ToBytes, bytesToBase64 } from "./util.js";

function toPdfBox(page, field) {
  const { width, height } = page.getSize();
  const x = field.x * width;
  const w = field.w * width;
  const h = field.h * height;
  const yTop = field.y * height;
  const y = height - yTop - h; // flip to bottom-left origin
  return { x, y, w, h };
}

async function drawField(pdfDoc, page, field, value, font) {
  const { x, y, w, h } = toPdfBox(page, field);

  if (field.type === "signature" || field.type === "initials") {
    if (!value?.value_image) return;
    const bytes = base64ToBytes(value.value_image.replace(/^data:image\/\w+;base64,/, ""));
    let img;
    try {
      img = await pdfDoc.embedPng(bytes);
    } catch {
      img = await pdfDoc.embedJpg(bytes);
    }
    // Fit image inside the box, preserving aspect ratio, bottom-aligned.
    const scale = Math.min(w / img.width, h / img.height);
    const dw = img.width * scale;
    const dh = img.height * scale;
    page.drawImage(img, {
      x: x + (w - dw) / 2,
      y: y + (h - dh) / 2,
      width: dw,
      height: dh,
    });
    return;
  }

  if (field.type === "checkbox") {
    if (value?.value_text === "true" || value?.value_text === "on") {
      page.drawText("X", {
        x: x + w * 0.2,
        y: y + h * 0.15,
        size: Math.min(h * 0.8, 14),
        font,
        color: rgb(0.1, 0.1, 0.1),
      });
    }
    return;
  }

  // text / date
  const text = value?.value_text || "";
  const size = Math.min(h * 0.7, 12);
  page.drawText(text, {
    x: x + 2,
    y: y + h * 0.25,
    size,
    font,
    color: rgb(0.05, 0.05, 0.2),
    maxWidth: w - 4,
  });
}

/**
 * Stamp all filled fields for an envelope onto the original PDF and return the
 * flattened bytes. `fields` = rows from `fields` joined with `field_values`.
 */
export async function flattenEnvelope({ originalBytes, fields }) {
  const pdfDoc = await PDFDocument.load(originalBytes);
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const pages = pdfDoc.getPages();

  for (const field of fields) {
    const page = pages[field.page];
    if (!page) continue;
    await drawField(pdfDoc, page, field, field.value, font);
  }

  return pdfDoc.save();
}

/**
 * Appends a certificate-of-completion page summarizing every recipient's
 * signing event (name, email, role, timestamp, IP hash) — the audit trail
 * that makes a self-hosted e-sign flow defensible the way DocuSign's is.
 */
export async function appendCertificatePage(pdfBytes, { envelope, recipients, auditEvents }) {
  const pdfDoc = await PDFDocument.load(pdfBytes);
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const page = pdfDoc.addPage([612, 792]); // US letter
  const margin = 56;
  let y = 792 - margin;

  const line = (text, opts = {}) => {
    page.drawText(text, {
      x: margin,
      y,
      size: opts.size || 10,
      font: opts.bold ? bold : font,
      color: rgb(0.1, 0.1, 0.1),
    });
    y -= opts.gap || 16;
  };

  line("Certificate of Completion", { size: 18, bold: true, gap: 26 });
  line(`Document: ${envelope.title}`, { bold: true });
  line(`Envelope ID: ${envelope.id}`);
  line(`Completed: ${envelope.completed_at || new Date().toISOString()}`);
  y -= 10;
  line("Signers", { size: 13, bold: true, gap: 20 });

  for (const r of recipients) {
    line(`${r.name}  <${r.email}>  —  ${r.role}`, { bold: true, gap: 14 });
    line(`  Status: ${r.status}   Signed at: ${r.signed_at || "—"}`, { gap: 14 });
    line(`  IP hash: ${r.ip_hash || "—"}`, { gap: 20 });
  }

  y -= 10;
  line("Audit Trail", { size: 13, bold: true, gap: 20 });
  for (const e of auditEvents) {
    if (y < margin + 20) break; // simple single-page cert; trims if very long
    line(`${e.created_at}  —  ${e.event}${e.detail ? `  (${e.detail})` : ""}`, { size: 9, gap: 12 });
  }

  return pdfDoc.save();
}

export async function rasterizeInfo(bytes) {
  const pdfDoc = await PDFDocument.load(bytes);
  return { pageCount: pdfDoc.getPageCount() };
}

export { bytesToBase64 };
