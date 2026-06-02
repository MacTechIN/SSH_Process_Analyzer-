import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const rulesPath = new URL("../../firebase/firestore.rules", import.meta.url);

test("web writes, history reads, agent reads, and replay reads are denied", async () => {
  const rules = await readFile(rulesPath, "utf8");
  assert.match(rules, /match \/snapshots\/\{snapshotId\} \{\s+allow read, write: if false;/);
  assert.match(rules, /match \/agents\/\{agentId\} \{\s+allow read, write: if false;/);
  assert.match(rules, /match \/replayRecords\/\{recordId\} \{\s+allow read, write: if false;/);
});

test("generation and process reads require membership and current published pointer", async () => {
  const rules = await readFile(rulesPath, "utf8");
  assert.match(rules, /function isTenantMember\(tenantId\)/);
  assert.match(rules, /function isPublishedGeneration\(tenantId, hostId, generationId\)/);
  assert.match(rules, /allow read: if isTenantMember\(tenantId\)\s+&& isPublishedGeneration\(tenantId, hostId, generationId\);/);
});
