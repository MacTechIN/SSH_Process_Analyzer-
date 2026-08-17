import assert from "node:assert/strict";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { createApp } from "../../collector-api/src/index.js";
import {
  buildProcess,
  buildSnapshot,
  createAgentKeyPair,
  nonceHex,
  rfc3339,
  signedHeaders
} from "../helpers/agent.js";

const TENANT_ID = "tenant-a";
const HOST_ID = "host-1";
const AGENT_ID = "agent_01";
const KID = "key_01";
const SNAPSHOT_ID = "123e4567-e89b-42d3-a456-426614174000";

async function startApp(t, env = {}) {
  const keyPair = createAgentKeyPair();
  const app = createApp({ DEV_READ_API_ENABLED: "true", ...env });
  app.store.seedAgent({
    tenantId: TENANT_ID,
    hostId: HOST_ID,
    agentId: AGENT_ID,
    quarantined: false,
    keys: { [KID]: { publicKey: keyPair.publicKeyBase64url, revokedAt: null } }
  });
  app.store.seedHost({ tenantId: TENANT_ID, hostId: HOST_ID });

  await new Promise((resolve) => app.server.listen(0, resolve));
  t.after(() => new Promise((resolve) => app.server.close(resolve)));
  return { app, keyPair, origin: `http://127.0.0.1:${app.server.address().port}` };
}

function snapshotBody(overrides = {}) {
  const snapshot = buildSnapshot({
    snapshotId: SNAPSHOT_ID,
    capturedAt: rfc3339(new Date()),
    processes: [buildProcess(1), buildProcess(2)],
    ...overrides
  });
  return Buffer.from(JSON.stringify(snapshot), "utf8");
}

async function push({ origin, keyPair, wireBody, headers = {}, timestamp, nonce, gzip = false }) {
  const body = gzip ? gzipSync(wireBody) : wireBody;
  const signature = signedHeaders({
    wireBody: body,
    agentId: AGENT_ID,
    kid: KID,
    privateKey: keyPair.privateKey,
    timestamp: timestamp ?? rfc3339(new Date()),
    nonce: nonce ?? nonceHex()
  });
  const response = await fetch(`${origin}/v1/snapshots`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(gzip ? { "content-encoding": "gzip" } : {}),
      ...signature,
      ...headers
    },
    body
  });
  return { response, body: await response.json() };
}

test("accepts a signed snapshot, publishes it, and serves it as the current generation", async (t) => {
  const { origin, keyPair } = await startApp(t);
  const wireBody = snapshotBody();

  const pushed = await push({ origin, keyPair, wireBody, headers: { "x-correlation-id": "corr-1" } });
  assert.equal(pushed.response.status, 200);
  assert.equal(pushed.body.published, true);
  assert.equal(pushed.body.idempotent, false);
  assert.equal(pushed.body.processCount, 2);
  assert.equal(pushed.response.headers.get("x-correlation-id"), "corr-1");

  const current = await fetch(`${origin}/v1/tenants/${TENANT_ID}/hosts/${HOST_ID}/current`);
  const view = await current.json();
  assert.equal(current.status, 200);
  assert.equal(view.snapshotId, SNAPSHOT_ID);
  assert.equal(view.processes.length, 2);
  assert.deepEqual(
    view.processes.map((process) => process.ownerName),
    ["alice", "alice"]
  );
});

test("accepts a gzip snapshot signed over the compressed wire bytes", async (t) => {
  const { origin, keyPair } = await startApp(t);

  const pushed = await push({ origin, keyPair, wireBody: snapshotBody(), gzip: true });
  assert.equal(pushed.response.status, 200);
  assert.equal(pushed.body.published, true);
});

test("rejects a reused nonce for the same agent and key", async (t) => {
  const { origin, keyPair } = await startApp(t);
  const nonce = nonceHex();
  const wireBody = snapshotBody();

  const first = await push({ origin, keyPair, wireBody, nonce });
  assert.equal(first.response.status, 200);

  const replayed = await push({ origin, keyPair, wireBody, nonce });
  assert.equal(replayed.response.status, 401);
  assert.equal(replayed.body.code, "REPLAY_DETECTED");
});

test("rejects a body that does not match the signed digest", async (t) => {
  const { origin, keyPair } = await startApp(t);
  const signedBody = snapshotBody();
  const tamperedBody = snapshotBody({ processes: [buildProcess(9)] });
  const headers = signedHeaders({
    wireBody: signedBody,
    agentId: AGENT_ID,
    kid: KID,
    privateKey: keyPair.privateKey,
    timestamp: rfc3339(new Date()),
    nonce: nonceHex()
  });

  const response = await fetch(`${origin}/v1/snapshots`, { method: "POST", headers, body: tamperedBody });
  assert.equal(response.status, 401);
  assert.equal((await response.json()).code, "INVALID_SIGNATURE");
});

