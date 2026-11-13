// Root `.scaffold*` entries are bookkeeping: never fingerprinted, never in the implementation tree.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { snapshot } from "../agent/lib/git/snapshot.mjs";
import { implementationTree } from "../agent/lib/git/tree.mjs";

const g = (dir, ...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
async function repo(t) {
  const dir = await mkdtemp(path.join(tmpdir(), "scope-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  g(dir, "init", "-q"); g(dir, "config", "user.email", "t@example.com"); g(dir, "config", "user.name", "t");
  await writeFile(path.join(dir, "a.txt"), "a\n");
  g(dir, "add", "-A"); g(dir, "commit", "-qm", "base");
  return dir;
}

test("reserved .scaffold* files and directories do not affect the snapshot or implementation tree", async (t) => {
  const dir = await repo(t);
  const clean = await snapshot(dir);
  await writeFile(path.join(dir, ".scaffold.zip"), "archive");
  await mkdir(path.join(dir, ".scaffold-backup"));
  await writeFile(path.join(dir, ".scaffold-backup", "x"), "x");
  const after = await snapshot(dir);
  assert.equal(after.clean, true);
  assert.equal(after.digest, clean.digest);
  assert.equal(after.tree, clean.tree);
  assert.equal(await implementationTree(dir), clean.tree);
});

test("real implementation files are still fingerprinted next to reserved ones", async (t) => {
  const dir = await repo(t);
  const clean = await snapshot(dir);
  await writeFile(path.join(dir, ".scaffold.zip"), "archive");
  await writeFile(path.join(dir, "b.txt"), "b\n");
  await writeFile(path.join(dir, "scaffold.txt"), "not reserved\n");
  const after = await snapshot(dir);
  assert.equal(after.clean, false);
  assert.notEqual(after.digest, clean.digest);
  const files = g(dir, "ls-tree", "-r", "--name-only", after.tree).split("\n");
  assert.deepEqual(files, ["a.txt", "b.txt", "scaffold.txt"]);
});

test("a tracked reserved file is refused rather than silently excluded", async (t) => {
  const dir = await repo(t);
  await writeFile(path.join(dir, ".scaffold.zip"), "archive");
  g(dir, "add", "-f", ".scaffold.zip");
  await assert.rejects(() => implementationTree(dir), /must not be tracked/);
});

test("reserved files are never hashed into the object database", async (t) => {
  const dir = await repo(t);
  const content = "unique archive bytes " + Math.random();
  await writeFile(path.join(dir, ".scaffold.zip"), content);
  await writeFile(path.join(dir, "b.txt"), "b\n");
  await snapshot(dir);
  const blob = execFileSync("git", ["hash-object", "--stdin"], { cwd: dir, input: content, encoding: "utf8" }).trim();
  assert.throws(() => g(dir, "cat-file", "-e", blob), "the archive blob must not exist");
  g(dir, "cat-file", "-e", g(dir, "hash-object", path.join(dir, "b.txt")));
});

test("the tree against an older base includes files committed since, and still drops reserved ones", async (t) => {
  const dir = await repo(t);
  const base = g(dir, "rev-parse", "HEAD");
  await writeFile(path.join(dir, "later.txt"), "later\n");
  g(dir, "add", "-A"); g(dir, "commit", "-qm", "later");
  await writeFile(path.join(dir, ".scaffold.zip"), "archive");
  const files = g(dir, "ls-tree", "-r", "--name-only", await implementationTree(dir, base)).split("\n");
  assert.deepEqual(files, ["a.txt", "later.txt"]);
});
