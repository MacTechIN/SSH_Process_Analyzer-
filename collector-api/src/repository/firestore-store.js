import { getApps, initializeApp } from "firebase-admin/app";
import { FieldPath, getFirestore } from "firebase-admin/firestore";
import { RepositoryError, fail } from "./errors.js";
import {
  FIRESTORE_MAX_BATCH_WRITES,
  FIRESTORE_MAX_TRANSACTION_WRITES,
  PROCESS_DELETE_CHUNK_SIZE
} from "./limits.js";

const ALREADY_EXISTS = 6;

export function createFirebaseApp({ projectId }) {
  return getApps().find((candidate) => candidate.name === projectId) ?? initializeApp({ projectId }, projectId);
}

export function createFirestore({ projectId, databaseId, app = createFirebaseApp({ projectId }) }) {
  const firestore = getFirestore(app, databaseId ?? "(default)");
  try {
    firestore.settings({ ignoreUndefinedProperties: true });
  } catch {
    // settings can only be applied once per Firestore instance
  }
  return firestore;
}

export class FirestoreStore {
  // Firestore deletes expired snapshot history through a TTL policy on expiresAt,
  // so the cleanup job only has to recurse into generations and their processes.
  historyTtlManaged = true;

  constructor(firestore) {
    this.db = firestore;
  }

  agentRef(tenantId, agentId) {
    return this.db.doc(`tenants/${tenantId}/agents/${agentId}`);
  }

  hostRef(tenantId, hostId) {
    return this.db.doc(`tenants/${tenantId}/hosts/${hostId}`);
  }

  generationRef(tenantId, hostId, snapshotId) {
    return this.hostRef(tenantId, hostId).collection("generations").doc(snapshotId);
  }

  processesRef(tenantId, hostId, snapshotId) {
    return this.generationRef(tenantId, hostId, snapshotId).collection("processes");
  }

  async transaction(callback) {
    try {
      return await this.db.runTransaction(async (transaction) => {
        return callback(new FirestoreTransaction(transaction, this));
      });
    } catch (error) {
      throw translate(error);
    }
  }

  async listProcessKeys(tenantId, hostId, snapshotId, options = {}) {
    const limit = options.limit ?? PROCESS_DELETE_CHUNK_SIZE;
    const snapshot = await this.processesRef(tenantId, hostId, snapshotId).select().limit(limit).get();
    return snapshot.docs.map((doc) => doc.id);
  }

  async listProcesses(tenantId, hostId, snapshotId, options = {}) {
    const limit = options.limit ?? PROCESS_DELETE_CHUNK_SIZE;
    const snapshot = await this.processesRef(tenantId, hostId, snapshotId).limit(limit).get();
    return snapshot.docs.map((doc) => doc.data());
  }

  async deleteProcessChunk(tenantId, hostId, snapshotId, processKeys) {
    if (processKeys.length > FIRESTORE_MAX_BATCH_WRITES) {
      fail("BATCH_WRITE_LIMIT", `a write batch cannot exceed ${FIRESTORE_MAX_BATCH_WRITES} operations`);
    }
    const processes = this.processesRef(tenantId, hostId, snapshotId);
    const batch = this.db.batch();
    for (const processKey of processKeys) {
      batch.delete(processes.doc(processKey));
    }
    await batch.commit();
    return processKeys.length;
  }

  snapshotRef(tenantId, hostId, snapshotId) {
    return this.hostRef(tenantId, hostId).collection("snapshots").doc(snapshotId);
  }

  async listSnapshotHistory(tenantId, hostId, options = {}) {
    let query = this.hostRef(tenantId, hostId)
      .collection("snapshots")
      .orderBy("capturedAt", "desc")
      .orderBy(FieldPath.documentId(), "desc");
    if (options.capturedAtFrom) {
      query = query.where("capturedAt", ">=", options.capturedAtFrom);
    }
    if (options.startAfter) {
      query = query.startAfter(options.startAfter.capturedAt, options.startAfter.snapshotId);
    }
    const snapshot = await query.limit(options.limit ?? 50).get();
    return snapshot.docs.map((doc) => doc.data());
  }

  async listExpiredGenerations(nowIso, limit) {
    const snapshot = await this.db
      .collectionGroup("generations")
      .where("expiresAt", "<=", nowIso)
      .orderBy("expiresAt")
      .limit(limit)
      .get();
    return snapshot.docs.map((doc) => doc.data());
  }

  async deleteSnapshotHistory(tenantId, hostId, snapshotIds) {
    const batch = this.db.batch();
    for (const snapshotId of snapshotIds) {
      batch.delete(this.snapshotRef(tenantId, hostId, snapshotId));
    }
    await batch.commit();
    return snapshotIds.length;
  }

