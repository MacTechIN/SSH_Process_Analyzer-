import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { formatBytes, formatDuration, formatPercent } from "../../web/src/lib/format.js";
import { CLASSIFICATION, HEALTH } from "../../web/src/lib/policy.js";
import {
  buildRows,
  computeKpis,
  distinctValues,
  filterRows,
  paginate,
  sortRows
} from "../../web/src/lib/process-view.js";
import { hostHealth } from "../../web/src/lib/status.js";

const NOW = Date.parse("2026-08-21T12:00:00Z");

function process(overrides = {}) {
  return {
    processKey: "a".repeat(64),
    hostId: "web-01",
    pid: 1000,
    ownerName: "alice",
    executable: "/usr/bin/python3",
    allowedArgs: ["train.py"],
    taskType: "batch-job",
    classificationStatus: "classified",
    startedAt: "2026-08-21T11:00:00Z",
    cpuPercent: 10,
    memoryBytes: 1048576,
    ...overrides
  };
}

const onlineHost = { lastSuccessAt: "2026-08-21T11:59:30Z", publishedCapturedAt: "2026-08-21T11:59:30Z" };

test("web policy constants match the operational policy contract", async () => {
  const policy = JSON.parse(
    await readFile(new URL("../../contracts/operational-policy-v1.json", import.meta.url), "utf8")
  );
  assert.deepEqual(HEALTH, policy.health);
  assert.equal(CLASSIFICATION.longRunningAfterSeconds, policy.classification.longRunningAfterSeconds);
  assert.deepEqual(CLASSIFICATION.duplicateSuspicionScope, policy.classification.duplicateSuspicionScope);
  assert.equal(
    CLASSIFICATION.duplicateSuspicionMinimumCount,
    policy.classification.duplicateSuspicionMinimumCount
  );
});

test("host health separates a healthy publish, staleness, and an ingest failure", () => {
  assert.equal(hostHealth(onlineHost, NOW).state, "online");
  assert.equal(hostHealth({ lastSuccessAt: "2026-08-21T11:57:00Z" }, NOW).state, "stale");
  assert.equal(hostHealth({ lastSuccessAt: "2026-08-21T11:50:00Z" }, NOW).state, "warn");
  assert.equal(hostHealth({ lastSuccessAt: "2026-08-21T11:00:00Z" }, NOW).state, "offline");
  assert.equal(hostHealth(undefined, NOW).state, "unknown");

  const rejected = hostHealth(
    { ...onlineHost, lastOutcome: "rejected", lastErrorCategory: "schema", lastAttemptAt: "2026-08-21T11:59:50Z" },
    NOW
  );
  assert.equal(rejected.state, "online");
  assert.deepEqual(rejected.ingestFailure, { category: "schema", at: "2026-08-21T11:59:50Z" });
});

test("rows carry long running, duplicate, and unclassified flags", () => {
  const rows = buildRows({
    processes: [
      process({ processKey: "1", startedAt: "2026-08-19T00:00:00Z" }),
      process({ processKey: "2" }),
      process({ processKey: "3" }),
      process({ processKey: "4", ownerName: "bob", taskType: null, classificationStatus: "unclassified" })
    ],
    hosts: { "web-01": onlineHost },
    nowMs: NOW
  });

  assert.equal(rows[0].longRunning, true);
  assert.equal(rows[1].duplicateSuspected, true, "two identical scopes are suspected");
  assert.equal(rows[2].duplicateSuspected, true);
  assert.equal(rows[3].unclassified, true);
  assert.equal(rows[3].taskLabel, "미분류");
  assert.equal(rows[1].commandSummary, "/usr/bin/python3 train.py");
});

test("a lone process is never flagged as a duplicate", () => {
  const rows = buildRows({
    processes: [process({ processKey: "1" }), process({ processKey: "2", ownerName: "bob" })],
    hosts: { "web-01": onlineHost },
    nowMs: NOW
  });
  assert.deepEqual(
    rows.map((row) => row.duplicateSuspected),
    [false, false]
  );
});

test("sorting puts exceptions before the busiest processes", () => {
  const rows = buildRows({
    processes: [
      process({ processKey: "busy", cpuPercent: 90 }),
      process({ processKey: "long", cpuPercent: 1, startedAt: "2026-08-01T00:00:00Z" }),
      process({ processKey: "idle", cpuPercent: 5 })
    ],
    hosts: { "web-01": onlineHost },
    nowMs: NOW
  });

  assert.deepEqual(
    sortRows(rows).map((row) => row.processKey),
    ["long", "busy", "idle"]
  );
});

