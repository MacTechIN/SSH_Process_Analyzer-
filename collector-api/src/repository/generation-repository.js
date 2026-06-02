import { fail } from "./errors.js";

const WRITABLE_STATES = new Set(["staging", "failed-retryable"]);
const CLEANUP_BLOCKED_STATES = new Set(["ready", "publishing"]);

function sameBinding(agent, tenantId, hostId) {
  return agent?.tenantId === tenantId && agent?.hostId === hostId;
}

function allBatchesComplete(generation) {
  return generation.completedBatches.length === generation.expectedBatchCount;
}

export class GenerationRepository {
  constructor(store) {
    this.store = store;
  }

  async beginSnapshot(input) {
    return this.store.transaction((tx) => {
      const existing = tx.getGeneration(input.tenantId, input.hostId, input.snapshotId);
      if (existing) {
        if (existing.bodyHash !== input.bodyHash) {
          fail("SNAPSHOT_HASH_CONFLICT", "snapshotId already exists with a different body hash");
        }
        if (existing.status === "deleting") {
          fail("GENERATION_DELETING", "generation is being deleted");
        }
        return { generation: existing, resumed: existing.status !== "published" };
      }

      const generation = {
        tenantId: input.tenantId,
        hostId: input.hostId,
        snapshotId: input.snapshotId,
        agentId: input.agentId,
        bodyHash: input.bodyHash,
        capturedAt: input.capturedAt,
        expectedProcessCount: input.expectedProcessCount,
        expectedBatchCount: input.expectedBatchCount,
        completedBatches: [],
        status: "staging",
        resumeLeaseUntil: input.resumeLeaseUntil ?? null
      };
      tx.setGeneration(generation);
      return { generation, resumed: false };
    });
  }

  async stageBatch(input) {
    return this.store.transaction((tx) => {
      const generation = this.#requiredGeneration(tx, input);
      if (!WRITABLE_STATES.has(generation.status)) {
        fail("GENERATION_NOT_STAGING", `cannot stage batch while generation is ${generation.status}`);
      }
      if (input.batchIndex < 0 || input.batchIndex >= generation.expectedBatchCount) {
        fail("BATCH_INDEX_OUT_OF_RANGE", "batch index is outside the manifest");
      }
      if (generation.completedBatches.includes(input.batchIndex)) {
        return { generation, staged: false };
      }

      for (const process of input.processes) {
        if (tx.getProcess(input.tenantId, input.hostId, input.snapshotId, process.processKey)) {
          fail("PROCESS_KEY_CONFLICT", "process keys are immutable within a generation");
        }
        tx.setProcess(input.tenantId, input.hostId, input.snapshotId, process);
      }
      generation.completedBatches.push(input.batchIndex);
      generation.completedBatches.sort((a, b) => a - b);
      generation.status = "staging";
      tx.setGeneration(generation);
      return { generation, staged: true };
    });
  }

  async markReady(input) {
    return this.store.transaction((tx) => {
      const generation = this.#requiredGeneration(tx, input);
      if (generation.status === "deleting") {
        fail("GENERATION_DELETING", "generation is being deleted");
      }
      if (!WRITABLE_STATES.has(generation.status) && generation.status !== "ready") {
        fail("GENERATION_NOT_STAGING", `cannot mark ready while generation is ${generation.status}`);
      }
      if (!allBatchesComplete(generation)) {
        fail("BATCH_MANIFEST_INCOMPLETE", "all process batches must complete before ready");
      }
      if (tx.listProcesses(input.tenantId, input.hostId, input.snapshotId).length !== generation.expectedProcessCount) {
        fail("PROCESS_COUNT_MISMATCH", "stored process count does not match generation metadata");
      }
      generation.status = "ready";
      generation.resumeLeaseUntil = null;
      tx.setGeneration(generation);
      return generation;
    });
  }

