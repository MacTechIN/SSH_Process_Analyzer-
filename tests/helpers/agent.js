import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { bodyDigest, canonicalPayload } from "../../collector-api/src/signing.js";

const SPKI_HEADER_BYTES = 12;

export function createAgentKeyPair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ format: "der", type: "spki" });
  return {
    privateKey,
    publicKeyBase64url: Buffer.from(spki.subarray(SPKI_HEADER_BYTES)).toString("base64url")
  };
}

export function nonceHex() {
  return randomBytes(32).toString("hex");
}

export function rfc3339(date) {
  return `${date.toISOString().slice(0, 19)}Z`;
}

export function signedHeaders({ wireBody, agentId, kid, privateKey, timestamp, nonce, bodySha256 }) {
  const digest = bodySha256 ?? bodyDigest(wireBody);
  const payload = canonicalPayload({ bodySha256: digest, timestamp, nonce, agentId, kid });
  return {
    "x-agent-id": agentId,
    "x-agent-key-id": kid,
    "x-agent-timestamp": timestamp,
    "x-agent-nonce": nonce,
    "x-agent-signature": Buffer.from(sign(null, payload, privateKey)).toString("base64url")
  };
}

export function buildSnapshot({ snapshotId, capturedAt, processes = [] }) {
  return {
    schemaVersion: 1,
    snapshotId,
    capturedAt,
    processes
  };
}

export function buildProcess(index = 0, overrides = {}) {
  return {
    processKey: `${index}`.padStart(64, "a"),
    bootId: "8d2f5f1e-2b7c-4a3d-9f11-0c1d2e3f4a5b",
    pid: 1000 + index,
    startTicks: 1234 + index,
    startedAt: "2026-08-17T00:00:00Z",
    ownerName: "alice",
    executable: "/usr/bin/python3",
    allowedArgs: ["train.py"],
    workingDirectory: "/srv/jobs",
    taskType: "batch-job",
    classificationStatus: "classified",
    cpuPercent: 12.5,
    memoryBytes: 1048576,
    ...overrides
  };
}
