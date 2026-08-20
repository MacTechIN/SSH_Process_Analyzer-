import { reject } from "./api-error.js";
import { signCursor, verifyCursor } from "./cursor.js";

const BEARER_PATTERN = /^Bearer ([A-Za-z0-9._-]+)$/;

export class HistoryService {
  constructor({ store, config, verifyIdToken, now = () => new Date() }) {
    this.store = store;
    this.config = config;
    this.verifyIdToken = verifyIdToken;
    this.now = now;
  }

  async listSnapshots({ tenantId, hostId, authorization, cursor, pageSize }) {
    const receivedAt = this.now();
    if (!this.config.cursorSigningSecret) {
      reject(503, "CURSOR_SIGNING_NOT_CONFIGURED", "CURSOR_SIGNING_SECRET is required for history queries");
    }
    const uid = await this.#authenticate(authorization);

    const membership = await this.store.readMembership(tenantId, uid);
    if (!membership) {
      reject(403, "TENANT_FORBIDDEN", "no membership for this tenant");
    }

    const limit = this.#pageSize(pageSize);
    const retentionCutoff = new Date(
      receivedAt.getTime() - this.config.snapshotRetentionSeconds * 1000
    ).toISOString();

    // The cursor pins the filter for the whole pagination session. Recomputing the
    // cutoff per request would move the window between pages and skip or repeat rows.
    const bound = { uid, tenantId, hostId, order: "capturedAt:desc", pageSize: limit };
    let pinnedCutoff = retentionCutoff;
    let startAfter;
    if (cursor) {
      const verified = verifyCursor(cursor, {
        secret: this.config.cursorSigningSecret,
        nowMs: receivedAt.getTime(),
        expected: bound
      });
      if (!verified.valid) {
        reject(400, "INVALID_CURSOR", `cursor is not usable: ${verified.reason}`);
      }
      pinnedCutoff = verified.payload.retentionCutoff;
      const oldestAllowed = new Date(
        receivedAt.getTime() -
          (this.config.snapshotRetentionSeconds + this.config.historyCursorTtlSeconds) * 1000
      ).toISOString();
      if (typeof pinnedCutoff !== "string" || pinnedCutoff < oldestAllowed) {
        reject(400, "INVALID_CURSOR", "cursor is not usable: retention-window");
      }
      startAfter = verified.payload.last;
    }

    const records = await this.store.listSnapshotHistory(tenantId, hostId, {
      capturedAtFrom: pinnedCutoff,
      limit,
      startAfter
    });

    // TTL deletion can lag, so expired history is filtered before it reaches the browser.
    const nowIso = receivedAt.toISOString();
    const snapshots = records
      .filter((record) => !record.expiresAt || record.expiresAt > nowIso)
      .map((record) => ({
        snapshotId: record.snapshotId,
        capturedAt: record.capturedAt,
        processCount: record.processCount,
        published: record.published,
        storedAt: record.storedAt ?? null
      }));

    const last = records.at(-1);
    const nextCursor =
      records.length === limit && last
        ? signCursor(
            {
              ...bound,
              retentionCutoff: pinnedCutoff,
              last: { capturedAt: last.capturedAt, snapshotId: last.snapshotId },
              issuedAt: nowIso,
              expiresAt: new Date(
                receivedAt.getTime() + this.config.historyCursorTtlSeconds * 1000
              ).toISOString()
            },
            { secret: this.config.cursorSigningSecret, keyId: this.config.cursorSigningKeyId }
          )
        : null;

    return { tenantId, hostId, role: membership.role ?? "viewer", snapshots, nextCursor };
  }

  #pageSize(requested) {
    if (requested === undefined) {
      return this.config.historyPageSizeLimit;
    }
    const parsed = Number(requested);
    if (!Number.isInteger(parsed) || parsed < 1) {
      reject(400, "INVALID_PAGE_SIZE", "limit must be a positive integer");
    }
    if (parsed > this.config.historyPageSizeLimit) {
      reject(400, "PAGE_SIZE_TOO_LARGE", `limit cannot exceed ${this.config.historyPageSizeLimit}`);
    }
    return parsed;
  }

  async #authenticate(authorization) {
    const match = typeof authorization === "string" ? BEARER_PATTERN.exec(authorization) : null;
    if (!match) {
      reject(401, "UNAUTHENTICATED", "a Firebase Auth ID token is required");
    }
    let decoded;
    try {
      decoded = await this.verifyIdToken(match[1]);
    } catch {
      reject(401, "UNAUTHENTICATED", "id token could not be verified");
    }
    if (!decoded?.uid) {
      reject(401, "UNAUTHENTICATED", "id token has no uid");
    }
    return decoded.uid;
  }
}
