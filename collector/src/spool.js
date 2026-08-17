import { mkdir, readdir, rename, rm, stat, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";

const ENTRY_PATTERN = /^(\d+)_([0-9a-f-]{36})_(identity|gzip)\.bin$/;

function entryName({ createdAtMs, snapshotId, contentEncoding }) {
  return `${createdAtMs}_${snapshotId}_${contentEncoding}.bin`;
}

export class Spool {
  constructor(config) {
    this.config = config;
    this.dir = config.spoolDir;
  }

  async init() {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
  }

  async save({ snapshotId, wireBody, contentEncoding, createdAtMs }) {
    if (!this.config.spool.enabled) {
      return { spooled: false, reason: "disabled" };
    }
    if (wireBody.length > this.config.spool.maxFileBytes) {
      return { spooled: false, reason: "file-too-large" };
    }
    await this.init();
    const name = entryName({ createdAtMs, snapshotId, contentEncoding });
    const target = join(this.dir, name);
    const temporary = `${target}.tmp`;
    await writeFile(temporary, wireBody, { mode: 0o600 });
    await rename(temporary, target);
    await this.enforceLimits(createdAtMs);
    return { spooled: true, name };
  }

  async list() {
    let names;
    try {
      names = await readdir(this.dir);
    } catch {
      return [];
    }
    const entries = [];
    for (const name of names) {
      const parsed = ENTRY_PATTERN.exec(name);
      if (!parsed) {
        continue;
      }
      let size = 0;
      try {
        size = (await stat(join(this.dir, name))).size;
      } catch {
        continue;
      }
      entries.push({
        name,
        path: join(this.dir, name),
        createdAtMs: Number(parsed[1]),
        snapshotId: parsed[2],
        contentEncoding: parsed[3],
        size
      });
    }
    return entries.sort((left, right) => left.createdAtMs - right.createdAtMs);
  }

  async read(entry) {
    return readFile(entry.path);
  }

  async remove(entry) {
    await rm(entry.path, { force: true });
  }

  async enforceLimits(nowMs) {
    const entries = await this.list();
    const dropped = { expired: 0, overflow: 0 };
    const retained = [];

    for (const entry of entries) {
      const ageSeconds = (nowMs - entry.createdAtMs) / 1000;
      if (ageSeconds > this.config.spool.retentionSeconds) {
        await this.remove(entry);
        dropped.expired += 1;
        continue;
      }
      retained.push(entry);
    }

    let totalBytes = retained.reduce((sum, entry) => sum + entry.size, 0);
    while (
      retained.length > this.config.spool.maxFiles ||
      totalBytes > this.config.spool.maxBytes
    ) {
      const oldest = retained.shift();
      if (!oldest) {
        break;
      }
      await this.remove(oldest);
      totalBytes -= oldest.size;
      dropped.overflow += 1;
    }

    return dropped;
  }
}
