# Task receipts and checkpoint preflight

Copy `evidence.mjs` with the rest of this directory. Optional `task` binding
(`featureId`, `taskId`, `designRef`) enables repository-local content-addressed
receipts and an initial clean-tree preflight, excluding `.scaffold` bookkeeping.
Legacy unbound calls retain their protocol behavior. Task-bound corrections use
`previousAttempt` and must match the recorded task, requirements, commands,
baseline and tree. No task selection, lifecycle mutation or automatic retry is
implemented here. Pi retains approval and repeated-failure decisions.

Failed/blocked runs retain their actual post-execution source/index fingerprint.
Use `inspect_issue_attempt` and pass its `continuation` fields with newly authored
current-state operations. Already-applied edits need no identity operations;
`{"operations":[]}` reruns verification/Review without replaying source edits.
The original baseRef stays fixed so Review sees the complete cumulative diff.
Never reset source, remove receipts/private refs, or checkpoint unverified work to
recover. `retry`/`start` lifecycle transitions do not reset consumed attempts.

For an incorrect command invocation, supply a `contextUpdates` entry with
`kind: "repair_check"`, the original `checkId`, repaired `command` argv and a
nonblank `reason` (at most 4000 characters), alongside `previousAttempt`. Preserve
the check names/order, all success conditions and the approved coverage contract.
Preflight and correction-chain authentication enforce the same rule. The reason,
prior receipt reference and current plan are appended to independent Review's
requirements without changing the fixed task requirements. Old and new commands
remain in linked receipts; all invalidated checks and Review run again; unchanged checks can be reused only
with the explicit measured-environment declaration described in [RECOVERY.md](../RECOVERY.md). This allows a missing
`sh` command to be replaced with an equivalent native invocation, not a failing
test to be bypassed. Semantic coverage remains a Pi/Review responsibility; a reason
alone is not proof of equivalence. Contract or validator changes require Design
recovery. For a malformed evaluator on a recognized test runner, use the
`repair_check` update with `useMeaningfulTestEvaluator: true` after the approved
redesign and authenticated resume. See [the recovery guide](../RECOVERY.md).
Ordinary corrections preserve check identities and coverage; structured revisions are audited.

BLOCKED stops that command list. Pi diagnoses the result and continues recoverable,
in-scope corrections under the existing feature authorization, subject to the same
persisted infrastructure/resource pauses and evidence-backed stall detection. Unavailable credentials/prerequisites or
unrelated source/index drift remain concrete blockers. Prefer executable/argv
commands; inspect the platform before using shell syntax. Native Windows does not
imply `sh` is installed. Use an available native shell only when necessary.

An execution `resume_issue.handoffRef` remains valid through `scaffold_tasks start`.
It is separate from the read-only `prepare_issue_handoff` capsule, whose graph digest
and task_revision intentionally become stale after lifecycle mutations. Refresh
that capsule and continue with the same execution receipt. Never weaken context
staleness checks or use context references as execution evidence.

`inspect_conductor_evidence` reads a receipt by its returned
`sha256:<digest>` reference and reports whether the current tree
matches. Records are under Git metadata, outside review diffs. STARTED intent is
written before execution; final records retain the request, raw process response,
result, task/design identity, attempt number and tree fingerprints. Missing or
corrupt records cannot justify completion. Retention failures block completion;
source may already have changed, so reconcile before proceeding. Initial intent
write failure prevents invocation. Hashes detect corruption, not hostile local
rewriting. Fingerprints cover index/diff and nonignored untracked regular files;
ignored build outputs and Scaffold state are outside the fingerprint. Git's diff
output limit is 16 MiB; fingerprint failures block rather than weakening evidence.

## Check evidence in independent review

The task pipeline keeps full logs, requests, and content-addressed receipts in
the existing worktree-specific Git metadata paths. It passes a bounded evidence
summary through Review CLI's requirements-file input. Review CLI loads this
input before starting the model, so the reviewer receives the evidence with the
task criteria and uses its existing tools to inspect code. It needs no additional
repository-tool access. Moving all artifacts to an ignored working-tree directory
would expose raw diagnostics to working-tree reads and would not serve a review
of a committed tree.

The summary identifies the attempt intent receipt, reviewed tree and index
fingerprint, check command, exit code, validator outcome, receipt and log digests,
and recognizable test counts from bounded log excerpts. Each check must start
and finish on the reviewed snapshot. Conductor checks the receipt/validator pair
before invoking Review, guards the generated inputs during invocation, and
reconstructs the handoff from the sealed result during checkpoint authentication.
The existing receipt references and older authenticated receipts remain valid.

A matching current pass gives Review evidence to resolve an earlier failed-check
obligation by ID. Review still assesses each open obligation and can reject an
inequivalent repair or a separate code finding. The task handoff covers targeted
verification. Final feature validation uses the authenticated checkpoint to
carry that resolution forward while running its separate full-project checks
and cumulative review.

Raw logs and private Git paths stay local. Only recognizable test counts are
extracted from new task log output for review. Check names and command arguments
are visible to Review, so use credential injection through the process environment
and keep secrets out of commands, requirements and check names. The generated
requirements and request files use the existing private attempt directory and
follow its retention lifecycle. Preserve that directory if a receipt still
depends on its logs for reuse, or if the original review input must remain
available for audit.

Keep receipts as long as Scaffold references them; preserve separately when moving
a checkout because Git push/clone does not transfer them. Never claim that a
structural PASSED check proves meaningful tests ran: inspect actual output.

Run `node --test tests/workflow/task-workflow.test.mjs tests/conductor/conductor.test.mjs`.
For the dependent-task/recursive-recovery scenario with real Scaffold, set
`SCAFFOLD_SOURCE=/path/to/scaffold`. Conductor/model responses are fixture data.

Before task execution, `.scaffold/` bookkeeping must be ignored and untracked so
it cannot enter Conductor's review diff. Inspect existing ignore rules. If state
is visible to Git, stop and have an authorised ignore rule established; do not
silently edit `.gitignore`, Git configuration or index. The task-bound preflight
returns `SCAFFOLD_REVIEW_SCOPE` for visible state. A source ignore-file change,
if needed, follows its own feature-authorized verification and checkpoint workflow.
