# Continuing a review that hit a limit

A review that stops on `LIMIT_EXCEEDED`, `BUDGET_EXHAUSTED` or `CANCELLED` normally means
re-running the whole review. Every new attempt now asks `review-cli` to checkpoint
(`--checkpoint <output directory>/review-checkpoint.json`), so a continuation can pick the review
up where it stopped instead:

```
execute_and_review { previousAttempt: <receipt>, input: '{"operations":[]}',
                     reviewResume: true, reviewMaxToolCalls: <higher> }
```

The adapter derives `--resume-from` from the previous attempt's retained output directory; it is
never taken from the caller. Review limits are cumulative across the resumed attempts, so raise
`reviewMaxToolCalls` / `reviewMaxTurns` by the headroom you want, as the usual resource-pause rule
already requires. `reviewWallClockBudgetSecs` restarts each attempt. Use the checkpoint's `progress`
(`tool_calls` versus `distinct_tool_calls`) to judge whether another increase is worthwhile: a
review that is still reading new files is making progress, one repeating itself is not.

Resuming is refused (`REVIEW_RESUME_UNAVAILABLE`, nothing applied) unless:

- the attempt continues a `previousAttempt` and its review stage left a resumable checkpoint (the
  review stopped on a limit, budget, cancellation, stall or model failure, not a finished review);
- the attempt applies no source operations, so the review continues over the tree it already
  examined (continuation already requires the tree to match the previous attempt's snapshot);
- the resolved base commit and the approved criteria are unchanged; `review-cli` rejects a
  checkpoint from a different request. The review is given the criteria plus per-attempt check
  evidence (which embeds the attempt number and receipt), so its requirements text differs every
  attempt. The checkpoint is therefore bound to a digest of the criteria alone (`--resume-identity`,
  taken from the stable requirements, not the evidence). Changing the criteria or the verification
  plan (a `repair_check` update) changes the identity and the resume is refused.
- the attempt belongs to a task: `reviewResume` without a task and `previousAttempt` is refused before
  anything is applied.

The flag is per attempt and is not inherited from the receipt being continued. Checkpoint arguments
(`reviewCheckpoint`, `reviewResumeFrom`) belong to the adapter: they are stripped from caller input and
from the retained args a continuation inherits, before anything validates them. Attempts retained
before checkpoints existed carry neither flag, so their command lists still reconstruct and
authenticate. Install a `review-cli` that supports `--checkpoint`, `--resume-from` and `--resume-identity`:
an older binary ignores unknown flags and would silently review from the start (or, with an older
`--resume-from` but no identity support, reject every native resume as a different request). Neither
is unsafe, but both waste the work. Feature
validation (`validate_feature`) does not yet resume its whole-feature review.
