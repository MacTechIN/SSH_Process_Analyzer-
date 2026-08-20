const SKIPPABLE = new Set([
  "CURRENT_GENERATION",
  "GENERATION_ACTIVE",
  "RESUME_LEASE_ACTIVE",
  "GENERATION_NOT_FOUND"
]);

export async function runCleanup({
  store,
  repository,
  config,
  now = () => new Date(),
  log = () => {},
  limit
}) {
  const startedAtMs = now().getTime();
  const deadlineMs = startedAtMs + config.cleanup.timeoutSeconds * 1000;
  const maxGenerations = limit ?? config.cleanup.maxGenerationsPerRun;
  const summary = {
    examined: 0,
    deleted: 0,
    skipped: 0,
    failed: 0,
    deletedProcessCount: 0,
    deletedHistory: 0,
    timedOut: false
  };

  const candidates = await store.listExpiredGenerations(new Date(startedAtMs).toISOString(), maxGenerations);
  for (const generation of candidates) {
    if (now().getTime() >= deadlineMs) {
      summary.timedOut = true;
      break;
    }
    summary.examined += 1;
    const target = {
      tenantId: generation.tenantId,
      hostId: generation.hostId,
      snapshotId: generation.snapshotId
    };

    try {
      await repository.claimCleanup({ ...target, now: now().toISOString() });
      const result = await repository.finishCleanup({ ...target, deleteChunkSize: config.processBatchSize });
      summary.deleted += 1;
      summary.deletedProcessCount += result.deletedProcessCount;
      log({ event: "cleanup-deleted", ...target, processCount: result.deletedProcessCount });
    } catch (error) {
      if (SKIPPABLE.has(error?.code)) {
        summary.skipped += 1;
        log({ event: "cleanup-skipped", ...target, code: error.code });
        continue;
      }
      summary.failed += 1;
      log({ event: "cleanup-failed", ...target, code: error?.code ?? "UNKNOWN" });
    }
  }

  // Firestore removes expired snapshot history with a TTL policy on expiresAt.
  // Stores without that service have to delete the history here.
  if (!store.historyTtlManaged && store.listExpiredSnapshotHistory) {
    const expired = await store.listExpiredSnapshotHistory(now().toISOString(), maxGenerations);
    for (const record of expired) {
      await store.deleteSnapshotHistory(record.tenantId, record.hostId, [record.snapshotId]);
      summary.deletedHistory += 1;
    }
  }

  log({ event: "cleanup-summary", ...summary });
  return summary;
}
