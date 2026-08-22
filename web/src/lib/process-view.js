import { HEALTH } from "./policy.js";
import { duplicateSuspicionKey, duplicateSuspicionKeys, hostHealth, isLongRunning } from "./status.js";

export const RUNTIME_BUCKETS = {
  "under-1h": { label: "1시간 미만", min: 0, max: 3600 },
  "1h-24h": { label: "1시간 ~ 24시간", min: 3600, max: 86400 },
  "over-24h": { label: "24시간 이상", min: 86400, max: Infinity }
};

export const STATUS_FILTERS = {
  "long-running": { label: "장시간 실행", matches: (row) => row.longRunning },
  duplicate: { label: "중복 실행 의심", matches: (row) => row.duplicateSuspected },
  unclassified: { label: "작업 유형 미분류", matches: (row) => row.unclassified },
  "host-degraded": { label: "최근 수집 없음", matches: (row) => row.hostState !== "online" }
};

export function buildRows({ processes, hosts = {}, nowMs, thresholds = HEALTH }) {
  const duplicates = duplicateSuspicionKeys(processes);
  const health = new Map();

  return processes.map((process) => {
    if (!health.has(process.hostId)) {
      health.set(process.hostId, hostHealth(hosts[process.hostId], nowMs, thresholds));
    }
    const hostState = health.get(process.hostId);
    const runtimeSeconds = process.startedAt ? (nowMs - Date.parse(process.startedAt)) / 1000 : null;

    return {
      ...process,
      runtimeSeconds,
      longRunning: isLongRunning(process.startedAt, nowMs),
      duplicateSuspected: duplicates.has(duplicateSuspicionKey(process)),
      unclassified: process.classificationStatus === "unclassified",
      taskLabel: process.taskType ?? "미분류",
      commandSummary: [process.executable, ...(process.allowedArgs ?? [])].join(" "),
      hostState: hostState.state,
      hostSecondsSincePublish: hostState.secondsSincePublish,
      hostIngestFailure: hostState.ingestFailure
    };
  });
}

export function exceptionScore(row) {
  return (
    (row.longRunning ? 1 : 0) +
    (row.duplicateSuspected ? 1 : 0) +
    (row.hostState !== "online" ? 1 : 0) +
    (row.unclassified ? 1 : 0)
  );
}

// Long running work and exceptional states come first, then the busiest processes.
export function sortRows(rows) {
  return [...rows].sort((left, right) => {
    const byException = exceptionScore(right) - exceptionScore(left);
    if (byException !== 0) {
      return byException;
    }
    const byCpu = (right.cpuPercent ?? 0) - (left.cpuPercent ?? 0);
    if (byCpu !== 0) {
      return byCpu;
    }
    return String(left.processKey).localeCompare(String(right.processKey));
  });
}

export function filterRows(rows, filters = {}) {
  const search = (filters.search ?? "").trim().toLowerCase();
  return rows.filter((row) => {
    if (filters.ownerName && row.ownerName !== filters.ownerName) {
      return false;
    }
    if (filters.taskType && row.taskLabel !== filters.taskType) {
      return false;
    }
    if (filters.hostId && row.hostId !== filters.hostId) {
      return false;
    }
    if (filters.status && !STATUS_FILTERS[filters.status]?.matches(row)) {
      return false;
    }
    if (filters.runtime) {
      const bucket = RUNTIME_BUCKETS[filters.runtime];
      if (!bucket || row.runtimeSeconds === null) {
        return false;
      }
      if (row.runtimeSeconds < bucket.min || row.runtimeSeconds >= bucket.max) {
        return false;
      }
    }
    if (search) {
      const haystack = [row.ownerName, row.taskLabel, row.hostId, row.commandSummary]
        .join(" ")
        .toLowerCase();
      if (!haystack.includes(search)) {
        return false;
      }
    }
    return true;
  });
}

export function paginate(rows, { page = 1, pageSize = 25 } = {}) {
  const pageCount = Math.max(1, Math.ceil(rows.length / pageSize));
  const current = Math.min(Math.max(1, page), pageCount);
  return {
    page: current,
    pageCount,
    total: rows.length,
    rows: rows.slice((current - 1) * pageSize, current * pageSize)
  };
}

export function computeKpis(rows, hosts = {}, nowMs, thresholds = HEALTH) {
  const degradedHosts = Object.values(hosts).filter(
    (host) => hostHealth(host, nowMs, thresholds).state !== "online"
  ).length;

  return {
    activeOwners: new Set(rows.map((row) => row.ownerName)).size,
    runningTasks: rows.length,
    longRunning: rows.filter((row) => row.longRunning).length,
    unclassified: rows.filter((row) => row.unclassified).length,
    degradedHosts
  };
}

export function distinctValues(rows, field) {
  return [...new Set(rows.map((row) => row[field]).filter(Boolean))].sort((left, right) =>
    String(left).localeCompare(String(right))
  );
}