  async readAgent(tenantId, agentId) {
    const doc = await this.agentRef(tenantId, agentId).get();
    return doc.exists ? doc.data() : undefined;
  }

  async readMembership(tenantId, uid) {
    const doc = await this.db.doc(`tenants/${tenantId}/memberships/${uid}`).get();
    return doc.exists ? doc.data() : undefined;
  }

  async appendAgentAudit(entry) {
    await this.agentRef(entry.tenantId, entry.agentId).collection("auditLog").add(entry);
    return entry;
  }

  async listAgentAudit(tenantId, agentId) {
    const snapshot = await this.agentRef(tenantId, agentId).collection("auditLog").get();
    return snapshot.docs.map((doc) => doc.data());
  }

  async seedSnapshotHistory(record) {
    await this.snapshotRef(record.tenantId, record.hostId, record.snapshotId).set(record);
  }

  async seedMembership(membership) {
    await this.db.doc(`tenants/${membership.tenantId}/memberships/${membership.uid}`).set(membership);
  }

  async findAgent(agentId) {
    const snapshot = await this.db
      .collectionGroup("agents")
      .where("agentId", "==", agentId)
      .limit(2)
      .get();
    if (snapshot.size > 1) {
      fail("AGENT_ID_NOT_UNIQUE", "agent id resolves to more than one tenant");
    }
    return snapshot.empty ? undefined : snapshot.docs[0].data();
  }

  async readHost(tenantId, hostId) {
    const doc = await this.hostRef(tenantId, hostId).get();
    return doc.exists ? doc.data() : undefined;
  }

  async readGeneration(tenantId, hostId, snapshotId) {
    const doc = await this.generationRef(tenantId, hostId, snapshotId).get();
    return doc.exists ? doc.data() : undefined;
  }

  async seedAgent(agent) {
    await this.agentRef(agent.tenantId, agent.agentId).set(agent);
  }

  async seedHost(host) {
    await this.hostRef(host.tenantId, host.hostId).set(host);
  }
}

class FirestoreTransaction {
  #transaction;
  #store;
  #writes = 0;
  #written = false;

  constructor(transaction, store) {
    this.#transaction = transaction;
    this.#store = store;
  }

  async getAgent(tenantId, agentId) {
    return this.#read(this.#store.agentRef(tenantId, agentId));
  }

  async getHost(tenantId, hostId) {
    return this.#read(this.#store.hostRef(tenantId, hostId));
  }

  async setHost(host) {
    this.#write(() => this.#transaction.set(this.#store.hostRef(host.tenantId, host.hostId), host));
  }

  async getGeneration(tenantId, hostId, snapshotId) {
    return this.#read(this.#store.generationRef(tenantId, hostId, snapshotId));
  }

  async setGeneration(generation) {
    this.#write(() =>
      this.#transaction.set(
        this.#store.generationRef(generation.tenantId, generation.hostId, generation.snapshotId),
        generation
      )
    );
  }

  async deleteGeneration(tenantId, hostId, snapshotId) {
    this.#write(() => this.#transaction.delete(this.#store.generationRef(tenantId, hostId, snapshotId)));
  }

  async setSnapshotHistory(record) {
    this.#write(() =>
      this.#transaction.set(
        this.#store.snapshotRef(record.tenantId, record.hostId, record.snapshotId),
        record
      )
    );
  }

  async createProcess(tenantId, hostId, snapshotId, process) {
    this.#write(() =>
      this.#transaction.create(
        this.#store.processesRef(tenantId, hostId, snapshotId).doc(process.processKey),
        process
      )
    );
  }

  async #read(reference) {
    if (this.#written) {
      fail("TRANSACTION_READ_AFTER_WRITE", "all transaction reads must precede transaction writes");
    }
    const doc = await this.#transaction.get(reference);
    return doc.exists ? doc.data() : undefined;
  }

  #write(operation) {
    this.#written = true;
    this.#writes += 1;
    if (this.#writes > FIRESTORE_MAX_TRANSACTION_WRITES) {
      fail("TRANSACTION_WRITE_LIMIT", `a transaction cannot exceed ${FIRESTORE_MAX_TRANSACTION_WRITES} writes`);
    }
    operation();
  }
}

function translate(error) {
  if (error instanceof RepositoryError) {
    return error;
  }
  if (error?.code === ALREADY_EXISTS) {
    return new RepositoryError("PROCESS_KEY_CONFLICT", "process keys are immutable within a generation");
  }
  return error;
}
