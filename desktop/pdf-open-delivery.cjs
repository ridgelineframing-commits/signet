function normalizePdfPayload(payload) {
  if (!payload || typeof payload.name !== "string" || !payload.name.trim()) return null;

  const bytes = payload.bytes;
  if (bytes instanceof ArrayBuffer) {
    return { name: payload.name, bytes: new Uint8Array(bytes) };
  }
  if (ArrayBuffer.isView(bytes)) {
    return {
      name: payload.name,
      bytes: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    };
  }
  return null;
}

function createPdfOpenDelivery() {
  let callback = null;
  const pending = [];

  function receive(payload) {
    const normalized = normalizePdfPayload(payload);
    if (!normalized) return false;
    if (callback) callback(normalized);
    else pending.push(normalized);
    return true;
  }

  function subscribe(nextCallback) {
    if (typeof nextCallback !== "function") return false;
    callback = nextCallback;
    for (const payload of pending.splice(0)) callback(payload);
    return true;
  }

  return { receive, subscribe };
}

module.exports = { createPdfOpenDelivery, normalizePdfPayload };
