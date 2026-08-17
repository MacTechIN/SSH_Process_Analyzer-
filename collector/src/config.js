import { readFileSync } from "node:fs";
import { join } from "node:path";

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

function flag(env, name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw === "") {
    return fallback;
  }
  return raw === "true";
}

export function createConfig(env = process.env, policy = operationalPolicy) {
  const stateDir = env.STATE_DIR ?? "/var/lib/ssh-process-collector";
  return {
    apiBaseUrl: env.API_BASE_URL ?? "",
    agentId: env.AGENT_ID ?? "",
    kid: env.AGENT_KEY_ID ?? "",
    privateKeyPath: env.AGENT_PRIVATE_KEY_PATH ?? join(stateDir, "agent-key.pem"),
    stateDir,
    spoolDir: env.SPOOL_DIR ?? join(stateDir, "spool"),
    lockPath: env.LOCK_PATH ?? join(stateDir, "collector.lock"),
    installationIdPath: env.INSTALLATION_ID_PATH ?? join(stateDir, "installation-instance-id"),
    lockStaleMs: number(env, "LOCK_STALE_SECONDS", 900) * 1000,
    gzipEnabled: flag(env, "GZIP_ENABLED", true),
    includeKernelThreads: flag(env, "INCLUDE_KERNEL_THREADS", false),
    requestTimeoutMs: number(env, "REQUEST_TIMEOUT_SECONDS", 20) * 1000,
    maxAttempts: number(env, "PUSH_MAX_ATTEMPTS", 3),
    baseBackoffMs: number(env, "PUSH_BASE_BACKOFF_MS", 500),
    maxBackoffMs: number(env, "PUSH_MAX_BACKOFF_MS", 8000),
    maxResendPerRun: number(env, "SPOOL_MAX_RESEND_PER_RUN", 10),
    clockTicksPerSecond: number(env, "CLOCK_TICKS_PER_SECOND", 100),
    pageSizeBytes: number(env, "PAGE_SIZE_BYTES", 4096),
    procRoot: env.PROC_ROOT ?? "/proc",
    passwdPath: env.PASSWD_PATH ?? "/etc/passwd",
    maxProcesses: policy.snapshot.maxProcesses,
    maxAllowedArgs: 16,
    maxAllowedArgLength: 256,
    maxExecutableLength: 512,
    maxWorkingDirectoryLength: 1024,
    spool: {
      enabled: flag(env, "SPOOL_ENABLED", policy.collector.spool.enabled),
      maxBytes: number(env, "SPOOL_MAX_BYTES", policy.collector.spool.maxBytes),
      maxFiles: number(env, "SPOOL_MAX_FILES", policy.collector.spool.maxFiles),
      maxFileBytes: number(env, "SPOOL_MAX_FILE_BYTES", policy.collector.spool.maxFileBytes),
      retentionSeconds: number(env, "SPOOL_RETENTION_SECONDS", policy.collector.spool.retentionSeconds)
    }
  };
}

export function requireRuntimeConfig(config) {
  for (const field of ["apiBaseUrl", "agentId", "kid"]) {
    if (!config[field]) {
      throw new Error(`${field} is required. set API_BASE_URL, AGENT_ID and AGENT_KEY_ID`);
    }
  }
  return config;
}
