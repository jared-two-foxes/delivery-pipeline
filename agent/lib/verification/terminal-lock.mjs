// terminal.lock ownership. New locks name their owner so a later session can tell a dead owner from
// a live one; legacy empty locks fall back to the age of the attempt. Nothing here deletes anything.
import { readFile, readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const lockBody = () => JSON.stringify({ pid: process.pid, host: os.hostname(), at: new Date().toISOString() });

const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
};

/** Locks under `runsDirectory` written after `since` (ms) whose owner is provably still running. */
export async function liveLocks(runsDirectory, since = 0) {
  const live = [];
  let dirs = [];
  try { dirs = await readdir(runsDirectory); } catch { return live; }
  for (const d of dirs) {
    const file = path.join(runsDirectory, d, "terminal.lock");
    try {
      if ((await stat(file)).mtimeMs < since) continue;
      const owner = JSON.parse(await readFile(file, "utf8"));
      if (owner?.host === os.hostname() && Number.isInteger(owner.pid) && alive(owner.pid)) live.push({ file, ...owner });
    } catch { /* absent, empty (legacy) or unreadable: no proof of a live owner */ }
  }
  return live;
}
