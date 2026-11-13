import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { implementationTree } from "./tree.mjs";
import { IMPLEMENTATION_SCOPE, RESERVED_PATHS } from "./scope.mjs";
// Preserve the exact bytes used by historical snapshot fingerprints.
const git = (repository, args) =>
  execFileSync("git", args, {
    cwd: repository, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, windowsHide: true,
  });
const digest = value => createHash("sha256").update(value).digest("hex");
const scope = IMPLEMENTATION_SCOPE;
// Include index, working diff and nonignored untracked contents. Scaffold state
// is bookkeeping, excluded from the implementation baseline. Ignored build
// artifacts are intentionally outside this recovery fingerprint.
export async function snapshot(repository) {
  const status = git(repository, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
    ...scope,
  ]);
  const untracked = git(repository, [
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z",
    ...scope,
  ])
    .split("\0")
    .filter(Boolean)
    .sort();
  const files = [];
  for (const name of untracked) {
    const stat = await lstat(path.join(repository, name));
    if (!stat.isFile())
      throw new Error("Cannot fingerprint nonregular untracked file: " + name);
    files.push([name, digest(await readFile(path.join(repository, name)))]);
  }
  return {
    tree: await implementationTree(repository),
    head: git(repository, ["rev-parse", "HEAD"]).trim(),
    clean: !status,
    bookkeepingVisible: !!git(repository, [
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
      "--",
      ...RESERVED_PATHS,
    ]).trim(),
    digest: digest(
      JSON.stringify([
        status,
        git(repository, [
          "diff",
          "--binary",
          "--no-ext-diff",
          "--no-textconv",
          "HEAD",
          ...scope,
        ]),
        git(repository, [
          "diff",
          "--cached",
          "--binary",
          "--no-ext-diff",
          "--no-textconv",
          ...scope,
        ]),
        files,
      ]),
    ),
  };
}

// A status-clean tree at the baseline commit must hash to that commit's tree. It does not when Git's line-ending
// or filter configuration now differs from the one the files were checked out under: status trusts cached file
// stats, while the implementation tree re-hashes every file. Such a snapshot is not comparable with the baseline.
export function baselineMismatch(repository, snap, baseRef) {
  if (!snap.clean || snap.head !== baseRef) return null;
  const tree = git(repository, ["rev-parse", baseRef + "^{tree}"]).trim();
  return tree === snap.tree ? null : { snapshotTree: snap.tree, baselineTree: tree };
}
