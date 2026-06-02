import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);

async function readJson(path) {
  return JSON.parse(await readFile(new URL(path, root), "utf8"));
}

async function readEnv(path) {
  const text = await readFile(new URL(path, root), "utf8");
  return Object.fromEntries(
    text
      .split("\n")
      .filter((line) => line && !line.startsWith("#"))
      .map((line) => line.split("=", 2))
  );
}

test("snapshot policy stays within the documented MVP boundaries", async () => {
  const policy = await readJson("contracts/operational-policy-v1.json");
  assert.equal(policy.snapshot.maxProcesses, 10_000);
  assert.equal(policy.snapshot.firestoreProcessBatchSize, 400);
  assert.ok(policy.snapshot.firestoreProcessBatchSize <= 500);
  assert.equal(policy.snapshot.overflowPolicy, "reject-413");
  assert.deepEqual(policy.snapshot.allowedContentEncodings, ["identity", "gzip"]);
});

test("collector-api env defaults match operational policy", async () => {
  const policy = await readJson("contracts/operational-policy-v1.json");
  const env = await readEnv("collector-api/.env.example");
  assert.equal(Number(env.SNAPSHOT_RETENTION_SECONDS), policy.snapshot.retentionSeconds);
  assert.equal(Number(env.REPLAY_TTL_SECONDS), policy.security.replayTtlSeconds);
  assert.equal(Number(env.MAX_WIRE_BODY_BYTES), policy.snapshot.maxWireBodyBytes);
  assert.equal(Number(env.MAX_DECOMPRESSED_BODY_BYTES), policy.snapshot.maxDecompressedBodyBytes);
  assert.equal(Number(env.MAX_PROCESSES_PER_SNAPSHOT), policy.snapshot.maxProcesses);
  assert.equal(Number(env.FIRESTORE_PROCESS_BATCH_SIZE), policy.snapshot.firestoreProcessBatchSize);
});

test("collector spool env defaults match operational policy", async () => {
  const policy = await readJson("contracts/operational-policy-v1.json");
  const env = await readEnv("collector/.env.example");
  assert.equal(Number(env.COLLECT_INTERVAL_SECONDS), policy.collector.intervalSeconds);
  assert.equal(Number(env.SPOOL_MAX_BYTES), policy.collector.spool.maxBytes);
  assert.equal(Number(env.SPOOL_MAX_FILES), policy.collector.spool.maxFiles);
  assert.equal(Number(env.SPOOL_RETENTION_SECONDS), policy.collector.spool.retentionSeconds);
});
