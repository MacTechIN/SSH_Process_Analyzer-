import { createHash, createPublicKey, verify } from "node:crypto";

const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const ED25519_RAW_KEY_BYTES = 32;

export const CANONICAL_METHOD = "POST";
export const CANONICAL_PATH = "/v1/snapshots";

export const REGISTERED_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
export const NONCE_PATTERN = /^[0-9a-f]{64}$/;
export const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

export function bodyDigest(wireBody) {
  return createHash("sha256").update(wireBody).digest("hex");
}

export function canonicalPayload({ bodySha256, timestamp, nonce, agentId, kid }) {
  const lines = [CANONICAL_METHOD, CANONICAL_PATH, bodySha256, timestamp, nonce, agentId, kid];
  return Buffer.from(`${lines.join("\n")}\n`, "utf8");
}

export function replayDocumentId({ agentId, kid, nonce }) {
  return createHash("sha256").update([agentId, kid, nonce].join("\n"), "utf8").digest("hex");
}

export function publicKeyFromRaw(base64urlKey) {
  const raw = Buffer.from(base64urlKey, "base64url");
  if (raw.length !== ED25519_RAW_KEY_BYTES) {
    throw new Error("ed25519 public keys must be 32 raw bytes");
  }
  return createPublicKey({
    key: Buffer.concat([SPKI_ED25519_PREFIX, raw]),
    format: "der",
    type: "spki"
  });
}

export function verifyCanonicalSignature({ payload, signatureBase64url, publicKey }) {
  let signature;
  try {
    signature = Buffer.from(signatureBase64url, "base64url");
  } catch {
    return false;
  }
  if (signature.length !== 64) {
    return false;
  }
  return verify(null, payload, publicKey, signature);
}
