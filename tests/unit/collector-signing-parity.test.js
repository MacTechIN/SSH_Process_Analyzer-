import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import * as api from "../../collector-api/src/signing.js";
import * as collector from "../../collector/src/signing.js";

const fixture = JSON.parse(
  await readFile(new URL("../fixtures/signing-v1.json", import.meta.url), "utf8")
);

const input = {
  bodySha256: fixture.bodySha256LowerHex,
  timestamp: fixture.timestampRfc3339Utc,
  nonce: fixture.nonceLowerHex64,
  agentId: fixture.agentId,
  kid: fixture.kid
};

test("collector and collector-api produce the same canonical payload", () => {
  assert.deepEqual(collector.canonicalPayload(input), api.canonicalPayload(input));
  assert.equal(collector.canonicalPayload(input).toString("utf8"), fixture.canonicalUtf8);
});

test("collector and collector-api compute the same wire body digest", () => {
  const wireBody = Buffer.from(fixture.bodyUtf8, "utf8");
  assert.equal(collector.bodyDigest(wireBody), api.bodyDigest(wireBody));
  assert.equal(collector.bodyDigest(wireBody), fixture.bodySha256LowerHex);
});

test("collector nonces and timestamps match the header contract", () => {
  assert.match(collector.createNonce(), api.NONCE_PATTERN);
  assert.match(collector.signingTimestamp(new Date("2026-08-17T01:02:03.456Z")), api.TIMESTAMP_PATTERN);
  assert.equal(collector.signingTimestamp(new Date("2026-08-17T01:02:03.456Z")), "2026-08-17T01:02:03Z");
});
