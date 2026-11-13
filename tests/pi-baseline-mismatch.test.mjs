// A status-clean checkout must hash to its commit's tree, or the snapshot cannot be compared with the baseline.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { baselineMismatch, snapshot } from "../agent/lib/git/snapshot.mjs";

const g = (dir, ...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();

test("a clean tree whose files re-hash differently under changed autocrlf is reported", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "baseline-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  g(dir, "init", "-q"); g(dir, "config", "user.email", "t@example.com"); g(dir, "config", "user.name", "t");
  g(dir, "config", "core.autocrlf", "true");
  await writeFile(path.join(dir, "a.txt"), "x\r\ny\r\n");
  const old = new Date(Date.now() - 60_000); // an old mtime keeps the index entry from being racily re-hashed
  await utimes(path.join(dir, "a.txt"), old, old);
  g(dir, "add", "-A"); g(dir, "commit", "-qm", "base");
  g(dir, "status", "--porcelain"); // refresh cached stats, as an ordinary checkout would have
  const head = g(dir, "rev-parse", "HEAD");

  assert.equal(baselineMismatch(dir, await snapshot(dir), head), null);

  g(dir, "config", "core.autocrlf", "false"); // the config now in effect no longer matches the checkout
  const snap = await snapshot(dir);
  assert.equal(snap.clean, true, "status still trusts cached stats");
  const mismatch = baselineMismatch(dir, snap, head);
  assert.ok(mismatch, "re-hashing under the new config differs from the commit tree");
  assert.equal(mismatch.baselineTree, g(dir, "rev-parse", head + "^{tree}"));
});
