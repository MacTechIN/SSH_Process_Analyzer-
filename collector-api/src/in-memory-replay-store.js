import { ReplayConflictError } from "./replay-store-errors.js";

export class InMemoryReplayStore {
  #records = new Map();

  async create(replayId, record) {
    this.#prune(record.receivedAt);
    if (this.#records.has(replayId)) {
      throw new ReplayConflictError();
    }
    this.#records.set(replayId, { ...record });
    return replayId;
  }

  size() {
    return this.#records.size;
  }

  #prune(now) {
    if (!(now instanceof Date)) {
      return;
    }
    for (const [replayId, record] of this.#records.entries()) {
      if (Date.parse(record.expiresAt) <= now.getTime()) {
        this.#records.delete(replayId);
      }
    }
  }
}
