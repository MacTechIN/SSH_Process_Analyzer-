import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createConfig } from "../../collector/src/config.js";
import { Spool } from "../../collector/src/spool.js";

async function setup(t, env = {}) {
  const dir = await mkdtemp(join(tmpdir(), "collector-spool-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const config = createConfig({ STATE_DIR: dir, ...env });
  const spool = new Spool(config);
  await spool.init();
  return { spool, config, dir };
}

function body(size = 32) {
  return Buffer.alloc(size, 1);
}

test("stores the exact wire bytes with owner only permissions", async (t) => {
  const { spool, config } = await setup(t);
  const snapshotId = randomUUID();
  const wireBody = body(64);

  await spool.save({ snapshotId, wireBody, contentEncoding: "gzip", createdAtMs: 1_000_000 });
  const [entry] = await spool.list();

  assert.equal(entry.snapshotId, snapshotId);
  assert.equal(entry.contentEncoding, "gzip");
  assert.deepEqual(await spool.read(entry), wireBody);
  assert.equal((await stat(entry.path)).mode & 0o777, 0o600);
  assert.equal((await stat(config.spoolDir)).mode & 0o777, 0o700);
});

test("drops entries past the retention window", async (t) => {
  const { spool } = await setup(t, { SPOOL_RETENTION_SECONDS: "60" });
  await spool.save({ snapshotId: randomUUID(), wireBody: body(), contentEncoding: "identity", createdAtMs: 0 });

  assert.equal((await spool.list()).length, 1);
  await spool.enforceLimits(120_000);
  assert.equal((await spool.list()).length, 0);
});

test("drops the oldest entries when the file count overflows", async (t) => {
  const { spool } = await setup(t, { SPOOL_MAX_FILES: "2" });
  for (const createdAtMs of [1000, 2000, 3000]) {
    await spool.save({
      snapshotId: randomUUID(),
      wireBody: body(),
      contentEncoding: "identity",
      createdAtMs
    });
  }

  const entries = await spool.list();
  assert.equal(entries.length, 2);
  assert.deepEqual(
    entries.map((entry) => entry.createdAtMs),
    [2000, 3000]
  );
});

test("drops the oldest entries when the byte budget overflows", async (t) => {
  const { spool } = await setup(t, { SPOOL_MAX_BYTES: "160" });
  for (const createdAtMs of [1000, 2000, 3000]) {
    await spool.save({
      snapshotId: randomUUID(),
      wireBody: body(100),
      contentEncoding: "identity",
      createdAtMs
    });
  }

  const entries = await spool.list();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].createdAtMs, 3000);
});

test("refuses entries above the per file limit", async (t) => {
  const { spool } = await setup(t, { SPOOL_MAX_FILE_BYTES: "64" });

  const result = await spool.save({
    snapshotId: randomUUID(),
    wireBody: body(128),
    contentEncoding: "identity",
    createdAtMs: 1000
  });

  assert.deepEqual(result, { spooled: false, reason: "file-too-large" });
  assert.equal((await spool.list()).length, 0);
});
