---
name: feature-delivery
description: >
  Orchestrate multi-task implementation of an initialized, approved Scaffold
  feature, using implement-task for issues and a final mechanical build/test gate.
---

# Autonomous feature delivery

## Cleaned or recreated feature state

`scaffold clean` is a human-only administrative action, not a recovery step,
tool or implicit initialization fallback. If the current Scaffold feature
is missing after a reset or its `workflow.instance_id` differs from retained
handoff/receipt authority, stop delivery. Do not reuse old attempts or approvals.
Preserve Git commits, source changes and external evidence; ask for explicit
new feature preparation through `init-feature` and a fresh overall
direction approval before any new work on the recreated instance.



This skill orchestrates multi-task delivery of a prepared feature.
Use `init-feature` to create or finish the approved Scaffold graph and
`design` for a standalone engineering contract. Here the agent owns task
selection, prerequisite recovery, correction graph decisions and final validation;
`implement-task` owns each task's execution and checkpoint loop.

Prepare → Implement → Validate. Reuse the one overall feature direction approval for the
local delivery loop. Do not ask for per-issue design approval, a second design
confirmation, execution permission, checkpoint confirmation or verification permission.
The retained direction authorizes scoped work across sessions. A context handoff
is navigation evidence; it cannot grant authority by itself.

Never directly modify the repository for implementation. Only native
`execute_and_review` applies exact Executor operations and runs checks/review.
Native checkpoints, verification and recovery retain their own deterministic
preconditions and use the same retained feature authorization. Do not substitute
Bash source edits, executor/review-cli calls, stash/reset or history rewrites.
For Git/GitHub publishing follow the Git and GitHub publishing policy: publication needs a user request;
Never merge PRs. Finish or suspend the active verification/correction loop before
publishing. Offer full operations on request, not by default.

## 1. Ensure an initialized feature

For a new Linear-backed feature or explicit requirements, invoke
`init-feature` to load the source, capture and approve the original
direction, create/reconcile the Scaffold graph, design/decompose all issues
and run `design-finish`. Do not duplicate that initialization logic here.
If an existing feature is already prepared, authenticate its persisted state,
original approval, branch, baseline, task graph and design phase. Continue
without reinitializing or requesting another approval. If the graph is still
in Design, or feature approval is missing, delegate to `init-feature`
to finish preparation; never claim a null selection means completion.

This skill owns the **multi-task implementation loop** and the final mechanical
build/test gate only. Preparation is separate from execution: `init-feature`
does not apply code or start tasks, and `feature-delivery` must not execute
before verified `design-finish`. Reuse the single retained direction grant
through task checkpointing, recovery and the final checks.

## 2. Implement upward and process discoveries

Use `select` for one eligible issue. Recover its current design and inspect source.
Do not redo design approvals or request execution confirmation. On the first attempt,
the adapter assembles persisted issue acceptance criteria, constraints and the complete
approved design into versioned review context. Supply only additional applicable
constraints and established interfaces in `requirements` (or an empty string); do not
manually reconstruct the design suffix or retype its formatting; original feature criteria remain authoritative. Copy `task.designRef` exactly from the scoped issue/select
response; it is the feature's `design_ref`, not the issue design reference. A branch
or reference mismatch requires inspecting current state, not another approval.

### Discovery exit hatch

Straightforward corrections remain attempts on the same issue. Missing prerequisites,
oversized remaining work and review findings within the approved direction return
the affected scope to Design without asking again. Stop the active loop and use
`suspend_issue` with the latest receipt, original baseline, branch/protection scope,
reason and reconciliation reference. It preserves tracked/staged/untracked source,
receipts, findings and attempts before parking work. Without any attempt, clean
zero-attempt suspension is supported. Inspect DESIGN and suspensionRef.

Design/decompose the new issues, `design-finish`, implement/checkpoint prerequisites,
then `resume_issue`. Inspect READY, handoffRef, consumed count and returned resume
fields. READY is not PASSED. Start the same issue, author fresh input, and continue
using the handoff as previousAttempt. Three consumed attempts mean the next is four.
Never reset the issue, weaken criteria/findings or blindly replay old operations.
Conflicts, stale state or exhausted budgets block with saved work retained.
Without unfinished work use `design-reopen` directly. Completed nodes remain intact;
a failed final check becomes a dependent corrective issue in the same graph.

Stop and ask only when the work requires changing approved objectives, externally
visible behaviour, explicit constraints or other material commitments, or when a
necessary decision cannot be inferred. Explain the departure before seeking revised
overall direction approval. Ordinary algorithms, internal boundaries, test selection
and corrections that satisfy the approved direction are delegated decisions.
Original ticket criteria must block rather than weaken them when incompatible work
is discovered. Do not fabricate revised evidence or replace an active feature.

## 3. Delegate one issue to implement-task

After `design-finish`, select the next eligible issue through Scaffold and
load `implement-task` with the exact `featureId`, `taskId`,
approved design and current context. The agent remains the sole orchestrator: the
task skill owns implementation operations, targeted check selection, bounded
Conductor attempts, in-scope corrections, evidence inspection and verified
checkpoint completion for **one issue only**. Its native execution mechanism
is still `execute_and_review`; the extension applies source operations,
runs checks and independent review, records authentic completion and commits
the exact reviewed tree. One invocation of the native tool is one attempt,
not an entire task or a feature.

