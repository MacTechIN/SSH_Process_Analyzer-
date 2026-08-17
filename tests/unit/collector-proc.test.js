import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { ownerNameFor, parsePasswd, parseStat, processKeyFor } from "../../collector/src/proc.js";

const STAT_LINE =
  "3797259 (head) R 3797232 3797259 3797232 0 -1 4194304 490 0 0 0 11 22 0 0 20 0 1 0 475594751 16699392 1917 " +
  "18446744073709551615 94032326623232 94032331568829 140729114889760 0 0 0 0 0 0 0 0 0 17 8 0 0 0 0 0";

test("parses /proc stat fields after a comm value that contains spaces and parens", () => {
  const parsed = parseStat(STAT_LINE.replace("(head)", "(my (weird) proc)"));
  assert.equal(parsed.comm, "my (weird) proc");
  assert.equal(parsed.utimeTicks, 11);
  assert.equal(parsed.stimeTicks, 22);
  assert.equal(parsed.startTicks, 475594751);
  assert.equal(parsed.rssPages, 1917);
});

test("rejects truncated stat content", () => {
  assert.equal(parseStat("123 (short) R 1 2 3"), null);
  assert.equal(parseStat("no parens here"), null);
});

test("process key matches sha256(bootId + LF + pid + LF + startTicks)", () => {
  const bootId = "cab42de7-6a8b-4b25-8e08-c444f86430e4";
  const expected = createHash("sha256").update(`${bootId}\n4242\n475594751`, "utf8").digest("hex");
  assert.equal(processKeyFor({ bootId, pid: 4242, startTicks: 475594751 }), expected);
  assert.match(processKeyFor({ bootId, pid: 1, startTicks: 0 }), /^[a-f0-9]{64}$/);
});

test("owner names fall back to a schema-safe uid label", () => {
  const owners = parsePasswd("root:x:0:0:root:/root:/bin/bash\nalice:x:1000:1000::/home/alice:/bin/bash\n");
  assert.equal(ownerNameFor(owners, 0), "root");
  assert.equal(ownerNameFor(owners, 1000), "alice");
  assert.equal(ownerNameFor(owners, 65534), "uid-65534");
  assert.match(ownerNameFor(new Map([[7, "bad name!"]]), 7), /^[A-Za-z0-9_.-]{1,128}$/);
});
