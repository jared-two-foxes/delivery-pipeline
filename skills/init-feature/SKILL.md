---
name: init-feature
description: >
  Prepare an existing Linear ticket or supplied feature requirements in Scaffold:
  capture scope, record the feature direction, design/decompose the whole issue graph,
  finish Design, then present the resulting design, all without implementing source changes.
  There is no approval gate: the user reviews the design in Scaffold afterwards.
---

# Initialize a feature

## Clean/reinitialization boundary

A human may explicitly reset a feature using the separate administrative
`scaffold clean` CLI. The agent must **never** use that command automatically
or offer it as a way to bypass blocked state or failed attempts. If the
feature is missing after a clean, do not restore old approvals, task snapshots,
execution receipts or checkpoint history from Git metadata. New Scaffold
`scaffold init` generates a different `workflow.instance_id`, so previously
retained approvals cannot authorize the new feature even with the same
Linear ID, design, branch and original baseline. Re-run normal intake,
inspect any surviving Git/source/evidence, present the direction and obtain
a genuine new approval. Preserve unrelated work; cleaning never edits Git.



Prepare a persistent Scaffold feature without initiating autonomous implementation.
This skill is independently invocable (for example, invoke `init-feature` with `SA-585`)
or called by `feature-delivery` before its multi-task implementation loop.
The source can be a Linear ticket or explicit user-supplied requirements.

## 0. Load the source and reconcile existing state