test("filters narrow by owner, task type, host, status, runtime, and search", () => {
  const rows = buildRows({
    processes: [
      process({ processKey: "1", ownerName: "alice", startedAt: "2026-08-21T11:59:00Z" }),
      process({ processKey: "2", ownerName: "bob", taskType: "web-server", hostId: "web-02" }),
      process({
        processKey: "3",
        ownerName: "carol",
        taskType: null,
        classificationStatus: "unclassified",
        startedAt: "2026-08-01T00:00:00Z",
        executable: "/usr/bin/rsync"
      })
    ],
    hosts: { "web-01": onlineHost, "web-02": onlineHost },
    nowMs: NOW
  });

  assert.equal(filterRows(rows, { ownerName: "bob" }).length, 1);
  assert.equal(filterRows(rows, { taskType: "web-server" }).length, 1);
  assert.equal(filterRows(rows, { hostId: "web-02" }).length, 1);
  assert.equal(filterRows(rows, { status: "unclassified" })[0].processKey, "3");
  assert.equal(filterRows(rows, { status: "long-running" })[0].processKey, "3");
  assert.equal(filterRows(rows, { runtime: "under-1h" })[0].processKey, "1");
  assert.equal(filterRows(rows, { runtime: "over-24h" })[0].processKey, "3");
  assert.equal(filterRows(rows, { search: "rsync" })[0].processKey, "3");
  assert.equal(filterRows(rows, { search: "ALICE" }).length, 1);
  assert.equal(filterRows(rows, {}).length, 3);
});

test("kpi cards count owners, tasks, exceptions, and degraded hosts", () => {
  const hosts = { "web-01": onlineHost, "web-02": { lastSuccessAt: "2026-08-21T11:00:00Z" } };
  const rows = buildRows({
    processes: [
      process({ processKey: "1", ownerName: "alice" }),
      process({ processKey: "2", ownerName: "bob", startedAt: "2026-08-01T00:00:00Z" }),
      process({ processKey: "3", ownerName: "bob", classificationStatus: "unclassified", taskType: null })
    ],
    hosts,
    nowMs: NOW
  });

  assert.deepEqual(computeKpis(rows, hosts, NOW), {
    activeOwners: 2,
    runningTasks: 3,
    longRunning: 1,
    unclassified: 1,
    degradedHosts: 1
  });
});

test("pagination clamps the page and reports totals", () => {
  const rows = Array.from({ length: 7 }, (_, index) => ({ processKey: `p-${index}` }));

  assert.deepEqual(paginate(rows, { page: 1, pageSize: 3 }).rows.length, 3);
  assert.equal(paginate(rows, { page: 3, pageSize: 3 }).rows.length, 1);
  assert.equal(paginate(rows, { page: 99, pageSize: 3 }).page, 3);
  assert.equal(paginate(rows, { page: 0, pageSize: 3 }).page, 1);
  assert.equal(paginate(rows, { page: 1, pageSize: 3 }).total, 7);
});

test("distinct values feed the filter dropdowns", () => {
  const rows = [{ ownerName: "bob" }, { ownerName: "alice" }, { ownerName: "bob" }];
  assert.deepEqual(distinctValues(rows, "ownerName"), ["alice", "bob"]);
});

test("formatters stay readable for the table", () => {
  assert.equal(formatDuration(45), "45초");
  assert.equal(formatDuration(3600 * 5 + 120), "5시간 2분");
  assert.equal(formatDuration(86400 * 2 + 3600), "2일 1시간");
  assert.equal(formatDuration(-1), "-");
  assert.equal(formatBytes(1048576), "1.0 MiB");
  assert.equal(formatBytes(1536), "1.5 KiB");
  assert.equal(formatBytes(12 * 1048576), "12 MiB");
  assert.equal(formatPercent(12.345), "12.3%");
});

test("health thresholds scale with the deployment collection interval", async () => {
  const { healthThresholdsFor } = await import("../../web/src/lib/policy.js");

  assert.deepEqual(healthThresholdsFor(60), HEALTH);
  assert.deepEqual(healthThresholdsFor(3600), {
    staleAfterSeconds: 7200,
    warnAfterSeconds: 18000,
    offlineAfterSeconds: 54000
  });
  assert.deepEqual(healthThresholdsFor(undefined), HEALTH);
  assert.deepEqual(healthThresholdsFor("not a number"), HEALTH);

  const hourly = healthThresholdsFor(3600);
  const oneHourStale = { lastSuccessAt: "2026-08-21T11:00:00Z" };
  assert.equal(hostHealth(oneHourStale, NOW).state, "offline", "60초 기준에서는 오프라인");
  assert.equal(hostHealth(oneHourStale, NOW, hourly).state, "online", "1시간 주기에서는 정상");
});
