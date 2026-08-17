import { open, readFile, rm, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

function isRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

async function readLock(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

export async function acquireLock(path, { staleMs, nowMs = Date.now(), pid = process.pid }) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(path, "wx", 0o600);
      await handle.writeFile(JSON.stringify({ pid, acquiredAtMs: nowMs }));
      await handle.close();
      return {
        async release() {
          await rm(path, { force: true });
        }
      };
    } catch (error) {
      if (error.code !== "EEXIST") {
        throw error;
      }
      const held = await readLock(path);
      const expired = !held || nowMs - held.acquiredAtMs > staleMs || !isRunning(held.pid);
      if (!expired) {
        return null;
      }
      await rm(path, { force: true });
    }
  }

  return null;
}
