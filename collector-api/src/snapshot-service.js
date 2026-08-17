import { gunzipSync } from "node:zlib";
import { ApiError, reject, statusForRepositoryCode } from "./api-error.js";
import { RepositoryError } from "./repository/errors.js";
import {
  NONCE_PATTERN,
  REGISTERED_ID_PATTERN,
  TIMESTAMP_PATTERN,
  bodyDigest,
  canonicalPayload,
  publicKeyFromRaw,
  replayDocumentId,
  verifyCanonicalSignature
} from "./signing.js";
import { validateSnapshotV1 } from "./snapshot-schema.js";

const WRITABLE_STATES = new Set(["staging", "failed-retryable"]);

function requireHeader(headers, name, pattern) {
  const value = headers[name];
  if (typeof value !== "string" || !pattern.test(value)) {
    reject(401, "MALFORMED_SIGNATURE_HEADERS", `${name} is missing or malformed`);
  }
  return value;
}

function decodeBody(wireBody, contentEncoding, maxDecompressedBodyBytes) {
  if (contentEncoding === "gzip") {
    try {
      return gunzipSync(wireBody, { maxOutputLength: maxDecompressedBodyBytes });
    } catch (error) {
      if (error?.code === "ERR_BUFFER_TOO_LARGE") {
        reject(413, "DECOMPRESSED_BODY_TOO_LARGE", "decompressed body exceeds the configured limit");
      }
      reject(400, "BODY_NOT_DECODABLE", "gzip body could not be decompressed");
    }
  }
  return wireBody;
}

