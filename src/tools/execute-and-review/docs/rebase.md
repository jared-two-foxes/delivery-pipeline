# Continue development after rebasing

The user rebases the feature branch; Pi never does. `rewrite_feature_history` then verifies the rebased result
and records it in the Scaffold ledger. **Rebase between tasks only.** If a task is active, suspend it first
(`suspend_issue`), rewrite, then resume it (`resume_issue`); a resume restores the saved work onto the current head.

The ledger keeps the ordered history from its **base** to its **head**: task checkpoints and user-approved foreign
commits. `original_baseline` is the immutable fork point. `base` is where the *current* history starts: the fork
point until a rewrite moves it onto the commit the branch was rebased onto.

Inputs: `featureId`, `designRef`, `branch`, `oldHeadRef` (the head the ledger records), `upstreamBaseRef` (what the
branch was rebased onto), `headRef` (current HEAD), `defaultBranch`, `protectedBranches`, the same build/test/integration
checks and review settings as `validate_feature`, and optionally `resumeEvidenceRef`.

What it does, in order:

1. Requires a clean feature branch, an approved feature direction, no active task, HEAD equal to `headRef`, and
   `oldHeadRef` equal to the ledger's recorded head. The pre-rebase chain must still match Git (those commits remain in
   the object store until garbage collected).
2. Maps every recorded checkpoint and foreign commit onto the rebased commits, in order, on top of `upstreamBaseRef`.
   A checkpoint is recognized by its `Pi-Checkpoint: <task>` trailer, a foreign commit by its subject. A rebase that
   **drops, squashes, splits, reorders or adds** a recorded commit, or that contains merges, is refused.
3. Runs fresh full-project checks and an independent review of `upstreamBaseRef..HEAD`. Earlier receipts are
   historical and do not verify the rewritten trees.
4. Retains the verification (checks, review, the new history) as a ledger artifact, then records a `history-rewrite`
   entry. The previous history, its base and the verification reference stay in the ledger (`epochs`).

`PASSED` is returned only after the entry is recorded. Any other status records nothing; the evidence of a rejected
review or failed check is retained for diagnosis. A repeat, or a retry after a lost response, returns the same
record without needing a clean tree; pass the retained `evidenceRef` as `resumeEvidenceRef` to record a verification
that passed but whose entry was not recorded. Final validation then binds to the new base.

Commits made after the last recorded head that are not part of a rebase (for example unrelated files the user
committed) are recorded with `adopt_foreign_commits`, not here.
