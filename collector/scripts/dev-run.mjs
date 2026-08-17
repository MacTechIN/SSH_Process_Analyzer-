import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../collector-api/src/index.js";
import { createConfig } from "../src/config.js";
import { runOnce } from "../src/run-once.js";

const TENANT_ID = "tenant-dev";
const HOST_ID = "host-dev";
const AGENT_ID = "agent_dev";
const KID = "key_dev";

const stateDir = await mkdtemp(join(tmpdir(), "collector-dev-"));
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
await writeFile(join(stateDir, "agent-key.pem"), privateKey.export({ type: "pkcs8", format: "pem" }), {
  mode: 0o600
});

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
const origin = `http://127.0.0.1:${app.server.address().port}`;

const config = createConfig({
  API_BASE_URL: origin,
  AGENT_ID,
  AGENT_KEY_ID: KID,
  STATE_DIR: stateDir
});

const result = await runOnce({ config, log: (entry) => console.log(JSON.stringify(entry)) });

const current = await (await fetch(`${origin}/v1/tenants/${TENANT_ID}/hosts/${HOST_ID}/current`)).json();
const owners = new Map();
for (const process of current.processes) {
  owners.set(process.ownerName, (owners.get(process.ownerName) ?? 0) + 1);
}

console.log("\ncurrent generation:", {
  snapshotId: current.snapshotId,
  capturedAt: current.capturedAt,
  processCount: current.processCount
});
console.log("processes per owner:", Object.fromEntries([...owners].sort((a, b) => b[1] - a[1]).slice(0, 5)));
console.log("\ntop cpu processes:");
console.table(
  [...current.processes]
    .sort((left, right) => right.cpuPercent - left.cpuPercent)
    .slice(0, 5)
    .map((process) => ({
      owner: process.ownerName,
      pid: process.pid,
      cpu: process.cpuPercent,
      memoryMiB: Math.round(process.memoryBytes / 1048576),
      executable: process.executable.slice(0, 40),
      args: process.allowedArgs.join(" ").slice(0, 40)
    }))
);

app.server.close();
process.exitCode = result.pushed ? 0 : 1;