function chunk(items, size) {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

export class SnapshotService {
  constructor({ store, repository, replayStore, config, now = () => new Date() }) {
    this.store = store;
    this.repository = repository;
    this.replayStore = replayStore;
    this.config = config;
    this.now = now;
  }

  async ingest({ wireBody, contentEncoding, headers }) {
    const receivedAt = this.now();
    const auth = {
      agentId: requireHeader(headers, "x-agent-id", REGISTERED_ID_PATTERN),
      kid: requireHeader(headers, "x-agent-key-id", REGISTERED_ID_PATTERN),
      timestamp: requireHeader(headers, "x-agent-timestamp", TIMESTAMP_PATTERN),
      nonce: requireHeader(headers, "x-agent-nonce", NONCE_PATTERN),
      signature: requireHeader(headers, "x-agent-signature", /^[A-Za-z0-9_-]{86,88}$/)
    };

    const bodySha256 = bodyDigest(wireBody);
    const agent = await this.store.findAgent(auth.agentId);
    if (!agent) {
      reject(401, "UNKNOWN_AGENT", "agent is not registered");
    }
    const registeredKey = agent.keys?.[auth.kid];
    if (!registeredKey) {
      reject(401, "UNKNOWN_KEY", "key id is not registered for this agent");
    }
    if (registeredKey.revokedAt) {
      reject(401, "REVOKED_KEY", "key id is revoked");
    }

    const verified = verifyCanonicalSignature({
      payload: canonicalPayload({ ...auth, bodySha256 }),
      signatureBase64url: auth.signature,
      publicKey: publicKeyFromRaw(registeredKey.publicKey)
    });
    if (!verified) {
      reject(401, "INVALID_SIGNATURE", "signature does not match the canonical payload");
    }

    this.#requireFreshTimestamp(auth.timestamp, receivedAt);
    await this.#recordReplay(auth, receivedAt);

    const decoded = decodeBody(wireBody, contentEncoding, this.config.maxDecompressedBodyBytes);
    let parsed;
    try {
      parsed = JSON.parse(decoded.toString("utf8"));
    } catch {
      reject(400, "BODY_NOT_JSON", "snapshot body is not valid JSON");
    }

    const snapshot = validateSnapshotV1(parsed);
    if (snapshot.processes.length > this.config.maxProcesses) {
      reject(413, "PROCESS_COUNT_EXCEEDED", "snapshot exceeds the maximum process count");
    }
    this.#requireCapturedAtInWindow(snapshot.capturedAt, receivedAt);

    return this.#storeSnapshot({ agent, snapshot, bodySha256, receivedAt });
  }

  async readCurrent({ tenantId, hostId }) {
    const host = await this.store.readHost(tenantId, hostId);
    if (!host?.publishedGeneration) {
      reject(404, "NO_PUBLISHED_GENERATION", "host has no published generation");
    }
    const generation = await this.store.readGeneration(tenantId, hostId, host.publishedGeneration);
    const processes = await this.store.listProcesses(tenantId, hostId, host.publishedGeneration, {
      limit: this.config.maxProcesses
    });
    return {
      tenantId,
      hostId,
      snapshotId: host.publishedGeneration,
      capturedAt: host.publishedCapturedAt ?? null,
      processCount: generation?.expectedProcessCount ?? processes.length,
      processes
    };
  }

  async #storeSnapshot({ agent, snapshot, bodySha256, receivedAt }) {
    const batches = chunk(snapshot.processes, this.config.processBatchSize);
    const input = {
      tenantId: agent.tenantId,
      hostId: agent.hostId,
      agentId: agent.agentId,
      snapshotId: snapshot.snapshotId,
      bodyHash: bodySha256,
      capturedAt: snapshot.capturedAt,
      expectedProcessCount: snapshot.processes.length,
      expectedBatchCount: batches.length
    };

    try {
      const begun = await this.repository.beginSnapshot(input);
      if (begun.generation.status !== "published") {
        if (WRITABLE_STATES.has(begun.generation.status)) {
          for (const [batchIndex, processes] of batches.entries()) {
            await this.repository.stageBatch({ ...input, batchIndex, processes });
          }
        }
        await this.repository.markReady(input);
      }
      const published = await this.repository.publish(input);
      return {
        snapshotId: snapshot.snapshotId,
        capturedAt: snapshot.capturedAt,
        processCount: snapshot.processes.length,
        expiresAt: new Date(
          receivedAt.getTime() + this.config.snapshotRetentionSeconds * 1000
        ).toISOString(),
        ...published
      };
    } catch (error) {
      if (error instanceof RepositoryError) {
        throw new ApiError(statusForRepositoryCode(error.code), error.code, error.message);
      }
      throw error;
    }
  }

  #requireFreshTimestamp(timestamp, receivedAt) {
    const skewMs = Math.abs(Date.parse(timestamp) - receivedAt.getTime());
    if (skewMs > this.config.replayClockSkewSeconds * 1000) {
      reject(401, "TIMESTAMP_OUT_OF_WINDOW", "request timestamp is outside the allowed clock skew");
    }
  }

  #requireCapturedAtInWindow(capturedAt, receivedAt) {
    const driftMs = Date.parse(capturedAt) - receivedAt.getTime();
    if (driftMs > this.config.capturedAtFutureSkewSeconds * 1000) {
      reject(400, "CAPTURED_AT_IN_FUTURE", "capturedAt is too far in the future");
    }
    if (-driftMs > this.config.capturedAtPastLimitSeconds * 1000) {
      reject(400, "CAPTURED_AT_TOO_OLD", "capturedAt is older than the spool window");
    }
  }

  async #recordReplay(auth, receivedAt) {
    const replayId = replayDocumentId(auth);
    try {
      await this.replayStore.create(replayId, {
        agentId: auth.agentId,
        kid: auth.kid,
        nonce: auth.nonce,
        receivedAt,
        expiresAt: new Date(receivedAt.getTime() + this.config.replayTtlSeconds * 1000).toISOString()
      });
    } catch (error) {
      if (error?.code === "REPLAY_DETECTED") {
        reject(401, "REPLAY_DETECTED", "nonce has already been used for this agent and key");
      }
      reject(503, "REPLAY_STORE_UNAVAILABLE", "replay record could not be written");
    }
  }
}
