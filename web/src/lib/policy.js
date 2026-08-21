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
