// Mirrors contracts/operational-policy-v1.json.
// tests/unit/web-policy-contract.test.js keeps the two in sync.
export const HEALTH = {
  staleAfterSeconds: 120,
  warnAfterSeconds: 300,
  offlineAfterSeconds: 900
};

export const CLASSIFICATION = {
  longRunningAfterSeconds: 86400,
  duplicateSuspicionScope: ["hostId", "ownerName", "taskType", "executable"],
  duplicateSuspicionMinimumCount: 2
};

export const HISTORY_PAGE_SIZE = 50;

export const DEFAULT_COLLECT_INTERVAL_SECONDS = 60;

// The policy thresholds describe a 60 second collector. A deployment that collects less
// often is not unhealthy, so the same ratios are scaled to the configured interval.
export function healthThresholdsFor(collectIntervalSeconds = DEFAULT_COLLECT_INTERVAL_SECONDS) {
  const interval = Number(collectIntervalSeconds);
  if (!Number.isFinite(interval) || interval <= 0) {
    return HEALTH;
  }
  const scale = interval / DEFAULT_COLLECT_INTERVAL_SECONDS;
  return {
    staleAfterSeconds: HEALTH.staleAfterSeconds * scale,
    warnAfterSeconds: HEALTH.warnAfterSeconds * scale,
    offlineAfterSeconds: HEALTH.offlineAfterSeconds * scale
  };
}
