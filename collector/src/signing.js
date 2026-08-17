import { createHash, createPrivateKey, randomBytes, sign } from "node:crypto";
import { readFile } from "node:fs/promises";

const CANONICAL_METHOD = "POST";
const CANONICAL_PATH = "/v1/snapshots";

export function bodyDigest(wireBody) {
  return createHash("sha256").update(wireBody).digest("hex");
}

export function canonicalPayload({ bodySha256, timestamp, nonce, agentId, kid }) {
  const lines = [CANONICAL_METHOD, CANONICAL_PATH, bodySha256, timestamp, nonce, agentId, kid];
  return Buffer.from(`${lines.join("\n")}\n`, "utf8");
}

export function createNonce() {
  return randomBytes(32).toString("hex");
}

export function signingTimestamp(date) {
  return `${date.toISOString().slice(0, 19)}Z`;
}

export async function loadPrivateKey(path) {
  return createPrivateKey(await readFile(path, "utf8"));
}

export function keyFingerprint(privateKey) {
  const spki = privateKey.export({ format: "der", type: "pkcs8" });
  return createHash("sha256").update(spki).digest("hex").slice(0, 32);
}

export function createSigner({ agentId, kid, privateKey }) {
  return {
    agentId,
    kid,
    sign({ wireBody, timestamp, nonce }) {
      const payload = canonicalPayload({
        bodySha256: bodyDigest(wireBody),
        timestamp,
        nonce,
        agentId,
        kid
      });
      return {
        "x-agent-id": agentId,
        "x-agent-key-id": kid,
        "x-agent-timestamp": timestamp,
        "x-agent-nonce": nonce,
        "x-agent-signature": Buffer.from(sign(null, payload, privateKey)).toString("base64url")
      };
    }
  };
}
