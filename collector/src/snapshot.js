import { randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";
import { bodyDigest } from "./signing.js";

export function buildSnapshot({ processes, capturedAtMs, snapshotId = randomUUID() }) {
  return {
    schemaVersion: 1,
    snapshotId,
    capturedAt: `${new Date(capturedAtMs).toISOString().slice(0, 19)}Z`,
    processes
  };
}

export function buildWireBody(snapshot, { gzipEnabled }) {
  const json = Buffer.from(JSON.stringify(snapshot), "utf8");
  const wireBody = gzipEnabled ? gzipSync(json) : json;
  return {
    snapshotId: snapshot.snapshotId,
    capturedAt: snapshot.capturedAt,
    processCount: snapshot.processes.length,
    contentEncoding: gzipEnabled ? "gzip" : "identity",
    wireBody,
    bodySha256: bodyDigest(wireBody)
  };
}
