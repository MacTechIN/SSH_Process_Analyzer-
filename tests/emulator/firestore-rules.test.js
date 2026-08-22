import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { assertFails, assertSucceeds, initializeTestEnvironment } from "@firebase/rules-unit-testing";
import { doc, getDoc, setDoc } from "firebase/firestore";

const emulator = process.env.FIRESTORE_EMULATOR_HOST;
const TENANT = "tenant-a";
const OTHER_TENANT = "tenant-b";
const HOST = "host-1";
const PUBLISHED = "generation-published";
const STAGING = "generation-staging";

let environment;

if (emulator) {
  const [host, port] = emulator.split(":");
  environment = await initializeTestEnvironment({
    projectId: "demo-rules-matrix",
    firestore: {
      host,
      port: Number(port),
      rules: await readFile(new URL("../../firebase/firestore.rules", import.meta.url), "utf8")
    }
  });

  await environment.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await setDoc(doc(db, `tenants/${TENANT}`), { name: "tenant a" });
    await setDoc(doc(db, `tenants/${TENANT}/memberships/alice`), { role: "viewer" });
    await setDoc(doc(db, `tenants/${TENANT}/hosts/${HOST}`), { publishedGeneration: PUBLISHED });
    await setDoc(doc(db, `tenants/${TENANT}/hosts/${HOST}/generations/${PUBLISHED}`), { status: "published" });
    await setDoc(
      doc(db, `tenants/${TENANT}/hosts/${HOST}/generations/${PUBLISHED}/processes/process-1`),
      { ownerName: "alice" }
    );
    await setDoc(doc(db, `tenants/${TENANT}/hosts/${HOST}/generations/${STAGING}`), { status: "staging" });
    await setDoc(
      doc(db, `tenants/${TENANT}/hosts/${HOST}/generations/${STAGING}/processes/process-1`),
      { ownerName: "alice" }
    );
    await setDoc(doc(db, `tenants/${TENANT}/hosts/${HOST}/snapshots/snapshot-1`), { capturedAt: "2026-08-17T00:00:00Z" });
    await setDoc(doc(db, `tenants/${TENANT}/agents/agent_01`), { agentId: "agent_01" });
    await setDoc(doc(db, `tenants/${OTHER_TENANT}/hosts/host-9`), { publishedGeneration: "other" });
    await setDoc(doc(db, "replayRecords/replay-1"), { agentId: "agent_01" });
  });

  test.after(() => environment.cleanup());
}

const options = { skip: !emulator };
const member = () => environment.authenticatedContext("alice").firestore();
const stranger = () => environment.authenticatedContext("mallory").firestore();
const anonymous = () => environment.unauthenticatedContext().firestore();

test("unauthenticated clients cannot read tenant data", options, async () => {
  const db = anonymous();
  await assertFails(getDoc(doc(db, `tenants/${TENANT}`)));
  await assertFails(getDoc(doc(db, `tenants/${TENANT}/hosts/${HOST}`)));
  await assertFails(getDoc(doc(db, `tenants/${TENANT}/hosts/${HOST}/generations/${PUBLISHED}`)));
});

test("members read their tenant, hosts, and the current published generation", options, async () => {
  const db = member();
  await assertSucceeds(getDoc(doc(db, `tenants/${TENANT}`)));
  await assertSucceeds(getDoc(doc(db, `tenants/${TENANT}/hosts/${HOST}`)));
  await assertSucceeds(getDoc(doc(db, `tenants/${TENANT}/hosts/${HOST}/generations/${PUBLISHED}`)));
  await assertSucceeds(
    getDoc(doc(db, `tenants/${TENANT}/hosts/${HOST}/generations/${PUBLISHED}/processes/process-1`))
  );
});

test("members cannot read a generation the host does not point at", options, async () => {
  const db = member();
  await assertFails(getDoc(doc(db, `tenants/${TENANT}/hosts/${HOST}/generations/${STAGING}`)));
  await assertFails(
    getDoc(doc(db, `tenants/${TENANT}/hosts/${HOST}/generations/${STAGING}/processes/process-1`))
  );
});

test("non members are denied across the whole tenant", options, async () => {
  const db = stranger();
  await assertFails(getDoc(doc(db, `tenants/${TENANT}`)));
  await assertFails(getDoc(doc(db, `tenants/${TENANT}/hosts/${HOST}`)));
  await assertFails(getDoc(doc(db, `tenants/${TENANT}/hosts/${HOST}/generations/${PUBLISHED}`)));
});

test("members of one tenant cannot cross into another tenant", options, async () => {
  await assertFails(getDoc(doc(member(), `tenants/${OTHER_TENANT}/hosts/host-9`)));
});

test("snapshot history, agents, and replay records are closed to every client", options, async () => {
  for (const db of [member(), stranger(), anonymous()]) {
    await assertFails(getDoc(doc(db, `tenants/${TENANT}/hosts/${HOST}/snapshots/snapshot-1`)));
    await assertFails(getDoc(doc(db, `tenants/${TENANT}/agents/agent_01`)));
    await assertFails(getDoc(doc(db, "replayRecords/replay-1")));
  }
});

test("membership documents are readable only by their own uid", options, async () => {
  await assertSucceeds(getDoc(doc(member(), `tenants/${TENANT}/memberships/alice`)));
  await assertFails(getDoc(doc(member(), `tenants/${TENANT}/memberships/mallory`)));
});

// Without this the membership check is circular and a non member cannot tell
// "no membership" apart from "read denied".
test("a signed in non member can read their own missing membership document", options, async () => {
  await assertSucceeds(getDoc(doc(stranger(), `tenants/${TENANT}/memberships/mallory`)));
  await assertFails(getDoc(doc(anonymous(), `tenants/${TENANT}/memberships/mallory`)));
});

test("no client can write anywhere", options, async () => {
  const db = member();
  await assertFails(setDoc(doc(db, `tenants/${TENANT}`), { name: "hijacked" }));
  await assertFails(setDoc(doc(db, `tenants/${TENANT}/hosts/${HOST}`), { publishedGeneration: STAGING }));
  await assertFails(
    setDoc(doc(db, `tenants/${TENANT}/hosts/${HOST}/generations/${PUBLISHED}`), { status: "published" })
  );
  await assertFails(
    setDoc(doc(db, `tenants/${TENANT}/hosts/${HOST}/generations/${PUBLISHED}/processes/process-2`), {
      ownerName: "mallory"
    })
  );
  await assertFails(setDoc(doc(db, `tenants/${TENANT}/agents/agent_01`), { agentId: "agent_01" }));
  await assertFails(setDoc(doc(db, "replayRecords/replay-2"), { agentId: "agent_01" }));
});
