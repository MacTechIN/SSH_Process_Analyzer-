import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { AgentRegistry } from "../../collector-api/src/agent-registry.js";
import { InMemoryStore } from "../../collector-api/src/repository/in-memory-store.js";

function publicKey() {
  const { publicKey: key } = generateKeyPairSync("ed25519");
  return Buffer.from(key.export({ format: "der", type: "spki" }).subarray(12)).toString("base64url");
}

function setup() {
  const store = new InMemoryStore();
  return { store, registry: new AgentRegistry({ store }) };
}

async function registered(registry, overrides = {}) {
  return registry.register({
    tenantId: "tenant-a",
    hostId: "host-1",
    agentId: "agent_01",
    kid: "key_01",
    publicKey: publicKey(),
    actor: "ops@example.com",
    ...overrides
  });
}

async function rejectsCode(action, code) {
  await assert.rejects(action, (error) => {
    assert.equal(error.code, code);
    return true;
  });
}

test("registering an agent creates the host and audits the action", async () => {
  const { store, registry } = setup();
  const agent = await registered(registry);

  assert.equal(agent.quarantined, false);
  assert.ok(await store.readHost("tenant-a", "host-1"));
  const [entry] = await store.listAgentAudit("tenant-a", "agent_01");
  assert.equal(entry.action, "register");
  assert.equal(entry.actor, "ops@example.com");
});

test("registering keeps the host publish pointer intact", async () => {
  const { store, registry } = setup();
  store.seedHost({ tenantId: "tenant-a", hostId: "host-1", publishedGeneration: "snapshot-1" });
  await registered(registry);

  assert.equal((await store.readHost("tenant-a", "host-1")).publishedGeneration, "snapshot-1");
});

test("agent ids stay unique and identifiers and keys are validated", async () => {
  const { registry } = setup();
  await registered(registry);

  await rejectsCode(() => registered(registry, { tenantId: "tenant-b" }), "AGENT_ALREADY_REGISTERED");
  await rejectsCode(() => registered(registry, { agentId: "bad id" }), "INVALID_IDENTIFIER");
  await rejectsCode(
    () => registered(registry, { agentId: "agent_02", publicKey: "not-a-key" }),
    "INVALID_PUBLIC_KEY"
  );
});

test("key rotation keeps the old key usable until it is revoked", async () => {
  const { registry } = setup();
  await registered(registry);

  await registry.rotateKey({ agentId: "agent_01", kid: "key_02", publicKey: publicKey(), actor: "ops" });
  let described = await registry.describe("agent_01");
  assert.deepEqual(
    described.keys.map((key) => [key.kid, key.active]),
    [["key_01", true], ["key_02", true]]
  );

  await registry.revokeKey({ agentId: "agent_01", kid: "key_01", actor: "ops" });
  described = await registry.describe("agent_01");
  assert.deepEqual(
    described.keys.map((key) => [key.kid, key.active]),
    [["key_01", false], ["key_02", true]]
  );
  assert.deepEqual(
    described.auditLog.map((entry) => entry.action),
    ["register", "rotate-key", "revoke-key"]
  );
});

test("revoking the last active key is refused", async () => {
  const { registry } = setup();
  await registered(registry);

  await rejectsCode(() => registry.revokeKey({ agentId: "agent_01", kid: "key_01", actor: "ops" }), "LAST_ACTIVE_KEY");
  await rejectsCode(() => registry.rotateKey({ agentId: "agent_01", kid: "key_01", publicKey: publicKey() }), "KEY_ALREADY_REGISTERED");
});

test("quarantine never clears itself and release requires an operator and a reason", async () => {
  const { registry } = setup();
  await registered(registry);

  await registry.quarantine({ agentId: "agent_01", reason: "installation id collision", actor: "ops" });
  assert.equal((await registry.describe("agent_01")).quarantined, true);

  await rejectsCode(() => registry.releaseQuarantine({ agentId: "agent_01", actor: "ops" }), "REASON_REQUIRED");
  await rejectsCode(
    () => registry.releaseQuarantine({ agentId: "agent_01", reason: "verified rebuild" }),
    "ACTOR_REQUIRED"
  );

  await registry.releaseQuarantine({ agentId: "agent_01", reason: "verified rebuild", actor: "ops" });
  const described = await registry.describe("agent_01");
  assert.equal(described.quarantined, false);
  assert.deepEqual(
    described.auditLog.map((entry) => entry.action),
    ["register", "quarantine", "release-quarantine"]
  );
});
