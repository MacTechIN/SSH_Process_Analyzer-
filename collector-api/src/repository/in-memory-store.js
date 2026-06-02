function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function key(...parts) {
  return parts.join("/");
}

export class InMemoryStore {
  #state = {
    agents: new Map(),
    hosts: new Map(),
    generations: new Map(),
    processes: new Map()
  };

  async transaction(callback) {
    const draft = structuredClone(this.#state);
    const result = await callback(new InMemoryTransaction(draft));
    this.#state = draft;
    return result;
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
  constructor(state) {
    this.state = state;
  }

  getAgent(tenantId, agentId) {
    return clone(this.state.agents.get(key(tenantId, agentId)));
  }

  getHost(tenantId, hostId) {
    return clone(this.state.hosts.get(key(tenantId, hostId)));
  }

  setHost(host) {
    this.state.hosts.set(key(host.tenantId, host.hostId), clone(host));
  }

  getGeneration(tenantId, hostId, snapshotId) {
    return clone(this.state.generations.get(key(tenantId, hostId, snapshotId)));
  }

  setGeneration(generation) {
    this.state.generations.set(
      key(generation.tenantId, generation.hostId, generation.snapshotId),
      clone(generation)
    );
  }

  deleteGeneration(tenantId, hostId, snapshotId) {
    this.state.generations.delete(key(tenantId, hostId, snapshotId));
  }

  setProcess(tenantId, hostId, snapshotId, process) {
    this.state.processes.set(
      key(tenantId, hostId, snapshotId, process.processKey),
      clone(process)
    );
  }

  getProcess(tenantId, hostId, snapshotId, processKey) {
    return clone(this.state.processes.get(key(tenantId, hostId, snapshotId, processKey)));
  }

  listProcesses(tenantId, hostId, snapshotId) {
    const prefix = `${key(tenantId, hostId, snapshotId)}/`;
    return [...this.state.processes.entries()]
      .filter(([processKey]) => processKey.startsWith(prefix))
      .map(([, process]) => clone(process));
  }

  deleteProcesses(tenantId, hostId, snapshotId) {
    const prefix = `${key(tenantId, hostId, snapshotId)}/`;
    for (const processKey of this.state.processes.keys()) {
      if (processKey.startsWith(prefix)) {
        this.state.processes.delete(processKey);
      }
    }
  }
}
