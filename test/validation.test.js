import assert from "node:assert/strict";
import test from "node:test";

import {
  ValidationError,
  parseJsonArray,
  validateEnvelopeFields,
  validateEnvelopeMetadata,
  validateSubmittedValue,
} from "../worker/lib/validation.js";

const recipients = [{ name: "Ada Lovelace", email: "ada@example.com", role: "signer", order: 1 }];

test("parseJsonArray rejects malformed or non-array payloads", () => {
  assert.throws(() => parseJsonArray("{", "Recipients"), ValidationError);
  assert.throws(() => parseJsonArray("{}", "Recipients"), /must be an array/);
});

test("envelope metadata is trimmed and normalized", () => {
  const result = validateEnvelopeMetadata({
    title: "  Contract  ",
    message: " Hello ",
    senderName: " Sender ",
    senderEmail: "sender@example.com",
    recipients,
  });
  assert.equal(result.title, "Contract");
  assert.equal(result.recipients[0].role, "signer");
  assert.equal(result.recipients[0].order, 1);
});

test("envelope metadata requires a signer or approver", () => {
  assert.throws(
    () => validateEnvelopeMetadata({ title: "FYI", recipients: [{ ...recipients[0], role: "cc" }] }),
    /signer or approver/
  );
});

test("fields must use known types and fit within a real page", () => {
  const valid = validateEnvelopeFields(
    [{ recipientIndex: 0, type: "signature", page: 0, x: 0.7, y: 0.8, w: 0.3, h: 0.2 }],
    recipients,
    1
  );
  assert.equal(valid[0].label, "signature");
  assert.throws(
    () => validateEnvelopeFields([{ ...valid[0], recipientIndex: 0, x: 0.71 }], recipients, 1),
    /fit within/
  );
  assert.throws(
    () => validateEnvelopeFields([{ ...valid[0], recipientIndex: 0, type: "script" }], recipients, 1),
    /invalid type/
  );
});

test("submitted signatures must be real bounded image data URLs", () => {
  const field = { type: "signature", label: "Signature" };
  const value = validateSubmittedValue(field, { image: "data:image/png;base64,aGVsbG8=" });
  assert.match(value.image, /^data:image\/png/);
  assert.throws(() => validateSubmittedValue(field, { image: "data:text/html;base64,PGgxPg==" }), /Invalid signature/);
});

test("checkbox and text values are normalized and bounded", () => {
  assert.deepEqual(validateSubmittedValue({ type: "checkbox" }, { text: false }), { text: "false" });
  assert.throws(() => validateSubmittedValue({ type: "checkbox" }, { text: "yes" }), /Invalid checkbox/);
  assert.throws(() => validateSubmittedValue({ type: "text", label: "Notes" }, { text: "x".repeat(10001) }), /too long/);
});
