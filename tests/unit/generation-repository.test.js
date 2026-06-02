import assert from "node:assert/strict";
import test from "node:test";
import { GenerationRepository } from "../../collector-api/src/repository/generation-repository.js";
import { InMemoryStore } from "../../collector-api/src/repository/in-memory-store.js";

const base = {
  tenantId: "tenant-a",
  hostId: "host-1",
  agentId: "agent-1",
  snapshotId: "snapshot-1",
  bodyHash: "hash-1",
  capturedAt: "2026-06-02T07:00:00Z",
  expectedProcessCount: 1,
  expectedBatchCount: 1
};

function process(processKey = "process-1") {
  return { processKey, ownerName: "alice" };
}

function setup() {
  const store = new InMemoryStore();
  store.seedAgent({ tenantId: "tenant-a", hostId: "host-1", agentId: "agent-1", quarantined: false });
  store.seedHost({ tenantId: "tenant-a", hostId: "host-1" });
  return { store, repository: new GenerationRepository(store) };
}

async function ready(repository, input = base) {
  await repository.beginSnapshot(input);
  await repository.stageBatch({ ...input, batchIndex: 0, processes: [process()] });
  await repository.markReady(input);
}

async function rejectsCode(action, code) {
  await assert.rejects(action, (error) => error.code === code);
}

test("publishes a complete ready generation atomically", async () => {
  const { store, repository } = setup();
  await ready(repository);

  assert.deepEqual(await repository.publish(base), { published: true, idempotent: false });
  const state = store.inspect();
  assert.equal(state.hosts.get("tenant-a/host-1").publishedGeneration, "snapshot-1");
  assert.equal(state.generations.get("tenant-a/host-1/snapshot-1").status, "published");
});

test("does not publish incomplete process batches", async () => {
  const { repository } = setup();
  await repository.beginSnapshot({ ...base, expectedBatchCount: 2 });
  await repository.stageBatch({ ...base, expectedBatchCount: 2, batchIndex: 0, processes: [process()] });

  await rejectsCode(() => repository.markReady(base), "BATCH_MANIFEST_INCOMPLETE");
});

test("publishes a zero-process snapshot and clears current view by pointer switch", async () => {
  const { store, repository } = setup();
  const empty = { ...base, snapshotId: "empty", expectedProcessCount: 0, expectedBatchCount: 0 };
  await repository.beginSnapshot(empty);
  await repository.markReady(empty);

  assert.deepEqual(await repository.publish(empty), { published: true, idempotent: false });
  assert.equal(store.inspect().hosts.get("tenant-a/host-1").publishedGeneration, "empty");
});

test("rejects duplicate process keys across immutable staging batches", async () => {
  const { repository } = setup();
  const input = { ...base, expectedProcessCount: 2, expectedBatchCount: 2 };
  await repository.beginSnapshot(input);
  await repository.stageBatch({ ...input, batchIndex: 0, processes: [process()] });

  await rejectsCode(
    () => repository.stageBatch({ ...input, batchIndex: 1, processes: [process()] }),
    "PROCESS_KEY_CONFLICT"
  );
});

test("rejects snapshot id reuse with a different body hash", async () => {
  const { repository } = setup();
  await repository.beginSnapshot(base);

  await rejectsCode(
    () => repository.beginSnapshot({ ...base, bodyHash: "different-hash" }),
    "SNAPSHOT_HASH_CONFLICT"
  );
});

test("rejects publish from a quarantined agent", async () => {
  const { store, repository } = setup();
  store.seedAgent({ tenantId: "tenant-a", hostId: "host-1", agentId: "agent-1", quarantined: true });
  await ready(repository);

  await rejectsCode(() => repository.publish(base), "AGENT_QUARANTINED");
});

test("rejects publish when agent registry host binding changes", async () => {
  const { store, repository } = setup();
  await ready(repository);
  store.seedAgent({ tenantId: "tenant-a", hostId: "host-2", agentId: "agent-1", quarantined: false });

  await rejectsCode(() => repository.publish(base), "AGENT_BINDING_MISMATCH");
});

test("stores delayed older snapshots without moving the latest pointer backwards", async () => {
  const { store, repository } = setup();
  await ready(repository, { ...base, snapshotId: "new", capturedAt: "2026-06-02T08:00:00Z" });
  await repository.publish({ ...base, snapshotId: "new", capturedAt: "2026-06-02T08:00:00Z" });
  await ready(repository, { ...base, snapshotId: "old", capturedAt: "2026-06-02T07:00:00Z" });

  assert.deepEqual(
    await repository.publish({ ...base, snapshotId: "old", capturedAt: "2026-06-02T07:00:00Z" }),
    { published: false, reason: "not-newer" }
  );
  const state = store.inspect();
  assert.equal(state.hosts.get("tenant-a/host-1").publishedGeneration, "new");
  assert.equal(state.generations.get("tenant-a/host-1/old").status, "published");
});

test("does not replace current pointer with a different snapshot captured at the same time", async () => {
  const { store, repository } = setup();
  await ready(repository, { ...base, snapshotId: "first" });
  await repository.publish({ ...base, snapshotId: "first" });
  await ready(repository, { ...base, snapshotId: "tie" });

  assert.deepEqual(await repository.publish({ ...base, snapshotId: "tie" }), {
    published: false,
    reason: "not-newer"
  });
  assert.equal(store.inspect().hosts.get("tenant-a/host-1").publishedGeneration, "first");
});

test("cleanup cannot claim current generation or an active resume lease", async () => {
  const { repository } = setup();
  await ready(repository);
  await repository.publish(base);
  await rejectsCode(
    () => repository.claimCleanup({ ...base, now: "2026-06-02T09:00:00Z" }),
    "CURRENT_GENERATION"
  );

  const retry = { ...base, snapshotId: "retry", resumeLeaseUntil: "2026-06-02T10:00:00Z" };
  await repository.beginSnapshot(retry);
  await rejectsCode(
    () => repository.claimCleanup({ ...retry, now: "2026-06-02T09:00:00Z" }),
    "RESUME_LEASE_ACTIVE"
  );
});

test("cleanup claim is idempotent and blocks resume before recursive delete", async () => {
  const { store, repository } = setup();
  const abandoned = { ...base, snapshotId: "abandoned" };
  await repository.beginSnapshot(abandoned);

  assert.equal((await repository.claimCleanup({ ...abandoned, now: "2026-06-02T09:00:00Z" })).idempotent, false);
  assert.equal((await repository.claimCleanup({ ...abandoned, now: "2026-06-02T09:00:00Z" })).idempotent, true);
  await rejectsCode(
    () => repository.stageBatch({ ...abandoned, batchIndex: 0, processes: [process()] }),
    "GENERATION_NOT_STAGING"
  );
  assert.deepEqual(await repository.finishCleanup(abandoned), { deleted: true });
  assert.equal(store.inspect().generations.has("tenant-a/host-1/abandoned"), false);
});
