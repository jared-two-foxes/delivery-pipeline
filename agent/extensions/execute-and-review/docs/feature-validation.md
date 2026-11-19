# Feature validation

`validate_feature` is a native verification-only gate requiring Phase 5 Scaffold.
The final gate continues to use its bounded native command runner plus the
existing Review adapter. It does not fabricate an implementation task or change
its meaningful-test checks, cumulative scope, or evidence protocol. Task checkpoint authentication is shared with the
checkpoint tool. Model-facing Scaffold operations cannot submit feature outcomes.

See Design's final feature verification section for input fields, literal output
markers, retained feature authority, result/evidence contracts and recovery. The gate
records intent, checks, cumulative Review and final result in content-addressed
Git metadata. The CLI lifecycle pins the original baseline, validates all-task
completion and preserves attempts. Applicability is computed against actual Git
and task state, not the historical Scaffold status alone.

Run the integration suite against the companion Scaffold checkout:

```sh
SCAFFOLD_SOURCE=/path/to/scaffold node --test tests/feature/validation.test.mjs tests/feature/checks.test.mjs tests/feature/acceptance.test.mjs tests/delivery/checkpoint.test.mjs
```

No live AI calls are needed; temporary Git repositories, real Scaffold processes
and deterministic Review CLI fixtures exercise failures, corrective checkpoints,
full cumulative reviews and idempotent interruption recovery.


## Final-validation precondition cache

`validate_feature` derives its preconditions repeatedly (before and after
authorization, after every check and the review, before and after retention). The
costly part authenticates every completed task: it walks each checkpoint commit,
re-reads and re-verifies each task's evidence and attempt chain, re-authenticates
amendments and scans earlier feature reviews. `lib/verification/precondition-cache.mjs`
reuses that result within one run while nothing it reads has changed.

- **What is reused:** only the immutable authentication. The live checks (no Git
  operation in progress, branch, clean HEAD/index/worktree, the Scaffold state read,
  the active validation attempt) run on every derivation.
- **When it is reused:** the Scaffold feature (excluding `validation`, which only this
  gate writes), the validation arguments and a fingerprint of every evidence file's
  name, size, inode, mtime and ctime must all be unchanged. A file added, removed,
  renamed or edited in place invalidates it. Git objects are immutable by SHA.
- **What is never reused:** failures are never cached. The first derivation and the
  last one before the receipt is retained always recompute in full, so a persistent
  change to any input, including check logs outside the evidence directory, is caught
  before a receipt is written. Cached results are handed out as copies.
- **Observability:** the receipt's `timings.precondition_cache` reports `hits`,
  `misses` (recomputed after a change) and `fresh` (required full recomputes).
  Fingerprinting costs about 5 ms for 50 evidence files, 14 ms for 500 and 47 ms for
  2000, which a reused derivation pays instead of re-authenticating every task.
