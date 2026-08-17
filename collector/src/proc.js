import { createHash } from "node:crypto";
import { readFile, readdir, readlink, stat } from "node:fs/promises";
import { join } from "node:path";
import { maskArgs, maskExecutable } from "./masking.js";

const OWNER_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,128}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const STAT_UTIME_INDEX = 11;
const STAT_STIME_INDEX = 12;
const STAT_STARTTIME_INDEX = 19;
const STAT_RSS_INDEX = 21;

export function processKeyFor({ bootId, pid, startTicks }) {
  return createHash("sha256").update(`${bootId}\n${pid}\n${startTicks}`, "utf8").digest("hex");
}

export function parseStat(content) {
  const commEnd = content.lastIndexOf(")");
  if (commEnd < 0) {
    return null;
  }
  const comm = content.slice(content.indexOf("(") + 1, commEnd);
  const fields = content.slice(commEnd + 2).trim().split(/\s+/);
  if (fields.length <= STAT_RSS_INDEX) {
    return null;
  }
  return {
    comm,
    utimeTicks: Number(fields[STAT_UTIME_INDEX]),
    stimeTicks: Number(fields[STAT_STIME_INDEX]),
    startTicks: Number(fields[STAT_STARTTIME_INDEX]),
    rssPages: Number(fields[STAT_RSS_INDEX])
  };
}

export function parsePasswd(content) {
  const owners = new Map();
  for (const line of content.split("\n")) {
    const [name, , uid] = line.split(":");
    if (name && uid !== undefined && !owners.has(Number(uid))) {
      owners.set(Number(uid), name);
    }
  }
  return owners;
}

export function ownerNameFor(owners, uid) {
  const name = owners.get(uid);
  return name && OWNER_NAME_PATTERN.test(name) ? name : `uid-${uid}`;
}

async function readBootId(procRoot) {
  const bootId = (await readFile(join(procRoot, "sys/kernel/random/boot_id"), "utf8")).trim();
  if (!UUID_PATTERN.test(bootId)) {
    throw new Error("boot_id is not a lowercase uuid");
  }
  return bootId;
}

async function readBootTimeMs(procRoot, nowMs) {
  const stats = await readFile(join(procRoot, "stat"), "utf8");
  const btime = /^btime (\d+)$/m.exec(stats);
  if (btime) {
    return Number(btime[1]) * 1000;
  }
  const uptime = await readFile(join(procRoot, "uptime"), "utf8");
  return nowMs - Number(uptime.split(/\s+/)[0]) * 1000;
}

async function readOwners(passwdPath) {
  try {
    return parsePasswd(await readFile(passwdPath, "utf8"));
  } catch {
    return new Map();
  }
}

async function readLinkOrNull(path) {
  try {
    return await readlink(path);
  } catch {
    return null;
  }
}

async function readCmdline(path) {
  try {
    const raw = await readFile(path, "utf8");
    return raw.split("\0").filter((part) => part.length > 0);
  } catch {
    return [];
  }
}

function rfc3339(ms) {
  return `${new Date(ms).toISOString().slice(0, 19)}Z`;
}

async function collectOne({ pid, config, bootId, bootTimeMs, owners, nowMs }) {
  const pidDir = join(config.procRoot, String(pid));
  const [statContent, entry] = await Promise.all([
    readFile(join(pidDir, "stat"), "utf8"),
    stat(pidDir)
  ]);
  const parsed = parseStat(statContent);
  if (!parsed || !Number.isFinite(parsed.startTicks)) {
    return null;
  }

  const cmdline = await readCmdline(join(pidDir, "cmdline"));
  const executablePath = await readLinkOrNull(join(pidDir, "exe"));
  if (cmdline.length === 0 && !executablePath && !config.includeKernelThreads) {
    return null;
  }

  const startedAtMs = bootTimeMs + (parsed.startTicks / config.clockTicksPerSecond) * 1000;
  const elapsedSeconds = Math.max((nowMs - startedAtMs) / 1000, 0);
  const cpuSeconds = (parsed.utimeTicks + parsed.stimeTicks) / config.clockTicksPerSecond;
  const cpuPercent = elapsedSeconds > 0 ? Math.round((cpuSeconds / elapsedSeconds) * 10000) / 100 : 0;
  const workingDirectory = await readLinkOrNull(join(pidDir, "cwd"));
  const executable = executablePath ?? cmdline[0] ?? parsed.comm;

  return {
    processKey: processKeyFor({ bootId, pid, startTicks: parsed.startTicks }),
    bootId,
    pid,
    startTicks: parsed.startTicks,
    startedAt: rfc3339(startedAtMs),
    ownerName: ownerNameFor(owners, entry.uid),
    executable: maskExecutable(executable || "unknown", config.maxExecutableLength),
    allowedArgs: maskArgs(cmdline.slice(1), {
      maxArgs: config.maxAllowedArgs,
      maxLength: config.maxAllowedArgLength
    }),
    ...(workingDirectory
      ? { workingDirectory: workingDirectory.slice(0, config.maxWorkingDirectoryLength) }
      : {}),
    taskType: null,
    classificationStatus: "unclassified",
    cpuPercent: Math.max(cpuPercent, 0),
    memoryBytes: Math.max(parsed.rssPages, 0) * config.pageSizeBytes
  };
}

export async function collectProcesses(config, { nowMs = Date.now() } = {}) {
  const [bootId, bootTimeMs, owners, entries] = await Promise.all([
    readBootId(config.procRoot),
    readBootTimeMs(config.procRoot, nowMs),
    readOwners(config.passwdPath),
    readdir(config.procRoot)
  ]);

  const pids = entries.filter((entry) => /^\d+$/.test(entry)).map(Number);
  const processes = [];
  const seen = new Set();

  for (const pid of pids) {
    let collected = null;
    try {
      collected = await collectOne({ pid, config, bootId, bootTimeMs, owners, nowMs });
    } catch {
      continue;
    }
    if (!collected || seen.has(collected.processKey)) {
      continue;
    }
    seen.add(collected.processKey);
    processes.push(collected);
  }

  return { bootId, processes };
}
