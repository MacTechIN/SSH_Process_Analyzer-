import assert from "node:assert/strict";

export function createContext({ store, repository, tenantId, hostId = "host-1", agentId = "agent-1" }) {
  const ids = { tenantId, hostId, agentId };
  const base = {
    ...ids,
    snapshotId: "snapshot-1",
    bodyHash: "hash-1",
    capturedAt: "2026-06-02T07:00:00Z",
    expectedProcessCount: 1,
    expectedBatchCount: 1
  };

  const context = {
    store,
    repository,
    ids,
    base,
    process(processKey = "process-1") {
      return { processKey, ownerName: "alice" };
    },
    async seedAgent(overrides = {}) {
      await store.seedAgent({ ...ids, quarantined: false, ...overrides });
    },
    async seedHost(overrides = {}) {
      await store.seedHost({ tenantId, hostId, ...overrides });
    },
    async ready(input = base) {
      await repository.beginSnapshot(input);
      if (input.expectedBatchCount > 0) {
        await repository.stageBatch({ ...input, batchIndex: 0, processes: [context.process()] });
      }
      await repository.markReady(input);
    },
    async publishedGeneration() {
      return (await store.readHost(tenantId, hostId))?.publishedGeneration;
    },
    async generationStatus(snapshotId) {
      return (await store.readGeneration(tenantId, hostId, snapshotId))?.status;
    },
    async rejectsCode(action, code) {
      await assert.rejects(action, (error) => {
        assert.equal(error.code, code);
        return true;
      });
    }
  };

  return context;
}

