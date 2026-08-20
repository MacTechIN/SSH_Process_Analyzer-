import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { AgentRegistry } from "../../collector-api/src/agent-registry.js";
import { runCleanup } from "../../collector-api/src/cleanup-job.js";
import { createConfig } from "../../collector-api/src/config.js";
import { HistoryService } from "../../collector-api/src/history-service.js";
import { GenerationRepository } from "../../collector-api/src/repository/generation-repository.js";
import { FirestoreStore, createFirestore } from "../../collector-api/src/repository/firestore-store.js";

const emulatorAvailable = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
const options = { skip: !emulatorAvailable };
const store = emulatorAvailable
  ? new FirestoreStore(createFirestore({ projectId: process.env.GCLOUD_PROJECT ?? "demo-ssh-analyzer" }))
  : null;
const config = createConfig({ CURSOR_SIGNING_SECRET: "emulator-secret", HISTORY_PAGE_SIZE_LIMIT: "10" });

function publicKey() {
  const { publicKey: key } = generateKeyPairSync("ed25519");
  return Buffer.from(key.export({ format: "der", type: "spki" }).subarray(12)).toString("base64url");
}

test("history pages newest first with a signed cursor", options, async () => {
  const tenantId = "history-tenant";
  const hostId = "host-1";
  await store.seedMembership({ tenantId, uid: "alice", role: "viewer" });
  for (let index = 0; index < 4; index += 1) {
    const suffix = `${index}`.padStart(2, "0");
    await store.seedSnapshotHistory({
      tenantId,
      hostId,
      snapshotId: `snapshot-${suffix}`,
      agentId: "agent_history",
      capturedAt: `2026-08-17T10:${suffix}:00Z`,
      expiresAt: "2099-01-01T00:00:00Z",
      processCount: index,
      bodyHash: `hash-${suffix}`,
      published: true,
      storedAt: `2026-08-17T10:${suffix}:01Z`
    });
  }

  const service = new HistoryService({
    store,
    config,
    verifyIdToken: async () => ({ uid: "alice" })
  });

  const first = await service.listSnapshots({
    tenantId,
    hostId,
    authorization: "Bearer token",
    pageSize: 2
  });
  assert.deepEqual(
    first.snapshots.map((snapshot) => snapshot.snapshotId),
    ["snapshot-03", "snapshot-02"]
  );

  const second = await service.listSnapshots({
    tenantId,
    hostId,
    authorization: "Bearer token",
    pageSize: 2,
    cursor: first.nextCursor
  });
  assert.deepEqual(
    second.snapshots.map((snapshot) => snapshot.snapshotId),
    ["snapshot-01", "snapshot-00"]
  );
});

test("history denies a uid without a membership document", options, async () => {
  const service = new HistoryService({
    store,
    config,
    verifyIdToken: async () => ({ uid: "mallory" })
  });

  await assert.rejects(
    () =>
      service.listSnapshots({
        tenantId: "history-tenant",
        hostId: "host-1",
        authorization: "Bearer token"
      }),
    (error) => error.status === 403
  );
});

test("cleanup deletes expired generations and leaves history to the ttl policy", options, async () => {
  const tenantId = "cleanup-tenant";
  const hostId = "host-1";
  const repository = new GenerationRepository(store);
  await store.seedAgent({ tenantId, hostId, agentId: "agent_cleanup", quarantined: false });
  await store.seedHost({ tenantId, hostId });

  const input = {
    tenantId,
    hostId,
    agentId: "agent_cleanup",
    snapshotId: "expired",
    bodyHash: "hash-1",
    capturedAt: "2026-08-10T00:00:00Z",
    expiresAt: "2026-08-11T00:00:00Z",
    expectedProcessCount: 2,
    expectedBatchCount: 1
  };
  await repository.beginSnapshot(input);
  await repository.stageBatch({
    ...input,
    batchIndex: 0,
    processes: [
      { processKey: "process-1", ownerName: "alice" },
      { processKey: "process-2", ownerName: "bob" }
    ]
  });
  await store.seedSnapshotHistory({
    tenantId,
    hostId,
    snapshotId: "expired",
    capturedAt: "2026-08-10T00:00:00Z",
    expiresAt: "2026-08-11T00:00:00Z",
    processCount: 2,
    published: false
  });

  const summary = await runCleanup({ store, repository, config, now: () => new Date("2026-08-18T00:00:00Z") });

  assert.ok(summary.deleted >= 1);
  assert.equal(summary.deletedHistory, 0);
  assert.equal(await store.readGeneration(tenantId, hostId, "expired"), undefined);
  assert.deepEqual(await store.listProcessKeys(tenantId, hostId, "expired"), []);
  assert.equal((await store.listSnapshotHistory(tenantId, hostId, { limit: 5 })).length, 1);
});

test("agent registry writes keys, quarantine state, and an audit trail", options, async () => {
  const registry = new AgentRegistry({ store });
  await registry.register({
    tenantId: "registry-tenant",
    hostId: "host-1",
    agentId: "agent_registry",
    kid: "key_01",
    publicKey: publicKey(),
    actor: "ops"
  });
  await registry.rotateKey({ agentId: "agent_registry", kid: "key_02", publicKey: publicKey(), actor: "ops" });
  await registry.revokeKey({ agentId: "agent_registry", kid: "key_01", actor: "ops" });
  await registry.quarantine({ agentId: "agent_registry", reason: "clone suspicion", actor: "ops" });

  const described = await registry.describe("agent_registry");
  assert.equal(described.quarantined, true);
  assert.deepEqual(
    described.keys.map((key) => [key.kid, key.active]).sort(),
    [["key_01", false], ["key_02", true]]
  );
  assert.deepEqual(
    described.auditLog.map((entry) => entry.action).sort(),
    ["quarantine", "register", "revoke-key", "rotate-key"]
  );
});