On `stage: COMMITTED`, inspect the returned `nextBaseRef` and select the
next eligible task. Do not repeat completion/checkpoint operations. When the
task skill returns an unresolved blocker, missing dependency, oversized scope
or NEEDS_DESIGN requiring graph changes, stop task execution and use the
discovery exit hatch above: suspend with evidence, design/decompose remaining
work, `design-finish`, complete prerequisites, and `resume_issue` with an
authenticated handoff. Do not restart the feature, discard partial changes or
reset prior attempts. A review failure inside a bounded task is normally
handled by implement-task; a new graph is a feature-level decision.

Task-level `previousAttempt`, `repair_check`, targeted checks, correction,
checkpoint recovery, retained receipts, meaningful test evaluators and retry
details live in `implement-task`. Task completion requires authentic
PASSED evidence and exact Git checkpoint. The full repository test suite is
reserved for `run_feature_checks`, not repeated for each leaf or parent by
default. Original feature criteria and all completed descendants remain intact.
There is **no per-issue attempt limit**; evidence-backed stall detection and
resource/infrastructure pauses govern continuation.

## Checkpoints, recovery and final checks

Feature delivery ensures each dependency and parent issue is independently
completed and checkpointed before the final checks. Per-task Git tree and
index recovery is delegated to `implement-task` and its native tools.
Feature-level suspension, dependency changes, rebase reconciliation and
the final checks remain this workflow's responsibility.

## Final feature checks

After every leaf and parent is completed and checkpointed, run `run_feature_checks`
against the original baseline and original approved direction with meaningful full
project build and test commands. The feature authority covers these checks without
another confirmation. Zero exit status alone never establishes coverage; require
concrete successful test output (the approved `testSuccessPattern`). INDETERMINATE
or BLOCKED is BLOCKED.

Before running any check, both final gates require every canonical requirement to have
applicable implementation and verification evidence in Scaffold. `REQUIREMENT_EVIDENCE_INCOMPLETE`
names each requirement and the issue and role still outstanding: finish, re-run or add a corrective
issue for it, never mark it done. When the evidence is stale because a corrective issue changed a
requirement's contributors or verifiers, call `rebind_requirement_evidence`: it re-records only evidence whose
own review verified the requirement, and reports what it re-bound, skipped (re-run those issues) and what is
still outstanding. Then rerun the final checks.

This gate is mechanical. It performs **no independent or agent-based feature review**,
so do not call `validate_feature` from this workflow. Per-issue review during
`execute_and_review` is unchanged. Do not describe the feature as
independently reviewed as a whole.

The result is recorded in Scaffold as a checks-only result. A PASSED run makes the
feature's `validation_status` **`checked`** (full build and tests passed with meaningful
output); it is never `verified`, which Scaffold reserves for a result carrying an approved
independent review. A failed or blocked run records `failed` or `blocked`. A feature that is
already `verified`, or `accepted` by the user, at the same head is left unchanged. Any later
change to the task graph or history makes `checked` inapplicable again, so rerun the checks
after corrective work. Report `checked` to the user as exactly that.

Whether the user considers the feature complete is theirs to say, usually after they have
reviewed it and merged. When they explicitly ask you to mark it accepted or complete, call
`accept_feature` with the validated head (`binding.head` from the checks result). It shows no
dialog: state in chat exactly what is being accepted, take their yes, and it records `validation_status`
**`accepted`**. Call it only when the user explicitly asks: never on your own initiative, never as
part of this workflow, and never to make a failed or unchecked feature look finished. It needs a
`checked` or `verified` result and ends on any later graph or history change.
Resolve a failed check through a corrective issue (design, implement, checkpoint)
without further approval prompts, then rerun the checks. Preserve original criteria
and every historical failure. Stop on material scope changes as above.
Report the actual checks run and their output, any unresolved failures and the
reviewable commits/PR to the user. Tell the user that
`feature-questions` is available to generate verification questions for the
finished feature if they want a manual review. Do not invoke it yourself. Do not
declare completion from `select: null` alone.

If a clean user commit lands after authorization but before any task starts, or Git no longer matches the feature boundary, run `inspect_feature_drift`; for clean user commits between tasks it directs you to `adopt_foreign_commits`, which needs the user's explicit approval of the exact recorded head and new head and is not rebase recovery. Never edit Scaffold or recreate the feature to bypass a baseline mismatch.

For a user-performed rebase use `rewrite_feature_history` between tasks; if a task is active, `suspend_issue` it first and
`resume_issue` it afterwards. Preserve original receipts, baseline, criteria and budget. The retained feature authority covers
verification/recovery, not performing a rebase or arbitrary history rewriting. See src/tools/execute-and-review/docs/rebase.md for exact inputs.
A recorded rewrite also carries requirement evidence onto the rewritten checkpoint trees. If it reports
`REQUIREMENT_EVIDENCE_CARRY_INCOMPLETE`, repeat the same reconciliation to finish it.


## Scoped feature state and handoffs

Use `scaffold_tasks summary`, `design-select`, `select` and a scoped
`issue` query for the current phase; never treat null selection as proof of
completion. Within a selected issue, `implement-task` owns detailed
`prepare_issue_handoff`, `inspect_issue_attempt`, `previousAttempt`
and retained evidence inspection. Only Scaffold owns graph lifecycle state;
returning from task implementation does not authorize creation of unrelated
work. Feature delivery coordinates material approval amendments, suspended
issue prerequisites and final-check corrective issues without losing history.
