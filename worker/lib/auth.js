// Minimal single-user auth for the sender dashboard.
// One shared ADMIN_PASSWORD (set via `wrangler secret put ADMIN_PASSWORD`) gates access;
// on success we hand back an HMAC-signed session token the frontend stores in localStorage
// and sends back as `Authorization: Bearer <token>`. No user table, no OAuth — this is a
// single-tenant tool for your own team, not a multi-customer SaaS.

async function hmac(secret, message) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function issueSession(env) {
  const issuedAt = Date.now();
  const payload = `${issuedAt}`;
  const sig = await hmac(env.SESSION_SECRET, payload);
  return `${payload}.${sig}`;
}

export async function verifySession(env, token) {
  if (!token) return false;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return false;
  const expected = await hmac(env.SESSION_SECRET, payload);
  if (expected !== sig) return false;
  const issuedAt = Number(payload);
  const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
  return Date.now() - issuedAt < THIRTY_DAYS;
}

export function getBearer(request) {
  const h = request.headers.get("Authorization") || "";
  return h.startsWith("Bearer ") ? h.slice(7) : null;
}

// Hono middleware: protects every /api/admin/* route.
export async function requireAdmin(c, next) {
  const token = getBearer(c.req.raw);
  const ok = await verifySession(c.env, token);
  if (!ok) return c.json({ error: "Not authenticated" }, 401);
  await next();
}
