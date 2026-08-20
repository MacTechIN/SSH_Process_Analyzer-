import assert from "node:assert/strict";
import test from "node:test";
import { signCursor, verifyCursor } from "../../collector-api/src/cursor.js";

const secret = "test-cursor-secret";
const nowMs = Date.parse("2026-08-18T00:00:00Z");

const expected = {
  uid: "user-1",
  tenantId: "tenant-a",
  hostId: "host-1",
  order: "capturedAt:desc",
  retentionCutoff: "2026-08-11T00:00:00Z",
  pageSize: 50
};

function cursorFor(overrides = {}) {
  return signCursor(
    {
      ...expected,
      last: { capturedAt: "2026-08-17T00:00:00Z", snapshotId: "snapshot-1" },
      issuedAt: "2026-08-18T00:00:00Z",
      expiresAt: "2026-08-18T00:15:00Z",
      ...overrides
    },
    { secret, keyId: "v1" }
  );
}

test("a cursor round trips when every bound field matches", () => {
  const verified = verifyCursor(cursorFor(), { secret, nowMs, expected });
  assert.equal(verified.valid, true);
  assert.deepEqual(verified.payload.last, { capturedAt: "2026-08-17T00:00:00Z", snapshotId: "snapshot-1" });
});

test("a tampered payload or signature is rejected", () => {
  const cursor = cursorFor();
  const [body, signature] = cursor.split(".");
  const forgedBody = Buffer.from(
    JSON.stringify({ ...expected, uid: "user-2", expiresAt: "2026-08-18T00:15:00Z" }),
    "utf8"
  ).toString("base64url");

  assert.equal(verifyCursor(`${forgedBody}.${signature}`, { secret, nowMs, expected }).reason, "signature");
  assert.equal(verifyCursor(`${body}.${"a".repeat(43)}`, { secret, nowMs, expected }).reason, "signature");
  assert.equal(verifyCursor("not-a-cursor", { secret, nowMs, expected }).reason, "malformed");
});

test("a cursor cannot be replayed with a different signing secret", () => {
  assert.equal(verifyCursor(cursorFor(), { secret: "rotated-secret", nowMs, expected }).valid, false);
});

test("a cursor cannot be moved to another user, tenant, host, filter, or page size", () => {
  const cursor = cursorFor();
  for (const [field, value] of Object.entries({
    uid: "user-2",
    tenantId: "tenant-b",
    hostId: "host-2",
    order: "capturedAt:asc",
    retentionCutoff: "2026-08-01T00:00:00Z",
    pageSize: 10
  })) {
    const verified = verifyCursor(cursor, { secret, nowMs, expected: { ...expected, [field]: value } });
    assert.equal(verified.valid, false, `${field} must be re-checked`);
    assert.equal(verified.reason, `mismatch:${field}`);
  }
});

test("an expired cursor is rejected", () => {
  const verified = verifyCursor(cursorFor(), {
    secret,
    nowMs: Date.parse("2026-08-18T00:20:00Z"),
    expected
  });
  assert.equal(verified.reason, "expired");
});
