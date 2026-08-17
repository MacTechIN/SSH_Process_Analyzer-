import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { acquireLock } from "./lock.js";
import { collectProcesses } from "./proc.js";
import { createSigner, keyFingerprint, loadPrivateKey } from "./signing.js";
import { buildSnapshot, buildWireBody } from "./snapshot.js";
import { Spool } from "./spool.js";
import { createSender } from "./sender.js";

export async function readInstallationInstanceId(path) {
  try {
    const existing = (await readFile(path, "utf8")).trim();
    if (existing) {
      return existing;
    }
  } catch {
    // fall through and create a new identifier
  }
  const created = randomUUID();
  await mkdir(path.slice(0, path.lastIndexOf("/")) || ".", { recursive: true, mode: 0o700 });
  await writeFile(path, `${created}\n`, { mode: 0o600 });
  return created;
}

async function resendSpooled({ spool, sender, log, maxResendPerRun }) {
  const summary = { resent: 0, dropped: 0, deferred: 0 };
  const entries = await spool.list();

  for (const entry of entries.slice(0, maxResendPerRun)) {
    const wireBody = await spool.read(entry);
    const result = await sender.send({
      wireBody,
      contentEncoding: entry.contentEncoding,
      snapshotId: entry.snapshotId
    });

    if (result.ok) {
      await spool.remove(entry);
      summary.resent += 1;
      log({ event: "spool-resent", snapshotId: entry.snapshotId, status: result.status });
      continue;
    }
    if (!result.retryable) {
      await spool.remove(entry);
      summary.dropped += 1;
      log({
        event: "spool-dropped",
        snapshotId: entry.snapshotId,
        status: result.status,
        code: result.code
      });
      continue;
    }
    summary.deferred += 1;
    log({ event: "spool-deferred", snapshotId: entry.snapshotId, code: result.code });
    break;
  }

  return summary;
}

export async function runOnce({ config, log = () => {}, nowMs = Date.now(), deps = {} }) {
  const lock = await acquireLock(config.lockPath, { staleMs: config.lockStaleMs, nowMs });
  if (!lock) {
    log({ event: "skipped", reason: "another collector run holds the lock" });
    return { skipped: true };
  }

  try {
    const privateKey = deps.privateKey ?? (await loadPrivateKey(config.privateKeyPath));
    const signer = createSigner({ agentId: config.agentId, kid: config.kid, privateKey });
    const sender = deps.sender ?? createSender({ config, signer, ...deps.senderOptions });
    const spool = deps.spool ?? new Spool(config);

    const installationInstanceId = await readInstallationInstanceId(config.installationIdPath);
    log({
      event: "run-start",
      agentId: config.agentId,
      kid: config.kid,
      installationInstanceId,
      keyFingerprint: keyFingerprint(privateKey)
    });

    await spool.init();
    await spool.enforceLimits(nowMs);
    const spoolSummary = await resendSpooled({
      spool,
      sender,
      log,
      maxResendPerRun: config.maxResendPerRun
    });

    const { processes } = await collectProcesses(config, { nowMs });
    const snapshot = buildSnapshot({ processes, capturedAtMs: nowMs });
    const wire = buildWireBody(snapshot, { gzipEnabled: config.gzipEnabled });

    if (processes.length > config.maxProcesses) {
      log({ event: "process-count-over-limit", processCount: processes.length });
    }

    const result = await sender.send(wire);
    if (result.ok) {
      log({
        event: "pushed",
        snapshotId: wire.snapshotId,
        processCount: wire.processCount,
        attempts: result.attempts,
        published: result.payload?.published
      });
      return { skipped: false, pushed: true, snapshotId: wire.snapshotId, spool: spoolSummary };
    }

    if (!result.retryable) {
      log({
        event: "rejected",
        snapshotId: wire.snapshotId,
        status: result.status,
        code: result.code
      });
      return { skipped: false, pushed: false, rejected: true, spool: spoolSummary };
    }

    const spooled = await spool.save({
      snapshotId: wire.snapshotId,
      wireBody: wire.wireBody,
      contentEncoding: wire.contentEncoding,
      createdAtMs: nowMs
    });
    log({ event: "spooled", snapshotId: wire.snapshotId, spooled: spooled.spooled, reason: spooled.reason });
    return { skipped: false, pushed: false, spooled: spooled.spooled, spool: spoolSummary };
  } finally {
    await lock.release();
  }
}
