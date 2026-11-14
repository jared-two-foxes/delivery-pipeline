import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, utimesSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { monitorTrackedInputs } from "../agent/lib/git/monitor.mjs";

const sh = (cwd, ...a) => execFileSync("git", a, { cwd, stdio: "pipe" });
const wait = async (m) => { for (let i = 0; i < 50 && !m.total(); i++) await new Promise((r) => setTimeout(r, 40)); };

function repo() {
  const dir = mkdtempSync(path.join(tmpdir(), "mon-"));
  sh(dir, "init", "-q"); writeFileSync(path.join(dir, "a.txt"), "one\n");
  sh(dir, "add", "."); sh(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "i");
  return dir;
}

test("by default a metadata-only touch is recorded and still trips the guard", async () => {
  const dir = repo(); const m = monitorTrackedInputs(dir);
  const now = new Date(); utimesSync(path.join(dir, "a.txt"), now, now);
  await wait(m); m.close();
  assert.equal(m.diagnostics().events[0].classification, "metadata-only");
  assert.equal(m.blocking(), m.total()); assert.throws(() => m.assert(), /blocking notification/);
});

test("opt-in: metadata-only touch is recorded with matching hash and does not trip the guard", async () => {
  const dir = repo(); const m = monitorTrackedInputs(dir, { ignoreMetadataOnly: true });
  m.mark("check", "cargo test");
  const now = new Date(); utimesSync(path.join(dir, "a.txt"), now, now);
  await wait(m); m.close();
  const [e] = m.diagnostics().events;
  assert.equal(e.path, "a.txt"); assert.equal(e.stage, "check"); assert.equal(e.command, "cargo test");
  assert.equal(e.content_matches_baseline, true); assert.ok(e.mtime && e.ctime && e.size === 4);
  assert.equal(e.classification, "metadata-only");
  assert.equal(m.blocking(), 0); assert.doesNotThrow(() => m.assert());
  assert.deepEqual([m.diagnostics().blocking, m.diagnostics().warnings], [0, m.total()]);
});

test("content write is recorded as differing from baseline", async () => {
  const dir = repo(); const m = monitorTrackedInputs(dir, { ignoreMetadataOnly: true });
  writeFileSync(path.join(dir, "a.txt"), "two\n");
  await wait(m); m.close();
  assert.equal(m.diagnostics().events[0].content_matches_baseline, false);
  assert.throws(() => m.assert(), /content differs/);
});

test("a metadata-only touch does not mask a later real edit", async () => {
  const dir = repo(); const m = monitorTrackedInputs(dir, { ignoreMetadataOnly: true });
  const now = new Date(); utimesSync(path.join(dir, "a.txt"), now, now);
  await wait(m); writeFileSync(path.join(dir, "a.txt"), "three\n");
  for (let i = 0; i < 50 && !m.blocking(); i++) await new Promise((r) => setTimeout(r, 40));
  m.close();
  assert.throws(() => m.assert(), /1 blocking notification/);
});

test("deleted tracked file blocks because its content cannot be verified", async () => {
  const dir = repo(); const m = monitorTrackedInputs(dir, { ignoreMetadataOnly: true });
  rmSync(path.join(dir, "a.txt"));
  for (let i = 0; i < 50 && !m.blocking(); i++) await new Promise((r) => setTimeout(r, 40));
  m.close();
  assert.throws(() => m.assert(), /content not verifiable/);
});
