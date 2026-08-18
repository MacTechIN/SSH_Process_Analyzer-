import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createApp } from "../../collector-api/src/index.js";
import { createConfig } from "../../collector/src/config.js";
import { acquireLock } from "../../collector/src/lock.js";
import { runOnce } from "../../collector/src/run-once.js";
import { Spool } from "../../collector/src/spool.js";

const TENANT_ID = "tenant-a";
const HOST_ID = "host-1";
const AGENT_ID = "agent_01";
const KID = "key_01";

async function setup(t) {
  const stateDir = await mkdtemp(join(tmpdir(), "collector-run-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));

  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const privateKeyPath = join(stateDir, "agent-key.pem");
  await writeFile(privateKeyPath, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });

  const app = createApp({ DEV_READ_API_ENABLED: "true" });
  app.store.seedAgent({
    tenantId: TENANT_ID,
    hostId: HOST_ID,
    agentId: AGENT_ID,
    quarantined: false,
    keys: {
      [KID]: {
        publicKey: Buffer.from(publicKey.export({ format: "der", type: "spki" }).subarray(12)).toString(
          "base64url"
        ),
        revokedAt: null
      }
    }
  });
  app.store.seedHost({ tenantId: TENANT_ID, hostId: HOST_ID });

  await new Promise((resolve) => app.server.listen(0, resolve));
  t.after(() => new Promise((resolve) => app.server.close(resolve)));
  const origin = `http://127.0.0.1:${app.server.address().port}`;

  const config = (env = {}) =>
    createConfig({
      API_BASE_URL: origin,
      AGENT_ID,
      AGENT_KEY_ID: KID,
      STATE_DIR: stateDir,
      PUSH_MAX_ATTEMPTS: "1",
      PUSH_BASE_BACKOFF_MS: "1",
      ...env
    });

  return { app, origin, stateDir, config };
}

function collected(logs, event) {
  return logs.find((entry) => entry.event === event);
}

test("collects real /proc processes, signs them, and publishes them through the api", async (t) => {
  const { origin, config } = await setup(t);
  const logs = [];

  const result = await runOnce({ config: config(), log: (entry) => logs.push(entry) });

  assert.equal(result.skipped, false);
  assert.equal(result.pushed, true);
  assert.equal(collected(logs, "pushed").published, true);
  assert.ok(collected(logs, "pushed").processCount > 0);

  const current = await (await fetch(`${origin}/v1/tenants/${TENANT_ID}/hosts/${HOST_ID}/current`)).json();
  assert.equal(current.snapshotId, result.snapshotId);
  assert.ok(current.processes.length > 0);

  const sample = current.processes[0];
  assert.match(sample.processKey, /^[a-f0-9]{64}$/);
  assert.match(sample.ownerName, /^[A-Za-z0-9_.-]{1,128}$/);
  assert.equal(sample.classificationStatus, "unclassified");
  assert.equal(sample.taskType, null);
  assert.ok(sample.allowedArgs.length <= 16);
});

test("never sends a raw command line or an environment block", async (t) => {
  const { origin, config } = await setup(t);
  await runOnce({ config: config() });

  const current = await (await fetch(`${origin}/v1/tenants/${TENANT_ID}/hosts/${HOST_ID}/current`)).json();
  const allowedFields = new Set([
    "processKey",
    "bootId",
    "pid",
    "startTicks",
    "startedAt",
    "ownerName",
    "executable",
    "allowedArgs",
    "workingDirectory",
    "taskType",
    "classificationStatus",
    "cpuPercent",
    "memoryBytes"
  ]);

  for (const process of current.processes) {
    for (const field of Object.keys(process)) {
      assert.ok(allowedFields.has(field), `${field} must not reach the browser`);
    }
  }
});

test("spools the exact wire body when the api is unreachable and resends it later", async (t) => {
  const { origin, stateDir, config } = await setup(t);
  const offline = config({ API_BASE_URL: "http://127.0.0.1:1" });

  const capturedAtMs = Date.now();
  const failed = await runOnce({ config: offline, log: () => {}, nowMs: capturedAtMs });
  assert.equal(failed.pushed, false);
  assert.equal(failed.spooled, true);

  const spool = new Spool(offline);
  const [spooledEntry] = await spool.list();
  assert.ok(spooledEntry);
  const spooledBytes = await spool.read(spooledEntry);

  const logs = [];
  const recovered = await runOnce({
    config: config(),
    log: (entry) => logs.push(entry),
    nowMs: capturedAtMs + 2000
  });
  assert.equal(recovered.pushed, true);
  assert.equal(recovered.spool.resent, 1);
  assert.equal(collected(logs, "spool-resent").snapshotId, spooledEntry.snapshotId);
  assert.equal((await spool.list()).length, 0);

  const history = new Spool(config({ STATE_DIR: stateDir }));
  assert.equal((await history.list()).length, 0);
  assert.ok(spooledBytes.length > 0);

  const current = await (await fetch(`${origin}/v1/tenants/${TENANT_ID}/hosts/${HOST_ID}/current`)).json();
  assert.equal(current.snapshotId, recovered.snapshotId);
});

test("a resent snapshot captured in the same second does not move the current pointer", async (t) => {
  const { origin, config } = await setup(t);
  const capturedAtMs = Date.now();
  const offline = config({ API_BASE_URL: "http://127.0.0.1:1" });

  const spooledRun = await runOnce({ config: offline, log: () => {}, nowMs: capturedAtMs });
  const [spooledEntry] = await new Spool(offline).list();
  const recovered = await runOnce({ config: config(), log: () => {}, nowMs: capturedAtMs });

  assert.equal(spooledRun.spooled, true);
  assert.equal(recovered.pushed, true);
  assert.notEqual(recovered.snapshotId, spooledEntry.snapshotId);

  const current = await (await fetch(`${origin}/v1/tenants/${TENANT_ID}/hosts/${HOST_ID}/current`)).json();
  assert.equal(current.snapshotId, spooledEntry.snapshotId);
});

test("drops a spooled snapshot the api permanently rejects", async (t) => {
  const { app, config } = await setup(t);
  const offline = config({ API_BASE_URL: "http://127.0.0.1:1" });
  await runOnce({ config: offline, log: () => {} });

  app.store.seedAgent({
    tenantId: TENANT_ID,
    hostId: HOST_ID,
    agentId: AGENT_ID,
    quarantined: true,
    keys: (await app.store.findAgent(AGENT_ID)).keys
  });

  const logs = [];
  await runOnce({ config: config(), log: (entry) => logs.push(entry) });

  assert.equal(collected(logs, "spool-dropped").status, 403);
  assert.equal((await new Spool(offline).list()).length, 0);
});

test("refuses to run while another collector run holds the lock", async (t) => {
  const { config } = await setup(t);
  const running = config();
  const lock = await acquireLock(running.lockPath, { staleMs: running.lockStaleMs });
  t.after(() => lock.release());

  const logs = [];
  const result = await runOnce({ config: running, log: (entry) => logs.push(entry) });

  assert.deepEqual(result, { skipped: true });
  assert.equal(collected(logs, "skipped").reason, "another collector run holds the lock");
});
