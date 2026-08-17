import assert from "node:assert/strict";
import test from "node:test";
import { REDACTED, maskArgs, maskExecutable } from "../../collector/src/masking.js";

const limits = { maxArgs: 16, maxLength: 256 };

function masked(args) {
  return maskArgs(args, limits);
}

test("redacts values assigned to sensitive keys", () => {
  assert.deepEqual(masked(["--password=hunter2"]), [`--password=${REDACTED}`]);
  assert.deepEqual(masked(["--api-key=abc123"]), [`--api-key=${REDACTED}`]);
  assert.deepEqual(masked(["--token=xyz"]), [`--token=${REDACTED}`]);
  assert.deepEqual(masked(["--workers=8"]), ["--workers=8"]);
});

test("redacts the value that follows a sensitive flag", () => {
  assert.deepEqual(masked(["--password", "hunter2", "train.py"]), ["--password", REDACTED, "train.py"]);
});

test("redacts uri credentials, pem material, and opaque secrets", () => {
  assert.deepEqual(masked(["postgres://user:secret@db.internal:5432/app"]), [
    `postgres://${REDACTED}@db.internal:5432/app`
  ]);
  assert.deepEqual(masked(["-----BEGIN PRIVATE KEY-----MIIB"]), [REDACTED]);
  assert.deepEqual(masked(["A".repeat(48)]), [REDACTED]);
});

test("keeps ordinary paths and flags readable", () => {
  assert.deepEqual(masked(["train.py", "--epochs", "20", "/srv/jobs/data.csv"]), [
    "train.py",
    "--epochs",
    "20",
    "/srv/jobs/data.csv"
  ]);
});

test("keeps long paths instead of treating them as opaque secrets", () => {
  const path = `/srv/${"a".repeat(60)}`;
  assert.deepEqual(masked([path]), [path]);
});

test("caps argument count and argument length", () => {
  const many = Array.from({ length: 40 }, (_, index) => `arg-${index}`);
  assert.equal(masked(many).length, limits.maxArgs);
  assert.equal(masked([`/srv/${"b".repeat(400)}`])[0].length, limits.maxLength);
});

test("truncates executables and redacts pem-like executables", () => {
  assert.equal(maskExecutable("/usr/bin/python3", 512), "/usr/bin/python3");
  assert.equal(maskExecutable(`/usr/bin/${"c".repeat(600)}`, 512).length, 512);
  assert.equal(maskExecutable("-----BEGIN PRIVATE KEY-----", 512), REDACTED);
});
