const ALLOWED_ROLES = new Set(["signer", "approver", "cc"]);
const ALLOWED_FIELD_TYPES = new Set(["signature", "initials", "date", "text", "checkbox"]);

export const MAX_ENVELOPE_PDF_BYTES = 50 * 1024 * 1024;
export const MAX_SIGNATURE_DATA_URL_LENGTH = 3 * 1024 * 1024;

export class ValidationError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = "ValidationError";
    this.status = status;
  }
}

export function parseJsonArray(value, label) {
  let parsed;
  try {
    parsed = JSON.parse(String(value || "[]"));
  } catch {
    throw new ValidationError(`${label} must be valid JSON`);
  }
  if (!Array.isArray(parsed)) throw new ValidationError(`${label} must be an array`);
  return parsed;
}

function cleanString(value, label, maxLength, { required = false } = {}) {
  const cleaned = String(value ?? "").trim();
  if (required && !cleaned) throw new ValidationError(`${label} is required`);
  if (cleaned.length > maxLength) throw new ValidationError(`${label} is too long`);
  return cleaned;
}

function cleanEmail(value, label) {
  const email = cleanString(value, label, 254, { required: true });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new ValidationError(`${label} must be a valid email address`);
  }
  return email;
}

export function validateEnvelopeMetadata(input) {
  const recipients = input.recipients;
  if (!recipients.length) throw new ValidationError("Add at least one recipient");
  if (recipients.length > 50) throw new ValidationError("An envelope can have at most 50 recipients");

  const normalizedRecipients = recipients.map((recipient, index) => {
    if (!recipient || typeof recipient !== "object") {
      throw new ValidationError(`Recipient ${index + 1} is invalid`);
    }
    const role = String(recipient.role || "signer");
    if (!ALLOWED_ROLES.has(role)) {
      throw new ValidationError(`Recipient ${index + 1} has an invalid role`);
    }
    const order = Number(recipient.order ?? 1);
    if (!Number.isInteger(order) || order < 1 || order > 1000) {
      throw new ValidationError(`Recipient ${index + 1} has an invalid order`);
    }
    return {
      name: cleanString(recipient.name, `Recipient ${index + 1} name`, 160, { required: true }),
      email: cleanEmail(recipient.email, `Recipient ${index + 1} email`),
      role,
      order,
    };
  });
  if (!normalizedRecipients.some((recipient) => recipient.role !== "cc")) {
    throw new ValidationError("Add at least one signer or approver");
  }

  return {
    title: cleanString(input.title || "Untitled document", "Title", 240, { required: true }),
    message: cleanString(input.message, "Message", 5000),
    senderName: cleanString(input.senderName, "Sender name", 160),
    senderEmail: input.senderEmail ? cleanEmail(input.senderEmail, "Sender email") : "",
    recipients: normalizedRecipients,
  };
}

export function validateEnvelopeFields(fields, recipients, pageCount) {
  if (fields.length > 2000) throw new ValidationError("An envelope can have at most 2,000 fields");

  return fields.map((field, index) => {
    if (!field || typeof field !== "object") {
      throw new ValidationError(`Field ${index + 1} is invalid`);
    }
    const type = String(field.type || "");
    if (!ALLOWED_FIELD_TYPES.has(type)) {
      throw new ValidationError(`Field ${index + 1} has an invalid type`);
    }
    const recipientIndex = Number(field.recipientIndex);
    if (!Number.isInteger(recipientIndex) || !recipients[recipientIndex]) {
      throw new ValidationError(`Field ${index + 1} has an invalid recipient`);
    }
    const page = Number(field.page);
    if (!Number.isInteger(page) || page < 0 || page >= pageCount) {
      throw new ValidationError(`Field ${index + 1} has an invalid page`);
    }
    const coords = Object.fromEntries(["x", "y", "w", "h"].map((key) => [key, Number(field[key])]));
    if (Object.values(coords).some((value) => !Number.isFinite(value))) {
      throw new ValidationError(`Field ${index + 1} has invalid coordinates`);
    }
    if (
      coords.x < 0 ||
      coords.y < 0 ||
      coords.w <= 0 ||
      coords.h <= 0 ||
      coords.x + coords.w > 1 ||
      coords.y + coords.h > 1
    ) {
      throw new ValidationError(`Field ${index + 1} must fit within its page`);
    }
    return {
      recipientIndex,
      type,
      page,
      ...coords,
      required: field.required !== false,
      label: cleanString(field.label || type, `Field ${index + 1} label`, 160),
    };
  });
}

export function validateSubmittedValue(field, value) {
  if (!value || typeof value !== "object") return null;

  if (field.type === "signature" || field.type === "initials") {
    const image = String(value.image || "");
    if (!/^data:image\/(?:png|jpe?g);base64,[A-Za-z0-9+/=]+$/i.test(image)) {
      throw new ValidationError(`Invalid ${field.type} image`);
    }
    if (image.length > MAX_SIGNATURE_DATA_URL_LENGTH) {
      throw new ValidationError(`${field.type === "signature" ? "Signature" : "Initials"} image is too large`, 413);
    }
    return { image };
  }

  const text = String(value.text ?? "");
  if (text.length > 10000) throw new ValidationError(`${field.label || field.type} is too long`, 413);
  if (field.type === "checkbox" && !["true", "false"].includes(text)) {
    throw new ValidationError("Invalid checkbox value");
  }
  return { text };
}