  async publish(input) {
    return this.store.transaction((tx) => {
      const generation = this.#requiredGeneration(tx, input);
      const agent = tx.getAgent(input.tenantId, input.agentId);
      const host = tx.getHost(input.tenantId, input.hostId);

      if (!sameBinding(agent, input.tenantId, input.hostId)) {
        fail("AGENT_BINDING_MISMATCH", "agent registry binding does not match tenant and host");
      }
      if (agent.quarantined) {
        fail("AGENT_QUARANTINED", "quarantined agents cannot publish");
      }
      if (!host) {
        fail("HOST_NOT_FOUND", "host registry entry is required");
      }
      if (generation.status === "deleting") {
        fail("GENERATION_DELETING", "generation is being deleted");
      }
      if (generation.status === "published" && host.publishedGeneration === generation.snapshotId) {
        return { published: true, idempotent: true };
      }
      if (generation.status !== "ready") {
        fail("GENERATION_NOT_READY", `cannot publish while generation is ${generation.status}`);
      }
      if (generation.agentId !== input.agentId || generation.bodyHash !== input.bodyHash) {
        fail("GENERATION_PRECONDITION_FAILED", "generation identity does not match publish request");
      }
      if (!allBatchesComplete(generation)) {
        fail("BATCH_MANIFEST_INCOMPLETE", "all process batches must complete before publish");
      }
      if (tx.listProcesses(input.tenantId, input.hostId, input.snapshotId).length !== generation.expectedProcessCount) {
        fail("PROCESS_COUNT_MISMATCH", "stored process count does not match generation metadata");
      }

      if (host.publishedCapturedAt) {
        const comparison = generation.capturedAt.localeCompare(host.publishedCapturedAt);
        if (comparison < 0 || (comparison === 0 && host.publishedSnapshotId !== generation.snapshotId)) {
          generation.status = "published";
          tx.setGeneration(generation);
          return { published: false, reason: "not-newer" };
        }
      }

      generation.status = "publishing";
      tx.setGeneration(generation);
      host.publishedGeneration = generation.snapshotId;
      host.publishedSnapshotId = generation.snapshotId;
      host.publishedCapturedAt = generation.capturedAt;
      tx.setHost(host);
      generation.status = "published";
      tx.setGeneration(generation);
      return { published: true, idempotent: false };
    });
  }

  async claimCleanup(input) {
    return this.store.transaction((tx) => {
      const generation = this.#requiredGeneration(tx, input);
      const host = tx.getHost(input.tenantId, input.hostId);
      if (host?.publishedGeneration === input.snapshotId) {
        fail("CURRENT_GENERATION", "current generation cannot be cleaned up");
      }
      if (generation.status === "deleting") {
        return { generation, idempotent: true };
      }
      if (CLEANUP_BLOCKED_STATES.has(generation.status)) {
        fail("GENERATION_ACTIVE", `cannot clean up while generation is ${generation.status}`);
      }
      if (generation.resumeLeaseUntil && generation.resumeLeaseUntil > input.now) {
        fail("RESUME_LEASE_ACTIVE", "generation has an active resume lease");
      }
      generation.status = "deleting";
      tx.setGeneration(generation);
      return { generation, idempotent: false };
    });
  }

  async finishCleanup(input) {
    return this.store.transaction((tx) => {
      const generation = this.#requiredGeneration(tx, input);
      const host = tx.getHost(input.tenantId, input.hostId);
      if (host?.publishedGeneration === input.snapshotId) {
        fail("CURRENT_GENERATION", "current generation cannot be cleaned up");
      }
      if (generation.status !== "deleting") {
        fail("GENERATION_NOT_DELETING", "cleanup must claim generation before delete");
      }
      tx.deleteProcesses(input.tenantId, input.hostId, input.snapshotId);
      tx.deleteGeneration(input.tenantId, input.hostId, input.snapshotId);
      return { deleted: true };
    });
  }

  #requiredGeneration(tx, input) {
    const generation = tx.getGeneration(input.tenantId, input.hostId, input.snapshotId);
    if (!generation) {
      fail("GENERATION_NOT_FOUND", "generation does not exist");
    }
    return generation;
  }
}
