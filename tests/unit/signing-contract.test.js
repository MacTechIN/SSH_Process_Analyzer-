import assert from "node:assert/strict";
import { createHash, sign } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  bodyDigest,
  canonicalPayload,
  publicKeyFromRaw,
  replayDocumentId,
  verifyCanonicalSignature
} from "../../collector-api/src/signing.js";
import { createAgentKeyPair } from "../helpers/agent.js";

const fixture = JSON.parse(
  await readFile(new URL("../fixtures/signing-v1.json", import.meta.url), "utf8")
);

test("canonical signing v1 matches the recorded test vector", () => {
  assert.equal(bodyDigest(Buffer.from(fixture.bodyUtf8, "utf8")), fixture.bodySha256LowerHex);

  const payload = canonicalPayload({
    bodySha256: fixture.bodySha256LowerHex,
    timestamp: fixture.timestampRfc3339Utc,
    nonce: fixture.nonceLowerHex64,
    agentId: fixture.agentId,
    kid: fixture.kid
  });
  assert.equal(payload.toString("utf8"), fixture.canonicalUtf8);
  assert.equal(createHash("sha256").update(payload).digest("hex"), fixture.canonicalSha256LowerHex);
});

test("replay document id matches the recorded test vector", () => {
  const replayId = replayDocumentId({
    agentId: fixture.agentId,
    kid: fixture.kid,
    nonce: fixture.nonceLowerHex64
  });
  assert.equal(replayId, fixture.replayDocumentId);
});

test("ed25519 signatures verify only for the exact canonical payload", () => {
  const { privateKey, publicKeyBase64url } = createAgentKeyPair();
  const publicKey = publicKeyFromRaw(publicKeyBase64url);
  const payload = canonicalPayload({
    bodySha256: fixture.bodySha256LowerHex,
    timestamp: fixture.timestampRfc3339Utc,
    nonce: fixture.nonceLowerHex64,
    agentId: fixture.agentId,
    kid: fixture.kid
  });
  const signature = Buffer.from(sign(null, payload, privateKey)).toString("base64url");

  assert.equal(verifyCanonicalSignature({ payload, signatureBase64url: signature, publicKey }), true);

  const otherPayload = canonicalPayload({
    bodySha256: fixture.bodySha256LowerHex,
    timestamp: fixture.timestampRfc3339Utc,
    nonce: fixture.nonceLowerHex64,
    agentId: fixture.agentId,
    kid: "key_02"
  });
  assert.equal(
    verifyCanonicalSignature({ payload: otherPayload, signatureBase64url: signature, publicKey }),
    false
  );
});
