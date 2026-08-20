import { REGISTERED_ID_PATTERN, publicKeyFromRaw } from "./signing.js";

export class AgentRegistryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "AgentRegistryError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new AgentRegistryError(code, message);
}

function requireId(value, name) {
  if (typeof value !== "string" || !REGISTERED_ID_PATTERN.test(value)) {
    fail("INVALID_IDENTIFIER", `${name} must match [A-Za-z0-9_-]{1,128}`);
  }
  return value;
}

function requirePublicKey(publicKey) {
  try {
    publicKeyFromRaw(publicKey);
  } catch {
    fail("INVALID_PUBLIC_KEY", "public key must be 32 raw ed25519 bytes in base64url");
  }
  return publicKey;
}

export class AgentRegistry {
  constructor({ store, now = () => new Date() }) {
    this.store = store;
    this.now = now;
  }

  async register({ tenantId, hostId, agentId, kid, publicKey, actor }) {
    requireId(tenantId, "tenantId");
    requireId(hostId, "hostId");
    requireId(agentId, "agentId");
    requireId(kid, "kid");
    requirePublicKey(publicKey);

    if (await this.store.findAgent(agentId)) {
      fail("AGENT_ALREADY_REGISTERED", "agent id is already registered");
    }
    if (!(await this.store.readHost(tenantId, hostId))) {
      await this.store.seedHost({ tenantId, hostId });
    }

    const agent = {
      tenantId,
      hostId,
      agentId,
      quarantined: false,
      keys: { [kid]: { publicKey, revokedAt: null, addedAt: this.#at() } }
    };
    await this.store.seedAgent(agent);
    await this.#audit(agent, "register", actor, { kid, hostId });
    return agent;
  }

  async rotateKey({ agentId, kid, publicKey, actor }) {
    requireId(kid, "kid");
    requirePublicKey(publicKey);
    const agent = await this.#require(agentId);
    if (agent.keys?.[kid]) {
      fail("KEY_ALREADY_REGISTERED", "key id is already registered for this agent");
    }

    agent.keys = { ...agent.keys, [kid]: { publicKey, revokedAt: null, addedAt: this.#at() } };
    await this.store.seedAgent(agent);
    await this.#audit(agent, "rotate-key", actor, { kid });
    return agent;
  }

  async revokeKey({ agentId, kid, actor }) {
    const agent = await this.#require(agentId);
    const key = agent.keys?.[kid];
    if (!key) {
      fail("UNKNOWN_KEY", "key id is not registered for this agent");
    }
    if (key.revokedAt) {
      return agent;
    }
    const active = Object.entries(agent.keys).filter(([id, value]) => id !== kid && !value.revokedAt);
    if (active.length === 0) {
      fail("LAST_ACTIVE_KEY", "register a replacement key before revoking the last active key");
    }

    agent.keys = { ...agent.keys, [kid]: { ...key, revokedAt: this.#at() } };
    await this.store.seedAgent(agent);
    await this.#audit(agent, "revoke-key", actor, { kid });
    return agent;
  }

  async quarantine({ agentId, reason, actor }) {
    if (!reason) {
      fail("REASON_REQUIRED", "quarantine requires a reason for the audit log");
    }
    const agent = await this.#require(agentId);
    agent.quarantined = true;
    agent.quarantinedAt = this.#at();
    agent.quarantineReason = reason;
    await this.store.seedAgent(agent);
    await this.#audit(agent, "quarantine", actor, { reason });
    return agent;
  }

  // Quarantine never clears itself. An operator has to release it and the release is audited.
  async releaseQuarantine({ agentId, reason, actor }) {
    if (!reason) {
      fail("REASON_REQUIRED", "quarantine release requires a reason for the audit log");
    }
    if (!actor) {
      fail("ACTOR_REQUIRED", "quarantine release requires an operator identity");
    }
    const agent = await this.#require(agentId);
    agent.quarantined = false;
    agent.quarantinedAt = null;
    agent.quarantineReason = null;
    agent.quarantineReleasedAt = this.#at();
    await this.store.seedAgent(agent);
    await this.#audit(agent, "release-quarantine", actor, { reason });
    return agent;
  }

  async describe(agentId) {
    const agent = await this.#require(agentId);
    return {
      tenantId: agent.tenantId,
      hostId: agent.hostId,
      agentId: agent.agentId,
      quarantined: Boolean(agent.quarantined),
      quarantineReason: agent.quarantineReason ?? null,
      keys: Object.entries(agent.keys ?? {}).map(([kid, key]) => ({
        kid,
        addedAt: key.addedAt ?? null,
        revokedAt: key.revokedAt ?? null,
        active: !key.revokedAt
      })),
      auditLog: await this.store.listAgentAudit(agent.tenantId, agent.agentId)
    };
  }

  #at() {
    return this.now().toISOString();
  }

  async #require(agentId) {
    requireId(agentId, "agentId");
    const agent = await this.store.findAgent(agentId);
    if (!agent) {
      fail("UNKNOWN_AGENT", "agent is not registered");
    }
    return agent;
  }

  async #audit(agent, action, actor, details) {
    await this.store.appendAgentAudit({
      tenantId: agent.tenantId,
      agentId: agent.agentId,
      action,
      actor: actor ?? "unknown",
      at: this.#at(),
      details
    });
  }
}
