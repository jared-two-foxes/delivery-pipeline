// Restore the working tree to a task's checkpoint, saving the dirty tree first so nothing is lost.
// The saved tree is a commit under refs/pi-delivery-recovery/*; `git checkout <ref> -- .` brings it back.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { git } from "./tree.mjs";

import { IMPLEMENTATION_SCOPE as SCOPE } from "./scope.mjs";

/** Commit the working tree (tracked, staged, untracked non-ignored) to a ref without touching index or files. */
export async function saveWorkingTree(repository, refName, message) {
  const dir = await mkdtemp(path.join(tmpdir(), "pi-restore-"));
  const env = { GIT_INDEX_FILE: path.join(dir, "index") };
  try {
    const head = git(repository, ["rev-parse", "HEAD"]);
    git(repository, ["read-tree", head], { env });
    git(repository, ["add", "-A", ...SCOPE], { env });
    const tree = git(repository, ["write-tree"], { env });
    const commit = git(repository, ["-c", "user.name=pi-delivery", "-c", "user.email=pi-delivery@localhost",
      "commit-tree", tree, "-p", head, "-m", message]);
    git(repository, ["update-ref", refName, commit]);
    return { ref: refName, commit, tree };
  } finally { await rm(dir, { recursive: true, force: true }); }
}

/**
 * Save the dirty tree, then reset tracked files and remove untracked ones to `baseRef`.
 * Refuses unless HEAD is already baseRef: history is never rewritten here. Ignored files are kept.
 */
export async function restoreCheckpoint(repository, baseRef, refName) {
  const head = git(repository, ["rev-parse", "HEAD"]);
  if (head !== git(repository, ["rev-parse", baseRef + "^{commit}"]))
    throw Object.assign(new Error("HEAD is not the task's base commit; restore would rewrite history"), { code: "RESTORE_UNSAFE" });
  const saved = await saveWorkingTree(repository, refName, "Interrupted attempt working tree saved before restore");
  git(repository, ["reset", "--hard", baseRef]);
  git(repository, ["clean", "-fd", ...SCOPE]);
  return saved;
}