export const scenarios = [
  {
    name: "publishes a complete ready generation atomically",
    async run(ctx) {
      await ctx.seedAgent();
      await ctx.seedHost();
      await ctx.ready();

      assert.deepEqual(await ctx.repository.publish(ctx.base), { published: true, idempotent: false });
      assert.equal(await ctx.publishedGeneration(), "snapshot-1");
      assert.equal(await ctx.generationStatus("snapshot-1"), "published");
    }
  },
  {
    name: "does not publish incomplete process batches",
    async run(ctx) {
      await ctx.seedAgent();
      await ctx.seedHost();
      const input = { ...ctx.base, expectedBatchCount: 2 };
      await ctx.repository.beginSnapshot(input);
      await ctx.repository.stageBatch({ ...input, batchIndex: 0, processes: [ctx.process()] });

      await ctx.rejectsCode(() => ctx.repository.markReady(input), "BATCH_MANIFEST_INCOMPLETE");
    }
  },
  {
    name: "publishes a zero-process snapshot and clears the current view by pointer switch",
    async run(ctx) {
      await ctx.seedAgent();
      await ctx.seedHost();
      await ctx.ready();
      await ctx.repository.publish(ctx.base);

      const empty = {
        ...ctx.base,
        snapshotId: "empty",
        capturedAt: "2026-06-02T08:00:00Z",
        expectedProcessCount: 0,
        expectedBatchCount: 0
      };
      await ctx.ready(empty);

      assert.deepEqual(await ctx.repository.publish(empty), { published: true, idempotent: false });
      assert.equal(await ctx.publishedGeneration(), "empty");
      assert.deepEqual(await ctx.store.listProcesses(ctx.ids.tenantId, ctx.ids.hostId, "empty"), []);
    }
  },
  {
    name: "rejects duplicate process keys across immutable staging batches",
    async run(ctx) {
      await ctx.seedAgent();
      await ctx.seedHost();
      const input = { ...ctx.base, expectedProcessCount: 2, expectedBatchCount: 2 };
      await ctx.repository.beginSnapshot(input);
      await ctx.repository.stageBatch({ ...input, batchIndex: 0, processes: [ctx.process()] });

      await ctx.rejectsCode(
        () => ctx.repository.stageBatch({ ...input, batchIndex: 1, processes: [ctx.process()] }),
        "PROCESS_KEY_CONFLICT"
      );
    }
  },
  {
    name: "rejects snapshot id reuse with a different body hash",
    async run(ctx) {
      await ctx.seedAgent();
      await ctx.seedHost();
      await ctx.repository.beginSnapshot(ctx.base);

      await ctx.rejectsCode(
        () => ctx.repository.beginSnapshot({ ...ctx.base, bodyHash: "different-hash" }),
        "SNAPSHOT_HASH_CONFLICT"
      );
    }
  },
  {
    name: "rejects publish from a quarantined agent",
    async run(ctx) {
      await ctx.seedAgent({ quarantined: true });
      await ctx.seedHost();
      await ctx.ready();

      await ctx.rejectsCode(() => ctx.repository.publish(ctx.base), "AGENT_QUARANTINED");
      assert.equal(await ctx.publishedGeneration(), undefined);
    }
  },
  {
    name: "rejects publish when the agent registry host binding changes",
    async run(ctx) {
      await ctx.seedAgent();
      await ctx.seedHost();
      await ctx.ready();
      await ctx.seedAgent({ hostId: "host-2" });

      await ctx.rejectsCode(() => ctx.repository.publish(ctx.base), "AGENT_BINDING_MISMATCH");
    }
  },
  {
    name: "stores delayed older snapshots without moving the latest pointer backwards",
    async run(ctx) {
      await ctx.seedAgent();
      await ctx.seedHost();
      const newer = { ...ctx.base, snapshotId: "new", capturedAt: "2026-06-02T08:00:00Z" };
      const older = { ...ctx.base, snapshotId: "old", capturedAt: "2026-06-02T07:00:00Z" };

      await ctx.ready(newer);
      await ctx.repository.publish(newer);
      await ctx.ready(older);

      assert.deepEqual(await ctx.repository.publish(older), { published: false, reason: "not-newer" });
      assert.equal(await ctx.publishedGeneration(), "new");
      assert.equal(await ctx.generationStatus("old"), "published");
    }
  },
  {
    name: "does not replace the current pointer with a different snapshot captured at the same time",
    async run(ctx) {
      await ctx.seedAgent();
      await ctx.seedHost();
      const first = { ...ctx.base, snapshotId: "first" };
      const tie = { ...ctx.base, snapshotId: "tie" };

      await ctx.ready(first);
      await ctx.repository.publish(first);
      await ctx.ready(tie);

      assert.deepEqual(await ctx.repository.publish(tie), { published: false, reason: "not-newer" });
      assert.equal(await ctx.publishedGeneration(), "first");
    }
  },
  {
    name: "republishing the current generation is idempotent",
    async run(ctx) {
      await ctx.seedAgent();
      await ctx.seedHost();
      await ctx.ready();
      await ctx.repository.publish(ctx.base);

      assert.deepEqual(await ctx.repository.publish(ctx.base), { published: true, idempotent: true });
      assert.equal(await ctx.publishedGeneration(), "snapshot-1");
    }
  },
  {
    name: "cleanup cannot claim the current generation or an active resume lease",
    async run(ctx) {
      await ctx.seedAgent();
      await ctx.seedHost();
      await ctx.ready();
      await ctx.repository.publish(ctx.base);

      await ctx.rejectsCode(
        () => ctx.repository.claimCleanup({ ...ctx.base, now: "2026-06-02T09:00:00Z" }),
        "CURRENT_GENERATION"
      );

      const retry = { ...ctx.base, snapshotId: "retry", resumeLeaseUntil: "2026-06-02T10:00:00Z" };
      await ctx.repository.beginSnapshot(retry);
      await ctx.rejectsCode(
        () => ctx.repository.claimCleanup({ ...retry, now: "2026-06-02T09:00:00Z" }),
        "RESUME_LEASE_ACTIVE"
      );
    }
  },
  {
    name: "cleanup claim is idempotent and blocks resume before recursive delete",
    async run(ctx) {
      await ctx.seedAgent();
      await ctx.seedHost();
      const abandoned = { ...ctx.base, snapshotId: "abandoned" };
      await ctx.repository.beginSnapshot(abandoned);

      assert.equal((await ctx.repository.claimCleanup({ ...abandoned, now: "2026-06-02T09:00:00Z" })).idempotent, false);
      assert.equal((await ctx.repository.claimCleanup({ ...abandoned, now: "2026-06-02T09:00:00Z" })).idempotent, true);
      await ctx.rejectsCode(
        () => ctx.repository.stageBatch({ ...abandoned, batchIndex: 0, processes: [ctx.process()] }),
        "GENERATION_NOT_STAGING"
      );

      assert.deepEqual(await ctx.repository.finishCleanup(abandoned), {
        deleted: true,
        deletedProcessCount: 0
      });
      assert.equal(await ctx.store.readGeneration(ctx.ids.tenantId, ctx.ids.hostId, "abandoned"), undefined);
    }
  },
  {
    name: "cleanup deletes staged processes in bounded chunks outside the transaction",
    async run(ctx) {
      await ctx.seedAgent();
      await ctx.seedHost();
      const abandoned = { ...ctx.base, snapshotId: "abandoned", expectedProcessCount: 3, expectedBatchCount: 1 };
      await ctx.repository.beginSnapshot(abandoned);
      await ctx.repository.stageBatch({
        ...abandoned,
        batchIndex: 0,
        processes: [ctx.process("process-1"), ctx.process("process-2"), ctx.process("process-3")]
      });
      await ctx.repository.claimCleanup({ ...abandoned, now: "2026-06-02T09:00:00Z" });

      assert.deepEqual(await ctx.repository.finishCleanup({ ...abandoned, deleteChunkSize: 2 }), {
        deleted: true,
        deletedProcessCount: 3
      });
      assert.deepEqual(
        await ctx.store.listProcessKeys(ctx.ids.tenantId, ctx.ids.hostId, "abandoned"),
        []
      );
    }
  },
  {
    name: "markReady rejects a manifest whose staged process count is short",
    async run(ctx) {
      await ctx.seedAgent();
      await ctx.seedHost();
      const short = { ...ctx.base, snapshotId: "short", expectedProcessCount: 2, expectedBatchCount: 1 };
      await ctx.repository.beginSnapshot(short);
      await ctx.repository.stageBatch({ ...short, batchIndex: 0, processes: [ctx.process()] });

      await ctx.rejectsCode(() => ctx.repository.markReady(short), "PROCESS_COUNT_MISMATCH");
    }
  },
  {
    name: "a staging batch cannot exceed the firestore transaction write limit",
    async run(ctx) {
      await ctx.seedAgent();
      await ctx.seedHost();
      const oversized = { ...ctx.base, snapshotId: "oversized", expectedProcessCount: 500, expectedBatchCount: 1 };
      await ctx.repository.beginSnapshot(oversized);

      await ctx.rejectsCode(
        () =>
          ctx.repository.stageBatch({
            ...oversized,
            batchIndex: 0,
            processes: Array.from({ length: 500 }, (_, index) => ctx.process(`process-${index}`))
          }),
        "TRANSACTION_WRITE_LIMIT"
      );
    }
  }
];
