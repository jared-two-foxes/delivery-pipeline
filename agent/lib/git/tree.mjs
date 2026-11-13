// Git-native implementation snapshots; never borrow or mutate the user's index.
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, copyFile, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { RESERVED_PATHS, NAME_EXCLUDES } from './scope.mjs';

export function git(repository, args, options = {}) {
  return execFileSync('git', args, { cwd: repository, encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'], timeout: 30000, maxBuffer: 32 * 1024 * 1024, windowsHide: true,
    ...options, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', ...options.env } }).trimEnd();
}
export async function withTreeIndex(repository, base, action) {
  const dir = await mkdtemp(path.join(tmpdir(), 'pi-checkpoint-'));
  const index = path.join(dir, 'index');
  const env = { GIT_INDEX_FILE: index };
  try {
    git(repository, ['read-tree', base], { env });
    return await action(env, index);
  } finally { await rm(dir, { recursive: true, force: true }); }
}
export async function implementationTree(repository, base = 'HEAD') {
  return withTreeIndex(repository, base, async env => {
    // Submodules, conflicts and hidden tracked edits cannot be represented safely.
    const entries = git(repository, ['ls-files', '--stage', '-z']);
    if (entries.split('\0').some(e => /^(160000|\d+ [a-f0-9]+ [123])/.test(e)))
      throw new Error('Submodules or unresolved index entries are unsupported');
    if (git(repository, ['ls-files', '-v', '-z']).split('\0').some(e => /^[a-zS]/.test(e)))
      throw new Error('Assume-unchanged and sparse/skip-worktree entries are unsupported');
    if (git(repository, ['ls-files', '-z', '--', ...RESERVED_PATHS]))
      throw new Error('Scaffold bookkeeping (.scaffold and .scaffold* at the repository root) must not be tracked');
    // Tracked files are re-hashed in full (a stat-clean tree must still hash to its commit tree). Untracked files are
    // selected first so reserved archives/backups are never read or hashed into the object database; `git add` with an
    // exclusion pathspec cannot do that itself because it rejects an ignored `.scaffold`.
    git(repository, ['add', '-u', '--', '.'], { env });
    const untracked = git(repository, ['ls-files', '-z', '-o', '--exclude-standard', '--', '.', ...NAME_EXCLUDES]);
    if (untracked) git(repository, ['add', '--pathspec-from-file=-', '--pathspec-file-nul'], { env, input: untracked });
    // An unignored `.scaffold` directory is still dropped (and reported by the snapshot's bookkeeping check).
    git(repository, ['rm', '-r', '-q', '--cached', '--ignore-unmatch', '--', '.scaffold'], { env });
    return git(repository, ['write-tree'], { env });
  });
}

export async function currentIndexTree(repository, indexPath) {
  return withTreeIndex(repository, 'HEAD', async (env, privateIndex) => {
    await copyFile(indexPath, privateIndex);
    return git(repository, ['write-tree'], { env });
  });
}

export async function assertNoGitOperation(repository) {
  for (const name of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'BISECT_LOG']) {
    const file = path.resolve(repository, git(repository, ['rev-parse', '--git-path', name]));
    try { await lstat(file); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    throw new Error('Git operation in progress: ' + name);
  }
}
