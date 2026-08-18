import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryStore } from "../../collector-api/src/repository/in-memory-store.js";
import { FIRESTORE_MAX_BATCH_WRITES } from "../../collector-api/src/repository/limits.js";

function setup() {
  const store = new InMemoryStore();
  store.seedHost({ tenantId: "tenant-a", hostId: "host-1" });
  return store;
}

test("transaction reads after a write are rejected like firestore", async () => {
  const store = setup();

  await assert.rejects(
    () =>
      store.transaction(async (tx) => {
        await tx.setHost({ tenantId: "tenant-a", hostId: "host-1" });
        await tx.getHost("tenant-a", "host-1");
      }),
    (error) => error.code === "TRANSACTION_READ_AFTER_WRITE"
  );
});

test("process delete chunks stay inside the firestore write batch limit", async () => {
  const store = setup();
  const processKeys = Array.from({ length: FIRESTORE_MAX_BATCH_WRITES + 1 }, (_, index) => `process-${index}`);

  await assert.rejects(
    () => store.deleteProcessChunk("tenant-a", "host-1", "snapshot-1", processKeys),
    (error) => error.code === "BATCH_WRITE_LIMIT"
  );
});

test("an agent id that resolves to more than one tenant fails closed", async () => {
  const store = setup();
  store.seedAgent({ tenantId: "tenant-a", hostId: "host-1", agentId: "agent_01" });
  store.seedAgent({ tenantId: "tenant-b", hostId: "host-9", agentId: "agent_01" });

  await assert.rejects(
    () => store.findAgent("agent_01"),
    (error) => error.code === "AGENT_ID_NOT_UNIQUE"
  );
});
