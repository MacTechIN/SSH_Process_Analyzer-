import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../../collector-api/src/index.js";
import {
  buildProcess,
  buildSnapshot,
  createAgentKeyPair,
  nonceHex,
  rfc3339,
  signedHeaders
} from "../helpers/agent.js";

const emulatorAvailable = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
const PROJECT_ID = process.env.GCLOUD_PROJECT ?? "demo-ssh-analyzer";
const HOST_ID = "host-1";
const KID = "key_01";

async function startApp(t, tenantId) {
  const agentId = `agent_${tenantId.replace(/-/g, "_")}`;
  const keyPair = createAgentKeyPair();
  const app = createApp({
    STORAGE_DRIVER: "firestore",
    GOOGLE_CLOUD_PROJECT: PROJECT_ID,
    DEV_READ_API_ENABLED: "true"
  });
  await app.store.seedAgent({
    tenantId,
    hostId: HOST_ID,
    agentId,
    quarantined: false,
    keys: { [KID]: { publicKey: keyPair.publicKeyBase64url, revokedAt: null } }
  });
  await app.store.seedHost({ tenantId, hostId: HOST_ID });

  await new Promise((resolve) => app.server.listen(0, resolve));
  t.after(() => new Promise((resolve) => app.server.close(resolve)));
  return { app, keyPair, agentId, origin: `http://127.0.0.1:${app.server.address().port}` };
}

function snapshotBody(overrides = {}) {
  return Buffer.from(
    JSON.stringify(
      buildSnapshot({
        snapshotId: "123e4567-e89b-42d3-a456-426614174000",
        capturedAt: rfc3339(new Date()),
        processes: [buildProcess(1), buildProcess(2)],
        ...overrides
      })
    ),
    "utf8"
  );
}

async function push({ origin, keyPair, agentId, wireBody, nonce }) {
  const response = await fetch(`${origin}/v1/snapshots`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...signedHeaders({
        wireBody,
        agentId,
        kid: KID,
        privateKey: keyPair.privateKey,
        timestamp: rfc3339(new Date()),
        nonce: nonce ?? nonceHex()
      })
    },
    body: wireBody
  });
  return { response, body: await response.json() };
}

test("publishes a signed snapshot into firestore and reads it back", { skip: !emulatorAvailable }, async (t) => {
  const tenantId = "api-tenant-1";
  const { app, origin, keyPair, agentId } = await startApp(t, tenantId);
  const wireBody = snapshotBody();

  const pushed = await push({ origin, keyPair, agentId, wireBody });
  assert.equal(pushed.response.status, 200);
  assert.equal(pushed.body.published, true);

  const host = await app.store.readHost(tenantId, HOST_ID);
  assert.equal(host.publishedGeneration, "123e4567-e89b-42d3-a456-426614174000");
  const stored = await app.store.listProcesses(tenantId, HOST_ID, host.publishedGeneration);
  assert.equal(stored.length, 2);

  const current = await (await fetch(`${origin}/v1/tenants/${tenantId}/hosts/${HOST_ID}/current`)).json();
  assert.equal(current.processes.length, 2);
  assert.deepEqual(
    current.processes.map((process) => process.ownerName),
    ["alice", "alice"]
  );
});

test("blocks a replayed nonce through the firestore replay store", { skip: !emulatorAvailable }, async (t) => {
  const { origin, keyPair, agentId } = await startApp(t, "api-tenant-2");
  const wireBody = snapshotBody();
  const nonce = nonceHex();

  assert.equal((await push({ origin, keyPair, agentId, wireBody, nonce })).response.status, 200);
  const replayed = await push({ origin, keyPair, agentId, wireBody, nonce });

  assert.equal(replayed.response.status, 401);
  assert.equal(replayed.body.code, "REPLAY_DETECTED");
});

test("keeps the current pointer when an older snapshot arrives late", { skip: !emulatorAvailable }, async (t) => {
  const tenantId = "api-tenant-3";
  const { app, origin, keyPair, agentId } = await startApp(t, tenantId);

  const newer = snapshotBody({ capturedAt: rfc3339(new Date()) });
  const older = snapshotBody({
    snapshotId: "223e4567-e89b-42d3-a456-426614174000",
    capturedAt: rfc3339(new Date(Date.now() - 5 * 60 * 1000)),
    processes: [buildProcess(3)]
  });

  assert.equal((await push({ origin, keyPair, agentId, wireBody: newer })).response.status, 200);
  const delayed = await push({ origin, keyPair, agentId, wireBody: older });
  assert.equal(delayed.body.published, false);
  assert.equal(delayed.body.reason, "not-newer");

  const host = await app.store.readHost(tenantId, HOST_ID);
  assert.equal(host.publishedGeneration, "123e4567-e89b-42d3-a456-426614174000");
});
