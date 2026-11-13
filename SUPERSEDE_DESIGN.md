# Design: superseding checkpoints (history and retry)

Status: proposal. Needs a Scaffold change (`history-supersede`), so it cannot land from this repository alone.
Related: `LEDGER_DESIGN.md` (entry types, `history-rewrite`), `RECOVERY.md`.

## Problem

Checkpoints are one-way. Once `checkpoint_verified_task` commits a task, nothing can move the feature back to
an earlier checkpoint and redo the work. The ledger is append-only and hash-chained, so deleting entries is
the wrong answer, and `history-rewrite` only maps the *same* checkpoints onto rebased commits (none dropped).
A user who finds a checkpointed task was wrong has to abandon the feature.

## Approach: supersede, never delete

A user-performed reset, recorded rather than performed, mirroring `rewrite_feature_history`:

1. The user resets the feature branch to an earlier recorded checkpoint commit `C` (or the feature baseline).
   Pi never edits Git history.
2. `supersede_checkpoints` verifies that HEAD equals the recorded commit of the chosen checkpoint, that the
   tree is clean, that no task is active (suspend it first), and that the superseded commits are still
   reachable from a saved ref (the user's old branch tip, or a ref the tool asks them to create first).
3. After confirmation it appends one `history-supersede` entry. Scaffold moves `head` back to `C`, moves the
   superseded checkpoints and their attempts into `epochs` (as `history-rewrite` already does for replaced
   segments), and reopens each task whose checkpoint was superseded.

Nothing is erased. The old attempts, receipts and checkpoints stay in the ledger and `epochs`, citable by
reference. The live state simply points at `C`.

## What happens to each task

| Task | After supersede |
|---|---|
| Checkpointed at or before `C` | unchanged, still completed |
| Checkpointed after `C` | status `pending` (or `in_progress` if the user picks one), `attempts` reset to the superseded epoch's count carried as `consumed_prior`, checkpoint cleared |
| Tasks depending on a reopened task | `pending`, ordered by prerequisites as usual |
| Feature validation | invalidated (`validation-invalidate`), as for a rebase |

Attempt budgets: a fresh epoch starts at attempt 1 for the reopened task. The superseded attempts stay
visible through `inspect_issue_attempt` with an `epoch` marker so review context can cite earlier findings
instead of rediscovering them (the reopened task's delivery journal carries the old findings as obligations,
the same way a suspension handoff does).

## Scaffold changes (separate repository)

* New action `history-supersede` `{to_head, superseded: [checkpoint...], reopened: [task_id...], approval}`:
  accepted only between tasks, `to_head` must be a recorded checkpoint (or the original baseline) on the
  current chain, `approval` must be a stored artifact (as for `history-foreign`).
* State patch: truncate `history` to `to_head`, append the removed segments to `epochs`, set `head`, reopen
  the named tasks, clear their `checkpoint`/`completion`, mark validation stale.
* Idempotent on `to_head` plus the digest of the removed segments.

## Pi changes (this repository)

* `supersede_checkpoints` tool beside `rewrite_feature_history`, built on the same verification helpers
  (`lib/verification/history.mjs`, `rewrite-history.mjs`).
* `inspect_feature_drift` recognises "HEAD is an earlier recorded checkpoint" and recommends this tool
  instead of reporting drift.
* Attempt-chain authentication treats attempts of a closed epoch as history, never as a predecessor of the
  new epoch's first attempt.

## Open questions

* Should supersede also allow rolling back *within* a task (to an earlier attempt's tree) without Git
  involvement? The reconcile receipt (`reconcile_external_changes`) already covers the working-tree half;
  restoring an old attempt tree could reuse `restoreCheckpoint`'s saved-ref mechanism.
* Rolling back a checkpoint whose commit was pushed: the tool should only record, and say plainly that
  rewriting a published branch is the user's decision.
* Whether `epochs` growth needs a retention rule (see `LEDGER_DESIGN.md` section 8).
