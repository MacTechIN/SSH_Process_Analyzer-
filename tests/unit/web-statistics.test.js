import assert from "node:assert/strict";
import test from "node:test";
import { buildRows } from "../../web/src/lib/process-view.js";
import {
  exceptionBuckets,
  hostLoad,
  hourlyStartTrend,
  longestRunning,
  processesPerOwner,
  taskTypeShare
} from "../../web/src/lib/statistics.js";

const NOW = Date.parse("2026-08-21T12:00:00Z");
const onlineHost = { lastSuccessAt: "2026-08-21T11:59:30Z" };

function rows() {
  return buildRows({
    processes: [
      {
        processKey: "1",
        hostId: "web-01",
        ownerName: "alice",
        taskType: "batch-job",
        classificationStatus: "classified",
        startedAt: "2026-08-21T11:30:00Z",
        cpuPercent: 30,
        memoryBytes: 1000
      },
      {
        processKey: "2",
        hostId: "web-01",
        ownerName: "alice",
        taskType: "web-server",
        classificationStatus: "classified",
        startedAt: "2026-08-21T10:30:00Z",
        cpuPercent: 10,
        memoryBytes: 2000
      },
      {
        processKey: "3",
        hostId: "web-02",
        ownerName: "bob",
        taskType: null,
        classificationStatus: "unclassified",
        startedAt: "2026-08-19T12:00:00Z",
        cpuPercent: 5,
        memoryBytes: 4000
      }
    ],
    hosts: { "web-01": onlineHost, "web-02": { lastSuccessAt: "2026-08-21T11:00:00Z" } },
    nowMs: NOW
  });
}

test("counts current work per owner", () => {
  assert.deepEqual(processesPerOwner(rows()), [
    { key: "alice", count: 2 },
    { key: "bob", count: 1 }
  ]);
});

test("task type share adds up to one hundred percent", () => {
  const share = taskTypeShare(rows());
  assert.equal(share.length, 3);
  assert.equal(share.find((entry) => entry.key === "미분류").count, 1);
  assert.equal(Math.round(share.reduce((sum, entry) => sum + entry.share, 0)), 100);
});

test("hourly trend buckets processes by their start hour", () => {
  const trend = hourlyStartTrend(rows(), NOW, 24);
  assert.equal(trend.length, 24);
  assert.equal(trend.at(-1).count, 0, "nothing started inside the current hour bucket");
  assert.equal(trend.at(-2).count, 1, "11:30 falls into the 11:00 bucket");
  assert.equal(trend.at(-3).count, 1, "10:30 falls into the 10:00 bucket");
  assert.equal(
    trend.reduce((sum, bucket) => sum + bucket.count, 0),
    2,
    "a two day old process is outside the window"
  );
});

test("host load sums cpu and memory per host", () => {
  assert.deepEqual(hostLoad(rows()), [
    { key: "web-01", cpuPercent: 40, memoryBytes: 3000, count: 2 },
    { key: "web-02", cpuPercent: 5, memoryBytes: 4000, count: 1 }
  ]);
});

test("longest running lists the oldest processes first", () => {
  assert.deepEqual(
    longestRunning(rows(), 2).map((row) => row.processKey),
    ["3", "2"]
  );
});

test("exception buckets separate each exception kind", () => {
  const buckets = exceptionBuckets(rows());
  assert.deepEqual(buckets.unclassified.map((row) => row.processKey), ["3"]);
  assert.deepEqual(buckets.longRunning.map((row) => row.processKey), ["3"]);
  assert.deepEqual(buckets.degradedHost.map((row) => row.processKey), ["3"]);
  assert.deepEqual(buckets.duplicate, []);
});
