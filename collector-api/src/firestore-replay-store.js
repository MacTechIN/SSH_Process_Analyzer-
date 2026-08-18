import { ReplayConflictError } from "./replay-store-errors.js";

const ALREADY_EXISTS = 6;

export class FirestoreReplayStore {
  constructor(firestore) {
    this.db = firestore;
  }

  async create(replayId, record) {
    try {
      await this.db.doc(`replayRecords/${replayId}`).create({
        agentId: record.agentId,
        kid: record.kid,
        nonce: record.nonce,
        expiresAt: record.expiresAt
      });
    } catch (error) {
      if (error?.code === ALREADY_EXISTS) {
        throw new ReplayConflictError();
      }
      throw error;
    }
    return replayId;
  }
}
