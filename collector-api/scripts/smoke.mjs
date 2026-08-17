import { generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import { createApp } from "../src/index.js";
import { bodyDigest, canonicalPayload } from "../src/signing.js";

const TENANT_ID = "tenant-dev";
const HOST_ID = "host-dev";
const AGENT_ID = "agent_dev";
const KID = "key_dev";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const rawPublicKey = Buffer.from(publicKey.export({ format: "der", type: "spki" }).subarray(12)).toString(
  "base64url"
);

const app = createApp({ DEV_READ_API_ENABLED: "true", PORT: "0" });
app.store.seedAgent({
  tenantId: TENANT_ID,
  hostId: HOST_ID,
  agentId: AGENT_ID,
  quarantined: false,
  keys: { [KID]: { publicKey: rawPublicKey, revokedAt: null } }
});
app.store.seedHost({ tenantId: TENANT_ID, hostId: HOST_ID });

await new Promise((resolve) => app.server.listen(0, resolve));
const origin = `http://127.0.0.1:${app.server.address().port}`;

function rfc3339(date) {
  return `${date.toISOString().slice(0, 19)}Z`;
}

function processKeyFor(index) {
  return `${index}`.padStart(64, "b");
}

const snapshot = {
  schemaVersion: 1,
  snapshotId: randomUUID(),
  capturedAt: rfc3339(new Date()),
  processes: [0, 1, 2].map((index) => ({
    processKey: processKeyFor(index),
    bootId: "8d2f5f1e-2b7c-4a3d-9f11-0c1d2e3f4a5b",
    pid: 4000 + index,
    startTicks: 900 + index,
    startedAt: rfc3339(new Date(Date.now() - 3600 * 1000)),
    ownerName: ["alice", "bob", "alice"][index],
    executable: "/usr/bin/python3",
    allowedArgs: ["train.py"],
    workingDirectory: "/srv/jobs",
    taskType: "batch-job",
    classificationStatus: "classified",
    cpuPercent: 10 + index,
    memoryBytes: 1048576 * (index + 1)
  }))
};

const wireBody = Buffer.from(JSON.stringify(snapshot), "utf8");
const timestamp = rfc3339(new Date());
const nonce = randomBytes(32).toString("hex");
const payload = canonicalPayload({
  bodySha256: bodyDigest(wireBody),
  timestamp,
  nonce,
  agentId: AGENT_ID,
  kid: KID
});

const pushed = await fetch(`${origin}/v1/snapshots`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-agent-id": AGENT_ID,
    "x-agent-key-id": KID,
    "x-agent-timestamp": timestamp,
    "x-agent-nonce": nonce,
    "x-agent-signature": Buffer.from(sign(null, payload, privateKey)).toString("base64url")
  },
  body: wireBody
});
console.log("POST /v1/snapshots ->", pushed.status, await pushed.json());

const current = await fetch(`${origin}/v1/tenants/${TENANT_ID}/hosts/${HOST_ID}/current`);
const view = await current.json();
console.log("GET current ->", current.status, {
  snapshotId: view.snapshotId,
  capturedAt: view.capturedAt,
  processCount: view.processCount,
  owners: view.processes.map((process) => process.ownerName)
});

app.server.close();
