function countBy(rows, pick) {
  const counts = new Map();
  for (const row of rows) {
    const key = pick(row);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function descending(entries) {
  return entries.sort((left, right) => right.count - left.count || left.key.localeCompare(right.key));
}

export function processesPerOwner(rows) {
  return descending(
    [...countBy(rows, (row) => row.ownerName).entries()].map(([key, count]) => ({ key, count }))
  );
}

export function taskTypeShare(rows) {
  const total = rows.length;
  return descending(
    [...countBy(rows, (row) => row.taskLabel).entries()].map(([key, count]) => ({ key, count }))
  ).map((entry) => ({ ...entry, share: total === 0 ? 0 : (entry.count / total) * 100 }));
}

// Current processes bucketed by the hour they started, oldest bucket first.
export function hourlyStartTrend(rows, nowMs, hours = 24) {
  const buckets = [];
  const hourMs = 3600 * 1000;
  const currentHour = Math.floor(nowMs / hourMs) * hourMs;

  for (let offset = hours - 1; offset >= 0; offset -= 1) {
    const start = currentHour - offset * hourMs;
    buckets.push({ start: new Date(start).toISOString(), count: 0 });
  }

  for (const row of rows) {
    if (!row.startedAt) {
      continue;
    }
    const startedHour = Math.floor(Date.parse(row.startedAt) / hourMs) * hourMs;
    const index = buckets.findIndex((bucket) => Date.parse(bucket.start) === startedHour);
    if (index >= 0) {
      buckets[index].count += 1;
    }
  }

  return buckets;
}

export function hostLoad(rows) {
  const load = new Map();
  for (const row of rows) {
    const current = load.get(row.hostId) ?? { key: row.hostId, cpuPercent: 0, memoryBytes: 0, count: 0 };
    current.cpuPercent += row.cpuPercent ?? 0;
    current.memoryBytes += row.memoryBytes ?? 0;
    current.count += 1;
    load.set(row.hostId, current);
  }
  return [...load.values()].sort((left, right) => right.cpuPercent - left.cpuPercent);
}

export function longestRunning(rows, limit = 10) {
  return [...rows]
    .filter((row) => Number.isFinite(row.runtimeSeconds))
    .sort((left, right) => right.runtimeSeconds - left.runtimeSeconds)
    .slice(0, limit);
}

export function exceptionBuckets(rows) {
  return {
    unclassified: rows.filter((row) => row.unclassified),
    longRunning: rows.filter((row) => row.longRunning),
    duplicate: rows.filter((row) => row.duplicateSuspected),
    degradedHost: rows.filter((row) => row.hostState !== "online")
  };
}
