import { readFileSync } from "node:fs";

const POLICY_URL = new URL("../../contracts/operational-policy-v1.json", import.meta.url);

export const operationalPolicy = JSON.parse(readFileSync(POLICY_URL, "utf8"));

function number(env, name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw === "") {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${name} must be a number`);
  }
  return parsed;
}

export function createConfig(env = process.env, policy = operationalPolicy) {
  const projectId = env.GOOGLE_CLOUD_PROJECT ?? "";
  return {
    port: number(env, "PORT", 8080),
    host: env.HOST ?? "0.0.0.0",
    storageDriver: env.STORAGE_DRIVER ?? (projectId ? "firestore" : "memory"),
    projectId,
    databaseId: env.FIRESTORE_DATABASE_ID ?? "(default)",
    maxWireBodyBytes: number(env, "MAX_WIRE_BODY_BYTES", policy.snapshot.maxWireBodyBytes),
    maxDecompressedBodyBytes: number(
      env,
      "MAX_DECOMPRESSED_BODY_BYTES",
      policy.snapshot.maxDecompressedBodyBytes
    ),
    maxProcesses: number(env, "MAX_PROCESSES_PER_SNAPSHOT", policy.snapshot.maxProcesses),
    processBatchSize: number(env, "FIRESTORE_PROCESS_BATCH_SIZE", policy.snapshot.firestoreProcessBatchSize),
    allowedContentEncodings: policy.snapshot.allowedContentEncodings,
    replayClockSkewSeconds: number(env, "REPLAY_CLOCK_SKEW_SECONDS", policy.security.replayClockSkewSeconds),
    replayTtlSeconds: number(env, "REPLAY_TTL_SECONDS", policy.security.replayTtlSeconds),
    capturedAtFutureSkewSeconds: number(
      env,
      "CAPTURED_AT_FUTURE_SKEW_SECONDS",
      policy.security.capturedAtFutureSkewSeconds
    ),
    capturedAtPastLimitSeconds: number(
      env,
      "CAPTURED_AT_PAST_LIMIT_SECONDS",
      policy.security.capturedAtPastLimitSeconds
    ),
    snapshotRetentionSeconds: number(env, "SNAPSHOT_RETENTION_SECONDS", policy.snapshot.retentionSeconds),
    devReadApiEnabled: env.DEV_READ_API_ENABLED === "true",
    historyPageSizeLimit: number(env, "HISTORY_PAGE_SIZE_LIMIT", 100),
    historyCursorTtlSeconds: number(env, "HISTORY_CURSOR_TTL_SECONDS", 900),
    cursorSigningSecret: env.CURSOR_SIGNING_SECRET ?? "",
    cursorSigningKeyId: env.CURSOR_SIGNING_KEY_ID ?? "v1",
    cleanup: {
      intervalSeconds: number(env, "CLEANUP_INTERVAL_SECONDS", policy.cleanup.intervalSeconds),
      maxGenerationsPerRun: number(env, "CLEANUP_MAX_GENERATIONS_PER_RUN", policy.cleanup.maxGenerationsPerRun),
      timeoutSeconds: number(env, "CLEANUP_TIMEOUT_SECONDS", policy.cleanup.timeoutSeconds),
      maxRetries: number(env, "CLEANUP_MAX_RETRIES", policy.cleanup.maxRetries)
    }
  };
}
