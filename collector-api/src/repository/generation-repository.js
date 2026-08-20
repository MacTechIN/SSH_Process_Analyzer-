import { fail } from "./errors.js";
import { PROCESS_DELETE_CHUNK_SIZE } from "./limits.js";

const WRITABLE_STATES = new Set(["staging", "failed-retryable"]);
const CLEANUP_BLOCKED_STATES = new Set(["ready", "publishing"]);

function sameBinding(agent, tenantId, hostId) {
  return agent?.tenantId === tenantId && agent?.hostId === hostId;
}

function historyRecord(generation, published, storedAt) {
  return {
    tenantId: generation.tenantId,
    hostId: generation.hostId,
    snapshotId: generation.snapshotId,
    agentId: generation.agentId,
    capturedAt: generation.capturedAt,
    expiresAt: generation.expiresAt ?? null,
    processCount: generation.expectedProcessCount,
    bodyHash: generation.bodyHash,
    published,
    storedAt: storedAt ?? null
  };
}

function allBatchesComplete(generation) {
  return generation.completedBatches.length === generation.expectedBatchCount;
}

export class GenerationRepository {
  constructor(store) {
    this.store = store;
  }

  async beginSnapshot(input) {
    return this.store.transaction(async (tx) => {
      const existing = await tx.getGeneration(input.tenantId, input.hostId, input.snapshotId);
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
        stagedProcessCount: 0,
        expiresAt: input.expiresAt ?? null,
        status: "staging",
        resumeLeaseUntil: input.resumeLeaseUntil ?? null
      };
      await tx.setGeneration(generation);
      return { generation, resumed: false };
    });
  }

  async stageBatch(input) {
    return this.store.transaction(async (tx) => {
      const generation = await this.#requiredGeneration(tx, input);
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
        await tx.createProcess(input.tenantId, input.hostId, input.snapshotId, process);
      }
      generation.completedBatches.push(input.batchIndex);
      generation.completedBatches.sort((a, b) => a - b);
      generation.stagedProcessCount += input.processes.length;
      generation.status = "staging";
      await tx.setGeneration(generation);
      return { generation, staged: true };
    });
  }

  async markReady(input) {
    return this.store.transaction(async (tx) => {
      const generation = await this.#requiredGeneration(tx, input);
      if (generation.status === "deleting") {
        fail("GENERATION_DELETING", "generation is being deleted");
      }
      if (!WRITABLE_STATES.has(generation.status) && generation.status !== "ready") {
        fail("GENERATION_NOT_STAGING", `cannot mark ready while generation is ${generation.status}`);
      }
      if (!allBatchesComplete(generation)) {
        fail("BATCH_MANIFEST_INCOMPLETE", "all process batches must complete before ready");
      }
      if (generation.stagedProcessCount !== generation.expectedProcessCount) {
        fail("PROCESS_COUNT_MISMATCH", "staged process count does not match generation metadata");
      }
      generation.status = "ready";
      generation.resumeLeaseUntil = null;
      await tx.setGeneration(generation);
      return generation;
    });
  }

  async publish(input) {
    return this.store.transaction(async (tx) => {
      const generation = await this.#requiredGeneration(tx, input);
      const agent = await tx.getAgent(input.tenantId, input.agentId);
      const host = await tx.getHost(input.tenantId, input.hostId);

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
      if (generation.stagedProcessCount !== generation.expectedProcessCount) {
        fail("PROCESS_COUNT_MISMATCH", "staged process count does not match generation metadata");
      }

      if (host.publishedCapturedAt) {
        const comparison = generation.capturedAt.localeCompare(host.publishedCapturedAt);
        if (comparison < 0 || (comparison === 0 && host.publishedSnapshotId !== generation.snapshotId)) {
          generation.status = "published";
          await tx.setGeneration(generation);
          await tx.setSnapshotHistory(historyRecord(generation, false, input.storedAt));
          return { published: false, reason: "not-newer" };
        }
      }

      host.publishedGeneration = generation.snapshotId;
      host.publishedSnapshotId = generation.snapshotId;
      host.publishedCapturedAt = generation.capturedAt;
      await tx.setHost(host);
      generation.status = "published";
      await tx.setGeneration(generation);
      await tx.setSnapshotHistory(historyRecord(generation, true, input.storedAt));
      return { published: true, idempotent: false };
    });
  }

  async recordAttempt(input) {
    return this.store.transaction(async (tx) => {
      const agent = await tx.getAgent(input.tenantId, input.agentId);
      const host = await tx.getHost(input.tenantId, input.hostId);
      if (!sameBinding(agent, input.tenantId, input.hostId)) {
        fail("AGENT_BINDING_MISMATCH", "agent registry binding does not match tenant and host");
      }
      if (!host) {
        fail("HOST_NOT_FOUND", "host registry entry is required");
      }

      host.lastAttemptAt = input.at;
      host.lastAttemptAgentId = input.agentId;
      host.lastOutcome = input.outcome;
      host.lastErrorCategory = input.errorCategory ?? null;
      if (input.outcome === "accepted") {
        host.lastSuccessAt = input.at;
      }
      await tx.setHost(host);
      return host;
    });
  }

  async claimCleanup(input) {
    return this.store.transaction(async (tx) => {
      const generation = await this.#requiredGeneration(tx, input);
      const host = await tx.getHost(input.tenantId, input.hostId);
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
      await tx.setGeneration(generation);
      return { generation, idempotent: false };
    });
  }

  async finishCleanup(input) {
    const chunkSize = input.deleteChunkSize ?? PROCESS_DELETE_CHUNK_SIZE;
    await this.store.transaction(async (tx) => {
      await this.#requireClaimed(tx, input);
    });

    let deletedProcessCount = 0;
    for (;;) {
      const processKeys = await this.store.listProcessKeys(
        input.tenantId,
        input.hostId,
        input.snapshotId,
        { limit: chunkSize }
      );
      if (processKeys.length === 0) {
        break;
      }
      await this.store.deleteProcessChunk(input.tenantId, input.hostId, input.snapshotId, processKeys);
      deletedProcessCount += processKeys.length;
    }

    await this.store.transaction(async (tx) => {
      await this.#requireClaimed(tx, input);
      await tx.deleteGeneration(input.tenantId, input.hostId, input.snapshotId);
    });
    return { deleted: true, deletedProcessCount };
  }

  async #requireClaimed(tx, input) {
    const generation = await this.#requiredGeneration(tx, input);
    const host = await tx.getHost(input.tenantId, input.hostId);
    if (host?.publishedGeneration === input.snapshotId) {
      fail("CURRENT_GENERATION", "current generation cannot be cleaned up");
    }
    if (generation.status !== "deleting") {
      fail("GENERATION_NOT_DELETING", "cleanup must claim generation before delete");
    }
    return generation;
  }

  async #requiredGeneration(tx, input) {
    const generation = await tx.getGeneration(input.tenantId, input.hostId, input.snapshotId);
    if (!generation) {
      fail("GENERATION_NOT_FOUND", "generation does not exist");
    }
    return generation;
  }
}