test("rejects unregistered agents, unknown key ids, and revoked keys", async (t) => {
  const { app, origin, keyPair } = await startApp(t);
  const wireBody = snapshotBody();

  const unknownAgent = await fetch(`${origin}/v1/snapshots`, {
    method: "POST",
    headers: signedHeaders({
      wireBody,
      agentId: "agent_unknown",
      kid: KID,
      privateKey: keyPair.privateKey,
      timestamp: rfc3339(new Date()),
      nonce: nonceHex()
    }),
    body: wireBody
  });
  assert.equal(unknownAgent.status, 401);
  assert.equal((await unknownAgent.json()).code, "UNKNOWN_AGENT");

  app.store.seedAgent({
    tenantId: TENANT_ID,
    hostId: HOST_ID,
    agentId: AGENT_ID,
    quarantined: false,
    keys: { [KID]: { publicKey: keyPair.publicKeyBase64url, revokedAt: "2026-08-01T00:00:00Z" } }
  });
  const revoked = await push({ origin, keyPair, wireBody });
  assert.equal(revoked.response.status, 401);
  assert.equal(revoked.body.code, "REVOKED_KEY");
});

test("rejects a timestamp outside the allowed clock skew", async (t) => {
  const { origin, keyPair } = await startApp(t);
  const stale = rfc3339(new Date(Date.now() - 10 * 60 * 1000));

  const pushed = await push({ origin, keyPair, wireBody: snapshotBody(), timestamp: stale });
  assert.equal(pushed.response.status, 401);
  assert.equal(pushed.body.code, "TIMESTAMP_OUT_OF_WINDOW");
});

test("rejects quarantined agents with 403 and keeps the current pointer", async (t) => {
  const { app, origin, keyPair } = await startApp(t);
  app.store.seedAgent({
    tenantId: TENANT_ID,
    hostId: HOST_ID,
    agentId: AGENT_ID,
    quarantined: true,
    keys: { [KID]: { publicKey: keyPair.publicKeyBase64url, revokedAt: null } }
  });

  const pushed = await push({ origin, keyPair, wireBody: snapshotBody() });
  assert.equal(pushed.response.status, 403);
  assert.equal(pushed.body.code, "AGENT_QUARANTINED");
  assert.equal(app.store.inspect().hosts.get(`${TENANT_ID}/${HOST_ID}`).publishedGeneration, undefined);
});

test("rejects schema violations and out of window capturedAt", async (t) => {
  const { origin, keyPair } = await startApp(t);

  const badSchema = await push({
    origin,
    keyPair,
    wireBody: snapshotBody({ processes: [buildProcess(1, { ownerName: "alice bob" })] })
  });
  assert.equal(badSchema.response.status, 400);
  assert.equal(badSchema.body.code, "SCHEMA_INVALID");

  const future = await push({
    origin,
    keyPair,
    wireBody: snapshotBody({ capturedAt: rfc3339(new Date(Date.now() + 10 * 60 * 1000)) })
  });
  assert.equal(future.response.status, 400);
  assert.equal(future.body.code, "CAPTURED_AT_IN_FUTURE");
});

test("rejects unsupported content encoding and oversized wire bodies", async (t) => {
  const { origin, keyPair } = await startApp(t, { MAX_WIRE_BODY_BYTES: "256" });

  const encoded = await push({ origin, keyPair, wireBody: snapshotBody(), headers: { "content-encoding": "br" } });
  assert.equal(encoded.response.status, 415);
  assert.equal(encoded.body.code, "UNSUPPORTED_CONTENT_ENCODING");

  const oversized = await push({ origin, keyPair, wireBody: snapshotBody() });
  assert.equal(oversized.response.status, 413);
  assert.equal(oversized.body.code, "WIRE_BODY_TOO_LARGE");
});

test("treats an identical resend as idempotent and a different body as a conflict", async (t) => {
  const { origin, keyPair } = await startApp(t);
  const wireBody = snapshotBody();

  assert.equal((await push({ origin, keyPair, wireBody })).response.status, 200);

  const resent = await push({ origin, keyPair, wireBody });
  assert.equal(resent.response.status, 200);
  assert.equal(resent.body.idempotent, true);

  const conflicting = await push({ origin, keyPair, wireBody: snapshotBody({ processes: [buildProcess(7)] }) });
  assert.equal(conflicting.response.status, 409);
  assert.equal(conflicting.body.code, "SNAPSHOT_HASH_CONFLICT");
});

test("keeps the current pointer when a delayed older snapshot arrives", async (t) => {
  const { origin, keyPair } = await startApp(t);
  const newer = snapshotBody({ capturedAt: rfc3339(new Date()) });
  const older = snapshotBody({
    snapshotId: "223e4567-e89b-42d3-a456-426614174000",
    capturedAt: rfc3339(new Date(Date.now() - 5 * 60 * 1000)),
    processes: [buildProcess(3)]
  });

  assert.equal((await push({ origin, keyPair, wireBody: newer })).response.status, 200);
  const delayed = await push({ origin, keyPair, wireBody: older });
  assert.equal(delayed.response.status, 200);
  assert.deepEqual(delayed.body.published, false);
  assert.equal(delayed.body.reason, "not-newer");

  const current = await (await fetch(`${origin}/v1/tenants/${TENANT_ID}/hosts/${HOST_ID}/current`)).json();
  assert.equal(current.snapshotId, SNAPSHOT_ID);
});

test("the dev read api stays disabled unless it is explicitly enabled", async (t) => {
  const { origin, keyPair } = await startApp(t, { DEV_READ_API_ENABLED: "false" });
  assert.equal((await push({ origin, keyPair, wireBody: snapshotBody() })).response.status, 200);

  const current = await fetch(`${origin}/v1/tenants/${TENANT_ID}/hosts/${HOST_ID}/current`);
  assert.equal(current.status, 404);
});
