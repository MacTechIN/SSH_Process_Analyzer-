import assert from "node:assert/strict";
import test from "node:test";
import { runCleanup } from "../../collector-api/src/cleanup-job.js";
import { createConfig } from "../../collector-api/src/config.js";
import { GenerationRepository } from "../../collector-api/src/repository/generation-repository.js";
import { InMemoryStore } from "../../collector-api/src/repository/in-memory-store.js";

const NOW = "2026-08-18T12:00:00Z";
const EXPIRED = "2026-08-18T11:00:00Z";
const ALIVE = "2026-08-19T00:00:00Z";

function setup() {
  const store = new InMemoryStore();
  store.seedAgent({ tenantId: "tenant-a", hostId: "host-1", agentId: "agent-1", quarantined: false });
  store.seedHost({ tenantId: "tenant-a", hostId: "host-1" });
  return { store, repository: new GenerationRepository(store), config: createConfig({}) };
}

const base = {
  tenantId: "tenant-a",
  hostId: "host-1",
  agentId: "agent-1",
  bodyHash: "hash-1",
  expectedProcessCount: 1,
  expectedBatchCount: 1
};

async function stage(repository, { snapshotId, capturedAt, expiresAt, processKeys = ["process-1"] }) {
  const input = {
    ...base,
    snapshotId,
    capturedAt,
    expiresAt,
    expectedProcessCount: processKeys.length,
    expectedBatchCount: 1
  };
  await repository.beginSnapshot(input);
  await repository.stageBatch({
    ...input,
    batchIndex: 0,
    processes: processKeys.map((processKey) => ({ processKey, ownerName: "alice" }))
  });
  return input;
}

async function published(repository, options) {
  const input = await stage(repository, options);
  await repository.markReady(input);
  await repository.publish({ ...input, storedAt: options.capturedAt });
  return input;
}

function cleanup(context, overrides = {}) {
  return runCleanup({ ...context, now: () => new Date(NOW), ...overrides });
}

test("deletes expired generations together with their processes", async () => {
  const context = setup();
  await stage(context.repository, {
    snapshotId: "abandoned",
    capturedAt: "2026-08-17T00:00:00Z",
    expiresAt: EXPIRED,
    processKeys: ["process-1", "process-2"]
  });

  const summary = await cleanup(context);

  assert.equal(summary.deleted, 1);
  assert.equal(summary.deletedProcessCount, 2);
  assert.equal(await context.store.readGeneration("tenant-a", "host-1", "abandoned"), undefined);
  assert.deepEqual(await context.store.listProcessKeys("tenant-a", "host-1", "abandoned"), []);
});

test("never deletes the generation the host currently points at", async () => {
  const context = setup();
  await published(context.repository, {
    snapshotId: "current",
    capturedAt: "2026-08-17T00:00:00Z",
    expiresAt: EXPIRED
  });

  const summary = await cleanup(context);

  assert.equal(summary.skipped, 1);
  assert.equal(summary.deleted, 0);
  assert.equal((await context.store.readHost("tenant-a", "host-1")).publishedGeneration, "current");
  assert.ok(await context.store.readGeneration("tenant-a", "host-1", "current"));
});

test("skips ready generations and generations holding a resume lease", async () => {
  const context = setup();
  const ready = await stage(context.repository, {
    snapshotId: "ready",
    capturedAt: "2026-08-17T00:00:00Z",
    expiresAt: EXPIRED
  });
  await context.repository.markReady(ready);
  await context.repository.beginSnapshot({
    ...base,
    snapshotId: "leased",
    capturedAt: "2026-08-17T00:00:00Z",
    expiresAt: EXPIRED,
    resumeLeaseUntil: "2026-08-18T13:00:00Z"
  });

  const summary = await cleanup(context);

  assert.equal(summary.skipped, 2);
  assert.equal(summary.deleted, 0);
});

test("leaves generations that have not expired yet", async () => {
  const context = setup();
  await stage(context.repository, { snapshotId: "fresh", capturedAt: "2026-08-18T11:59:00Z", expiresAt: ALIVE });

  const summary = await cleanup(context);

  assert.equal(summary.examined, 0);
  assert.ok(await context.store.readGeneration("tenant-a", "host-1", "fresh"));
});

test("stops at the per run generation limit", async () => {
  const context = setup();
  for (const snapshotId of ["one", "two", "three"]) {
    await stage(context.repository, { snapshotId, capturedAt: "2026-08-17T00:00:00Z", expiresAt: EXPIRED });
  }

  const summary = await cleanup(context, { limit: 2 });

  assert.equal(summary.examined, 2);
  assert.equal(summary.deleted, 2);
});

test("deletes expired snapshot history when the store has no ttl service", async () => {
  const context = setup();
  context.store.seedSnapshotHistory({
    tenantId: "tenant-a",
    hostId: "host-1",
    snapshotId: "old",
    capturedAt: "2026-08-10T00:00:00Z",
    expiresAt: EXPIRED,
    processCount: 1,
    published: true
  });

  const summary = await cleanup(context);

  assert.equal(summary.deletedHistory, 1);
  assert.deepEqual(await context.store.listSnapshotHistory("tenant-a", "host-1"), []);
});

test("stops when the run timeout is reached", async () => {
  const context = setup();
  for (const snapshotId of ["one", "two"]) {
    await stage(context.repository, { snapshotId, capturedAt: "2026-08-17T00:00:00Z", expiresAt: EXPIRED });
  }

  let call = 0;
  const summary = await runCleanup({
    ...context,
    now: () => new Date(Date.parse(NOW) + (call++ > 0 ? context.config.cleanup.timeoutSeconds * 1000 : 0))
  });

  assert.equal(summary.timedOut, true);
  assert.equal(summary.deleted, 0);
});
