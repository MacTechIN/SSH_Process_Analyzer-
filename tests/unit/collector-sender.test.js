import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { createConfig } from "../../collector/src/config.js";
import { createSender, backoffDelayMs } from "../../collector/src/sender.js";
import { canonicalPayload, createSigner } from "../../collector/src/signing.js";

const config = createConfig({
  API_BASE_URL: "https://collector.example",
  AGENT_ID: "agent_01",
  AGENT_KEY_ID: "key_01",
  PUSH_MAX_ATTEMPTS: "3",
  STATE_DIR: "/tmp/collector-sender-test"
});

function signer() {
  const { privateKey } = generateKeyPairSync("ed25519");
  return createSigner({ agentId: config.agentId, kid: config.kid, privateKey });
}

function jsonResponse(status, payload = {}) {
  return { ok: status >= 200 && status < 300, status, json: async () => payload };
}

function recordingFetch(statuses) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), headers: init.headers, body: init.body });
    return jsonResponse(statuses[calls.length - 1] ?? 200);
  };
  return { calls, fetchImpl };
}

test("retries retryable statuses with a fresh nonce and an unchanged body", async () => {
  const { calls, fetchImpl } = recordingFetch([500, 429, 200]);
  const sender = createSender({ config, signer: signer(), fetchImpl, sleep: async () => {}, random: () => 0.5 });
  const wireBody = Buffer.from("snapshot-bytes");

  const result = await sender.send({ wireBody, contentEncoding: "identity", snapshotId: "snapshot-1" });

  assert.equal(result.ok, true);
  assert.equal(result.attempts, 3);
  assert.equal(calls.length, 3);
  assert.equal(new Set(calls.map((call) => call.headers["x-agent-nonce"])).size, 3);
  assert.equal(new Set(calls.map((call) => call.headers["x-agent-signature"])).size, 3);
  for (const call of calls) {
    assert.deepEqual(call.body, wireBody);
  }
});

test("does not retry client rejections", async () => {
  const { calls, fetchImpl } = recordingFetch([409]);
  const sender = createSender({ config, signer: signer(), fetchImpl, sleep: async () => {} });

  const result = await sender.send({
    wireBody: Buffer.from("snapshot-bytes"),
    contentEncoding: "identity",
    snapshotId: "snapshot-1"
  });

  assert.equal(result.ok, false);
  assert.equal(result.retryable, false);
  assert.equal(result.status, 409);
  assert.equal(calls.length, 1);
});

test("reports a retryable failure after the attempt budget is spent", async () => {
  const { calls, fetchImpl } = recordingFetch([503, 503, 503]);
  const sender = createSender({ config, signer: signer(), fetchImpl, sleep: async () => {} });

  const result = await sender.send({
    wireBody: Buffer.from("snapshot-bytes"),
    contentEncoding: "identity",
    snapshotId: "snapshot-1"
  });

  assert.equal(result.ok, false);
  assert.equal(result.retryable, true);
  assert.equal(calls.length, 3);
});

test("sets the gzip content encoding only for gzip bodies", async () => {
  const { calls, fetchImpl } = recordingFetch([200, 200]);
  const sender = createSender({ config, signer: signer(), fetchImpl, sleep: async () => {} });

  await sender.send({ wireBody: Buffer.from("a"), contentEncoding: "gzip", snapshotId: "s1" });
  await sender.send({ wireBody: Buffer.from("a"), contentEncoding: "identity", snapshotId: "s2" });

  assert.equal(calls[0].headers["content-encoding"], "gzip");
  assert.equal(calls[1].headers["content-encoding"], undefined);
});

test("backoff grows exponentially, stays capped, and applies jitter", () => {
  const bounds = { baseBackoffMs: 500, maxBackoffMs: 8000, random: () => 1 };
  assert.equal(backoffDelayMs({ attempt: 1, ...bounds }), 500);
  assert.equal(backoffDelayMs({ attempt: 2, ...bounds }), 1000);
  assert.equal(backoffDelayMs({ attempt: 9, ...bounds }), 8000);
  assert.equal(backoffDelayMs({ attempt: 4, ...bounds, random: () => 0.25 }), 1000);
});

test("the signed payload binds the exact wire body digest", () => {
  const payload = canonicalPayload({
    bodySha256: "a".repeat(64),
    timestamp: "2026-08-17T00:00:00Z",
    nonce: "b".repeat(64),
    agentId: "agent_01",
    kid: "key_01"
  });
  assert.equal(payload.toString("utf8").split("\n").length, 8);
  assert.ok(payload.toString("utf8").endsWith("\n"));
});