For a Linear identifier, fetch the ticket with a read-only Linear integration (Pi provides
`linear_get_ticket`; otherwise use a configured Linear MCP server's issue-read tool). If none is
available, ask the user to paste the ticket contents. Do not create, modify or close any Linear
issues. Capture its identifier,
URL, title, full description, acceptance criteria and relevant constraints
verbatim in the original feature context. Preserve the ticket as source material:
do not invent criteria, silently discard constraints or treat Linear status as
authorization to modify code. Derive a concise engineering objective and
testable acceptance criteria; explicitly report important ambiguity before approval.

Inspect the current Git repository root, full baseline commit, feature branch,
working-tree/index status and repository-specific instructions. Verify the Linear
ticket belongs to this repository; do not infer a repository from its identifier.
Use a stable feature ID from the ticket identifier (for example `SA-585`) unless
an existing mapping is already established. Store the source reference in the
immutable feature context and use `origin: {kind:"ticket", reference:"SA-585"}`
on any additional ticket-derived issues; the Scaffold root is created automatically
by `init`. Preserve the original baseline/branch binding.

**Before creating anything**, query `scaffold_tasks summary` (and scoped `issue`
when applicable) for that feature ID. If it already exists, verify the source
identifier, original approved direction, design reference, repository, baseline,
branch, status and any current attempt/checkpoint receipts. Reuse the existing
feature and resume only its unfinished design phase when compatible. Never call
`init` again to overwrite, rebase, or conceal a mismatch. If the ticket changed
after the immutable design context was captured, report the delta and use the
explicit feature-amendment/design recovery procedure where permitted; do not
silently mutate original criteria or treat a new Linear revision as an approval.
Do not start a replacement feature or reset attempt history on errors.

## 1. Discover the source requirements and record the direction

Inspect the actual repository, existing source, relevant tests, interfaces, Git
branch/status and local instructions. Establish the ticket objective, acceptance
criteria, boundaries, important interfaces, constraints and proposed approach.
Ask the user only when a choice that affects their objectives, public behaviour,
compatibility, cost or scope cannot be inferred from the source; otherwise decide and
carry on. Do not design every private detail up front.

### Constraints and gates must come from the source

Record the ticket's own requirements as stated; do not strengthen them. In particular,
do not turn a ticket's stated dependency or ordering ("depends on SA-588") into a stricter
gate of your own, such as a retained local receipt, a validation result or an approval, and
do not record such a gate as a feature or issue constraint or in a design. Record the
dependency as the ticket states it (a Scaffold dependency edge where one exists in this
graph, otherwise plain context) and treat the stricter question as a delta to raise.

If you believe an extra constraint, prerequisite or gate is genuinely needed, do not put it
in the ticket-derived constraints. List it in the final presentation (§3) under the heading
**Agent-added constraints (not in the ticket)**, with the reason. If the user has not
seen it, it is not an approved constraint. When you later find that a blocker is an
obligation you added yourself, say so and ask the user to override it with
`approve_delivery_amendment` rather than stopping.

### Feature planning and the single approval record

Write a concise overall design direction and the intended local delivery scope:
design/decomposition, implementation, relevant checks and independent review,
verified local commits, final build/test checks, and necessary issue/rebase recovery.
Persist its exact text in feature context using `scaffold_tasks` `init`, immutable
`design_ref: "sha256:context"`, original full Git baseline and feature branch.
Scaffold creates the root issue.

**There is no approval gate.** Do not wait for the user between `init` and the end of the
design. Immediately after `init`, call native `approve_feature_direction` with featureId and
the feature's `designRef`. This is bookkeeping, not a user decision: there is no prompt, and it
records the scope-bound authority that later execution, checkpoint and recovery tools require.
It refuses if the stored design differs. An existing matching record is reused, including
after a new session. Preserve its returned reference for `design-record`. Never describe the
record as something the user approved. It does not grant publishing or merging.

`design-revise` is refused once the direction is recorded. The user reviews the finished design
in Scaffold afterwards; changes that depart from the recorded direction go through the
amendment/design-reopen procedures in `feature-delivery`, not by rewriting this design.

An existing feature may use this tool to record its retained overall direction
once. Prior per-issue approvals alone do not imply this broader delivery grant.

## 2. Design the issue graph downward

Conversational memory is not authoritative; authenticate persisted state and evidence.
Use `summary`, then `design-select` for
one eligible issue. Inspect only that issue's scoped context, ancestor contracts,
inherited dependencies and relevant source. Make detailed engineering decisions
within the approved direction yourself. Share concise progress when useful;
do not turn design previews into additional approval requests.

### One bounded design pass

Use `design` to produce the issue's bounded engineering contract; persist
that contract using the existing `design-record` operation. The design skill
itself must not initialize Scaffold, authorize implementation or invoke execution.


Define inputs, outputs, immediate responsibilities, interfaces, invariants,
producers/consumers, ownership/lifecycle, failure behaviour and verification.
Use focused `diff` blocks with changed portions marked when explaining decisions;
these are illustrative design excerpts, not executor input. Keep the implementation
preview proportional to the issue and cover acceptance criteria and edge cases.

Mandatory decomposition applies when the issue cannot be understood, implemented
and independently verified in one bounded scope. Add immediate children with
`decompose`; defer their internal details to their own design passes. Preserve
ancestor dependencies and completed descendants. Every child needs a stable ID,
objective, criteria, context, constraints and explicit dependencies. Put
`Verification:` strategy and edge cases in context; retain review/discovery origin.
Definitions remain immutable. Small changes use the root itself as the leaf.

Persist each agent-authored design with `design-record`:
`{summary, verification, approval, disposition: "leaf"|"decomposed"}`.
The existing `approval` field records delegated authority, for example:
"Agent-designed under overall feature direction authorization <actual reference>;
no separate user approval was requested for this issue."
Never claim the user approved an individual issue if they did not. Add a parent's
immediate children before recording its design. Reopened designs retain their
history and invalidate affected unfinished designs, which the agent redesigns autonomously.

Continue downward until every issue has a complete design, then `design-finish`.
No implementation may run before this entire graph design phase completes.
Scaffold validates structure and association, not authority or verification truth.


## 3. Stop at the prepared-feature boundary

On successful `design-finish`, read `scaffold_tasks summary` and verify the
persisted graph is in Implement phase, every required issue has a recorded
design, and the original feature direction record is retained and applicable. A
single root leaf is valid for a small ticket. This skill **never** calls
`implement-task`, `execute_and_review`, `run_feature_checks`, starts an issue, edits
application source or creates a checkpoint. If the direction cannot be recorded, design
remains incomplete, or state authentication is inconclusive, stop and report the exact
phase/blocker.

### Present the design

Your final reply presents the finished design in full so the user can review it (they can
also explore it in Scaffold): feature ID, Linear source, branch/baseline, direction reference,
objective and acceptance criteria, scope and non-goals, approach, the issue graph with each
issue's objective, dependencies and verification, any **Agent-added constraints (not in the
ticket)**, risks, unresolved blockers and issue counts. Say plainly that nothing was
implemented, that no user approval was requested, and that the user can ask for changes.
Mention that `feature-delivery` starts implementation.

The recorded direction is scoped to the described feature direction and possible
subsequent local implementation/checks/review/checkpoints. Initializing a feature
does not itself grant publishing permission or initiate implementation. Retain
the existing one-direction record across sessions; do not ask the
user to approve individual issue designs.
