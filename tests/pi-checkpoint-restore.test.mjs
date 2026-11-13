import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { restoreCheckpoint } from "../agent/lib/git/checkpoint-restore.mjs";

const sh = (cwd, ...a) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd, encoding: "utf8" }).trim();

test("restore saves the dirty tree to a ref, resets to base and removes untracked files", async () => {
  const d = mkdtempSync(path.join(tmpdir(), "restore-"));
  sh(d, "init", "-q"); writeFileSync(path.join(d, "a.txt"), "base\n"); sh(d, "add", "."); sh(d, "commit", "-qm", "base");
  const base = sh(d, "rev-parse", "HEAD");
  writeFileSync(path.join(d, "a.txt"), "edited\n"); writeFileSync(path.join(d, "new.txt"), "untracked\n");
  const saved = await restoreCheckpoint(d, base, "refs/pi-delivery-recovery/F/T/attempt-1");
  assert.equal(readFileSync(path.join(d, "a.txt"), "utf8"), "base\n");
  assert.equal(existsSync(path.join(d, "new.txt")), false);
  assert.equal(sh(d, "status", "--porcelain"), "");
  assert.equal(sh(d, "show", saved.ref + ":a.txt"), "edited");
  assert.equal(sh(d, "show", saved.ref + ":new.txt"), "untracked");
});

test("restore refuses when HEAD is not the base commit", async () => {
  const d = mkdtempSync(path.join(tmpdir(), "restore-"));
  sh(d, "init", "-q"); writeFileSync(path.join(d, "a"), "1"); sh(d, "add", "."); sh(d, "commit", "-qm", "1");
  const base = sh(d, "rev-parse", "HEAD");
  writeFileSync(path.join(d, "a"), "2"); sh(d, "commit", "-qam", "2");
  await assert.rejects(restoreCheckpoint(d, base, "refs/x"), { code: "RESTORE_UNSAFE" });
});
