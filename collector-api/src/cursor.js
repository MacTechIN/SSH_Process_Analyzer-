import { createHmac, timingSafeEqual } from "node:crypto";

const CURSOR_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

function mac(body, secret) {
  return createHmac("sha256", secret).update(body).digest("base64url");
}

export function signCursor(payload, { secret, keyId }) {
  if (!secret) {
    throw new Error("cursor signing secret is required");
  }
  const body = Buffer.from(JSON.stringify({ ...payload, kid: keyId }), "utf8").toString("base64url");
  return `${body}.${mac(body, secret)}`;
}

// Every field the server put into the cursor is re-checked against the current request,
// so a cursor cannot be moved to another user, tenant, host, filter, or page size.
export function verifyCursor(cursor, { secret, nowMs, expected }) {
  if (typeof cursor !== "string" || !CURSOR_PATTERN.test(cursor)) {
    return { valid: false, reason: "malformed" };
  }
  const [body, signature] = cursor.split(".");
  const expectedMac = Buffer.from(mac(body, secret), "utf8");
  const providedMac = Buffer.from(signature, "utf8");
  if (expectedMac.length !== providedMac.length || !timingSafeEqual(expectedMac, providedMac)) {
    return { valid: false, reason: "signature" };
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return { valid: false, reason: "malformed" };
  }
  if (!payload.expiresAt || Date.parse(payload.expiresAt) <= nowMs) {
    return { valid: false, reason: "expired" };
  }
  for (const [field, value] of Object.entries(expected)) {
    if (payload[field] !== value) {
      return { valid: false, reason: `mismatch:${field}` };
    }
  }
  return { valid: true, payload };
}
