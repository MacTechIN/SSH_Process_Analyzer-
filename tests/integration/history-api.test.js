import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../../collector-api/src/index.js";

const TENANT_ID = "tenant-a";
const HOST_ID = "host-1";
const SECRET = "test-cursor-secret";

const tokens = { "token-alice": { uid: "alice" }, "token-mallory": { uid: "mallory" } };

async function startApp(t, env = {}) {
  const app = createApp(
    { CURSOR_SIGNING_SECRET: SECRET, HISTORY_PAGE_SIZE_LIMIT: "3", ...env },
    {
      verifyIdToken: async (idToken) => {
        if (!tokens[idToken]) {
          throw new Error("invalid token");
        }
        return tokens[idToken];
      }
    }
  );
  app.store.seedMembership({ tenantId: TENANT_ID, uid: "alice", role: "viewer" });

  await new Promise((resolve) => app.server.listen(0, resolve));
  t.after(() => new Promise((resolve) => app.server.close(resolve)));
  return { app, origin: `http://127.0.0.1:${app.server.address().port}` };
}

function seedHistory(app, count, { expiresAt = "2099-01-01T00:00:00Z" } = {}) {
  for (let index = 0; index < count; index += 1) {
    const suffix = `${index}`.padStart(2, "0");
    app.store.seedSnapshotHistory({
      tenantId: TENANT_ID,
      hostId: HOST_ID,
      snapshotId: `snapshot-${suffix}`,
      agentId: "agent_01",
      capturedAt: `2026-08-17T10:${suffix}:00Z`,
      expiresAt,
      processCount: index,
      bodyHash: `hash-${suffix}`,
      published: true,
      storedAt: `2026-08-17T10:${suffix}:01Z`
    });
  }
}

async function history(origin, { token = "token-alice", query = "" } = {}) {
  const response = await fetch(`${origin}/v1/tenants/${TENANT_ID}/hosts/${HOST_ID}/snapshots${query}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {}
  });
  return { response, body: await response.json() };
}

test("requires a firebase auth id token", async (t) => {
  const { origin } = await startApp(t);

  assert.equal((await history(origin, { token: null })).response.status, 401);
  assert.equal((await history(origin, { token: "token-forged" })).body.code, "UNAUTHENTICATED");
});

test("returns 403 and no data for a uid without membership", async (t) => {
  const { app, origin } = await startApp(t);
  seedHistory(app, 2);

  const forbidden = await history(origin, { token: "token-mallory" });
  assert.equal(forbidden.response.status, 403);
  assert.equal(forbidden.body.code, "TENANT_FORBIDDEN");
  assert.equal(forbidden.body.snapshots, undefined);
});

test("pages newest first through a signed cursor", async (t) => {
  const { app, origin } = await startApp(t);
  seedHistory(app, 5);

  const first = await history(origin, { query: "?limit=2" });
  assert.equal(first.response.status, 200);
  assert.deepEqual(
    first.body.snapshots.map((snapshot) => snapshot.snapshotId),
    ["snapshot-04", "snapshot-03"]
  );
  assert.ok(first.body.nextCursor);

  const second = await history(origin, {
    query: `?limit=2&cursor=${encodeURIComponent(first.body.nextCursor)}`
  });
  assert.deepEqual(
    second.body.snapshots.map((snapshot) => snapshot.snapshotId),
    ["snapshot-02", "snapshot-01"]
  );

  const third = await history(origin, {
    query: `?limit=2&cursor=${encodeURIComponent(second.body.nextCursor)}`
  });
  assert.deepEqual(
    third.body.snapshots.map((snapshot) => snapshot.snapshotId),
    ["snapshot-00"]
  );
  assert.equal(third.body.nextCursor, null);
});

test("rejects a cursor reused with a different page size or host", async (t) => {
  const { app, origin } = await startApp(t);
  seedHistory(app, 5);
  const first = await history(origin, { query: "?limit=2" });

  const resized = await history(origin, {
    query: `?limit=3&cursor=${encodeURIComponent(first.body.nextCursor)}`
  });
  assert.equal(resized.response.status, 400);
  assert.equal(resized.body.code, "INVALID_CURSOR");

  const otherHost = await fetch(
    `${origin}/v1/tenants/${TENANT_ID}/hosts/host-2/snapshots?limit=2&cursor=${encodeURIComponent(
      first.body.nextCursor
    )}`,
    { headers: { authorization: "Bearer token-alice" } }
  );
  assert.equal(otherHost.status, 400);
});

test("caps the page size and rejects invalid limits", async (t) => {
  const { origin } = await startApp(t);

  assert.equal((await history(origin, { query: "?limit=99" })).body.code, "PAGE_SIZE_TOO_LARGE");
  assert.equal((await history(origin, { query: "?limit=0" })).body.code, "INVALID_PAGE_SIZE");
  assert.equal((await history(origin, { query: "?limit=abc" })).body.code, "INVALID_PAGE_SIZE");
});

test("never returns expired history even when deletion lags", async (t) => {
  const { app, origin } = await startApp(t);
  seedHistory(app, 2, { expiresAt: "2020-01-01T00:00:00Z" });

  const listed = await history(origin);
  assert.equal(listed.response.status, 200);
  assert.deepEqual(listed.body.snapshots, []);
});

test("refuses history queries when no cursor signing secret is configured", async (t) => {
  const { origin } = await startApp(t, { CURSOR_SIGNING_SECRET: "" });

  const response = await history(origin);
  assert.equal(response.response.status, 503);
  assert.equal(response.body.code, "CURSOR_SIGNING_NOT_CONFIGURED");
});

test("stays closed when no id token verifier is configured", async (t) => {
  const app = createApp({ CURSOR_SIGNING_SECRET: SECRET });
  await new Promise((resolve) => app.server.listen(0, resolve));
  t.after(() => new Promise((resolve) => app.server.close(resolve)));

  const response = await fetch(
    `http://127.0.0.1:${app.server.address().port}/v1/tenants/${TENANT_ID}/hosts/${HOST_ID}/snapshots`,
    { headers: { authorization: "Bearer token-alice" } }
  );
  assert.equal(response.status, 401);
});
