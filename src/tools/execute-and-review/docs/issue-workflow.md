# Issue workflow


## Recursive issues: design then implement

All Scaffold features use the recursive issue graph (requires the matching
Scaffold release). There is no opt-in field or alternate lifecycle. The stored
workflow kind is `recursive-issues/v2`; the state schema is version 2. The root is created from the agreed
ticket. Pi uses `design-select`, `decompose` and `design-record` to approve designs
downward; `design-finish` gates all implementation. The API retains task IDs.
`execute_and_review` requires an explicit started issue. For a first attempt (or a
zero-attempt recovery handoff), the adapter adds the persisted acceptance criteria,
constraints and exact approved design to caller-supplied additional `requirements`
(which may be empty). Existing callers supplying the complete canonical text remain
supported. The assembled scope goes to Review and the retained receipt. Corrections
supply previousAttempt and fresh operations; the native adapter inherits the contract,
checks and authority. Structured contextUpdates retain discoveries and revisions.
Use `issueHandoffRef` instead of `previousAttempt` to continue directly from a
saved, applicable `prepare_issue_handoff` result. The adapter reauthenticates the
handoff and resolves its latest receipt before running the normal continuation
checks. If continuation reports a stale handoff or receipt, use the returned
`prepare_issue_handoff` recovery action to refresh the context, then inspect the
latest attempt before authoring corrections.
No caller transcription of inherited requirements or approval prose is needed.
Branch mismatches report current/expected branches, while malformed or stale
`task.designRef` values report the expected feature reference. These precheck errors
do not consume an execution attempt and do not require reapproval. Unbound execution cannot
bypass an unfinished recursive feature. Older task-state files are rejected without modification.

`checkpoint_verified_task` records its verified commit back into Scaffold. Retry
that native operation after interrupted bookkeeping; never fabricate a checkpoint
record. Empty parent verification still creates its own commit. Final verification
includes the original ticket and retained issue design contracts.

`suspend_issue` explicitly parks unfinished work for newly discovered issues.
Inputs: task binding, latest `previousAttempt`, reason, original featureBaseRef,
branch/default/protected scope. Retained feature authority covers
saved snapshots/index refs and a retained stash including untracked source; it
never publishes, completes an issue or resets attempts. A content-addressed intent
is retained first and returned as suspensionRef, including on failure. Retry that
same intent with suspensionRef and exact reason/scope; inspect source and stash
state first. Saved stashes/private refs are deliberately never automatically removed.
The original source must match the latest unsuccessful receipt and remaining budget.

After new children are designed, implemented and checkpointed, `resume_issue`
requires the same scope and suspensionRef. It authenticates checkpoint lineage,
precomputes source/index transplants to reject conflicts before source writes,
restores saved work with `git stash apply --index`, and retains a non-PASSED
`issue-handoff`. READY supplies consumedAttempts and resume arguments without old
executor input. Start the original issue and continue within the approved feature direction.
Use the returned handoff as previousAttempt; three attempts mean four next. A
handoffRef recovers interrupted evidence/Scaffold bookkeeping. Read snapshots and
receipts with inspect_conductor_evidence. Conflicts or unexpected changes block;
preserve saved refs/stash and reconcile explicitly. Ignore files/generated ignored
artifacts are outside snapshot coverage. A user-performed rebase still requires
the separate authenticated rebase-reconciliation path before prerequisite checkpoints.


### Issue recovery boundaries

A started issue with no retained attempt may return to Design through
`suspend_issue` without `previousAttempt`. This path requires a clean source/index
and confirms that no attempt receipt exists; it consumes zero attempts. Resume
returns an authenticated zero-attempt handoff. Supply fresh approved requirements,
checks and executor input for its first real execution; that execution is attempt 1.
Dirty unretained changes or any existing consumed attempt require normal receipt
reconciliation rather than this path. No dummy Conductor invocation is needed.

A suspended issue stays parked while the user rebases and `rewrite_feature_history` records it. `resume_issue` then
restores the saved work onto the ledger's current head, after checking that Git still matches the recorded history.

Pending checkpoint recovery pins the original staged subset atomically with the
checkpoint commit. A retry accepts that exact original index or an already finalized
verified index; another staged subset remains blocked. The private pending index
ref is removed after successful finalization.


## Scoped issue context

Scaffold `summary`, `issue --task`, `select` and `design-select` return bounded-by-scope
projections rather than the full feature/history. The Pi Scaffold tool uses scoped
selection and compact acknowledgements by default; explicit list remains available.
Native execution/checkpoint/recovery validation still reads complete state.

`prepare_issue_handoff` persists a content-addressed capsule as a scratch file under
`.scaffold/work/handoffs` (not ledger evidence), containing scoped contracts, current Git fingerprint,
latest authenticated attempt/findings excerpt and bounded agent navigation notes.
`inspect_issue_handoff` discovers by feature/issue or reads by reference and checks
current graph digest, source/index/HEAD and latest attempt. Stale handoffs return
only diagnostics and refresh instructions. `inspect_issue_attempt` loads exact fixed
continuation requirements/checks by receipt reference without executor input or raw
logs. None of these tools executes source, changes lifecycle state, grants approval,
resets attempts or substitutes summaries for full evidence validation. Handoffs are
local to this checkout; they are not pushed with commits. Large individual contracts
are retained intact rather than silently truncating criteria or decisions.


## One overall feature direction approval

Pi's native entry points now use `approve_feature_direction` as the sole user
confirmation for local delivery. Initialize the feature, present the full direction in chat and apply the user's
alterations with `scaffold_tasks design-revise` until they accept; then call this tool with
the accepted `designRef` for a short Yes/No confirmation bound to that reference. It stores a
content-addressed feature authorization binding repository, feature/design,
branch, original baseline, objective, criteria, constraints and local capabilities.
An existing matching grant is reused across sessions; missing UI, declined approval,
changed scope or corrupted evidence cannot grant permission. Existing features need
this broader approval once; individual issue approvals do not imply it.

Within scope Pi designs issues, authors input, implements, verifies, creates local
verified checkpoints and handles discoveries without asking again. The design-record
`approval` field identifies delegated authority and the actual reference; it must
not invent individual user approval. Execution, checkpoint, feature verification,
issue recovery and rebase verification native gates consult the same authority.
Phase, receipt, Git, attempt-budget and final-review checks remain enforced.
Approval receipts are excluded from final-validation evidence discovery and never
prove success. Final independent feature review and meaningful checks are mandatory;
in-scope findings return through the graph automatically. Material departures from
approved objectives, public behaviour or constraints require revised overall direction.
The grant does not authorize publishing, merging or arbitrary history rewriting.
