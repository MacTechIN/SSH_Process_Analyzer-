import { fail } from "./errors.js";
import {
  FIRESTORE_MAX_BATCH_WRITES,
  FIRESTORE_MAX_TRANSACTION_WRITES,
  PROCESS_DELETE_CHUNK_SIZE
} from "./limits.js";

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function key(...parts) {
  return parts.join("/");
}

function sortKey(record) {
  return `${record.capturedAt}\u0000${record.snapshotId}`;
}

function processPrefix(tenantId, hostId, snapshotId) {
  return `${key(tenantId, hostId, snapshotId)}/`;
}

export class InMemoryStore {
  #state = {
    agents: new Map(),
    hosts: new Map(),
    generations: new Map(),
    processes: new Map(),
    snapshots: new Map(),
    memberships: new Map(),
    agentAudit: []
  };

  async transaction(callback) {
    const draft = structuredClone(this.#state);
    const result = await callback(new InMemoryTransaction(draft));
    this.#state = draft;
    return result;
  }

  async listProcessKeys(tenantId, hostId, snapshotId, options = {}) {
    const limit = options.limit ?? PROCESS_DELETE_CHUNK_SIZE;
    const prefix = processPrefix(tenantId, hostId, snapshotId);
    const processKeys = [];
    for (const storedKey of this.#state.processes.keys()) {
      if (!storedKey.startsWith(prefix)) {
        continue;
      }
      processKeys.push(storedKey.slice(prefix.length));
      if (processKeys.length === limit) {
        break;
      }
    }
    return processKeys;
  }

  async findAgent(agentId) {
    const matches = [];
    for (const agent of this.#state.agents.values()) {
      if (agent.agentId === agentId) {
        matches.push(agent);
      }
      if (matches.length > 1) {
        fail("AGENT_ID_NOT_UNIQUE", "agent id resolves to more than one tenant");
      }
    }
    return matches.length === 1 ? clone(matches[0]) : undefined;
  }

  async readHost(tenantId, hostId) {
    return clone(this.#state.hosts.get(key(tenantId, hostId)));
  }

  async readGeneration(tenantId, hostId, snapshotId) {
    return clone(this.#state.generations.get(key(tenantId, hostId, snapshotId)));
  }

  async listProcesses(tenantId, hostId, snapshotId, options = {}) {
    const limit = options.limit ?? PROCESS_DELETE_CHUNK_SIZE;
    const prefix = processPrefix(tenantId, hostId, snapshotId);
    const processes = [];
    for (const [storedKey, process] of this.#state.processes.entries()) {
      if (!storedKey.startsWith(prefix)) {
        continue;
      }
      processes.push(clone(process));
      if (processes.length === limit) {
        break;
      }
    }
    return processes;
  }

  async deleteProcessChunk(tenantId, hostId, snapshotId, processKeys) {
    if (processKeys.length > FIRESTORE_MAX_BATCH_WRITES) {
      fail("BATCH_WRITE_LIMIT", `a write batch cannot exceed ${FIRESTORE_MAX_BATCH_WRITES} operations`);
    }
    const prefix = processPrefix(tenantId, hostId, snapshotId);
    for (const processKey of processKeys) {
      this.#state.processes.delete(prefix + processKey);
    }
    return processKeys.length;
  }

  async listSnapshotHistory(tenantId, hostId, options = {}) {
    const limit = options.limit ?? 50;
    const prefix = `${key(tenantId, hostId)}/`;
    const records = [...this.#state.snapshots.entries()]
      .filter(([storedKey]) => storedKey.startsWith(prefix))
      .map(([, record]) => clone(record))
      .filter((record) => !options.capturedAtFrom || record.capturedAt >= options.capturedAtFrom)
      .sort((left, right) => sortKey(right).localeCompare(sortKey(left)));

    const after = options.startAfter;
    const remaining = after
      ? records.filter((record) => sortKey(record).localeCompare(sortKey(after)) < 0)
      : records;
    return remaining.slice(0, limit);
  }

  async listExpiredGenerations(nowIso, limit) {
    return [...this.#state.generations.values()]
      .filter((generation) => generation.expiresAt && generation.expiresAt <= nowIso)
      .sort((left, right) => left.expiresAt.localeCompare(right.expiresAt))
      .slice(0, limit)
      .map((generation) => clone(generation));
  }

  async listExpiredSnapshotHistory(nowIso, limit) {
    return [...this.#state.snapshots.values()]
      .filter((record) => record.expiresAt && record.expiresAt <= nowIso)
      .slice(0, limit)
      .map((record) => clone(record));
  }

  async deleteSnapshotHistory(tenantId, hostId, snapshotIds) {
    for (const snapshotId of snapshotIds) {
      this.#state.snapshots.delete(key(tenantId, hostId, snapshotId));
    }
    return snapshotIds.length;
  }

  async readAgent(tenantId, agentId) {
    return clone(this.#state.agents.get(key(tenantId, agentId)));
  }

  async readMembership(tenantId, uid) {
    return clone(this.#state.memberships.get(key(tenantId, uid)));
  }

  async appendAgentAudit(entry) {
    this.#state.agentAudit.push(clone(entry));
    return entry;
  }

  async listAgentAudit(tenantId, agentId) {
    return this.#state.agentAudit
      .filter((entry) => entry.tenantId === tenantId && entry.agentId === agentId)
      .map((entry) => clone(entry));
  }

  seedSnapshotHistory(record) {
    this.#state.snapshots.set(key(record.tenantId, record.hostId, record.snapshotId), clone(record));
  }

  seedMembership(membership) {
    this.#state.memberships.set(key(membership.tenantId, membership.uid), clone(membership));
  }

  seedAgent(agent) {
    this.#state.agents.set(key(agent.tenantId, agent.agentId), clone(agent));
  }

  seedHost(host) {
    this.#state.hosts.set(key(host.tenantId, host.hostId), clone(host));
  }

  inspect() {
    return clone(this.#state);
  }
}

class InMemoryTransaction {
  #state;
  #writes = 0;
  #written = false;

  constructor(state) {
    this.#state = state;
  }

  async getAgent(tenantId, agentId) {
    return this.#read(() => clone(this.#state.agents.get(key(tenantId, agentId))));
  }

  async getHost(tenantId, hostId) {
    return this.#read(() => clone(this.#state.hosts.get(key(tenantId, hostId))));
  }

  async setHost(host) {
    this.#write(() => {
      this.#state.hosts.set(key(host.tenantId, host.hostId), clone(host));
    });
  }

  async getGeneration(tenantId, hostId, snapshotId) {
    return this.#read(() => clone(this.#state.generations.get(key(tenantId, hostId, snapshotId))));
  }

  async setGeneration(generation) {
    this.#write(() => {
      this.#state.generations.set(
        key(generation.tenantId, generation.hostId, generation.snapshotId),
        clone(generation)
      );
    });
  }

  async deleteGeneration(tenantId, hostId, snapshotId) {
    this.#write(() => {
      this.#state.generations.delete(key(tenantId, hostId, snapshotId));
    });
  }

  async setSnapshotHistory(record) {
    await this.#write(() => {
      this.#state.snapshots.set(
        key(record.tenantId, record.hostId, record.snapshotId),
        clone(record)
      );
    });
  }

  async createProcess(tenantId, hostId, snapshotId, process) {
    const processKey = key(tenantId, hostId, snapshotId, process.processKey);
    this.#write(() => {
      if (this.#state.processes.has(processKey)) {
        fail("PROCESS_KEY_CONFLICT", "process keys are immutable within a generation");
      }
      this.#state.processes.set(processKey, clone(process));
    });
  }

  #read(operation) {
    if (this.#written) {
      fail("TRANSACTION_READ_AFTER_WRITE", "all transaction reads must precede transaction writes");
    }
    return operation();
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
