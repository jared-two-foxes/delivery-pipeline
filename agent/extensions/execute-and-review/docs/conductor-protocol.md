# Conductor v2 command and result translation

Pi supplies `input` (exact Executor JSON), `requirements`, `baseRef`, caller-selected
`checks`, and optional review budgets to the **native tool**, not a handwritten
Conductor request. Conceptually the adapter prepares these stage specifications (not a separate runner invocation):

Each named check may also supply `successCondition: [program, ...args]`. Conductor
runs it after the check, with the original exit code and complete output paths in
`CONDUCTOR_COMMAND_EXIT_CODE`, `CONDUCTOR_COMMAND_STDOUT_PATH`, and
`CONDUCTOR_COMMAND_STDERR_PATH`. Its exit 0 permits the next command, including
when the original exit was nonzero. Use this only for a known tool-specific
contract; Cargo build/test exit status is normally sufficient. The last check's
source/index boundary is captured before its condition is evaluated. Pi retains
the condition decision in its command-prefix evidence before an automatic commit.
Review always has a condition that validates complete `review.result/v1` output
and requires `APPROVED` with no blocking findings before the commit entry runs.

```json
[
  {"name": "executor", "program": "executor", "args": ["apply", "/repo/.scaffold/work/runs/attempt-unique/executor.json"]},
  {"name": "invoice tests", "program": "cargo", "args": ["test", "--lib", "invoices::"]},
  {"name": "review", "program": "review-cli", "args": ["run", "--request", "/repo/.scaffold/work/runs/attempt-unique/review.json", "--format", "json", "--model", "opencode/gpt-6-luna", "--wall-clock-budget-secs", "180", "--max-turns", "20", "--ledger", "/repo/.scaffold/work/runs/attempt-unique/review-ledger.jsonl"]}
]
```

The actual Executor and Review entries run through `input-guard.mjs` using Node.
Their arguments bind SHA-256 identities of `executor.json`, `review.json`, and
`requirements.md`. The guard checks the files immediately before and after the
external tool runs and fails the command if any input changed. The stage receipt
retains that exact guarded invocation, and authenticated task evidence verifies
its input identities against the originally retained values.

The paths illustrate a normal repository; linked worktrees use `git rev-parse
--git-path` to resolve their metadata. `executor.json` contains the exact operations
array. `review.json` uses `review.request/v1`, the same repository and fixed full
base SHA, `head_ref: ":working"`, and `requirements` pointing to a UTF-8 file of
**complete original requirements**. Provider/model/budget settings are CLI flags,
not fields in that Review request. Defaults are 180 review seconds and 20 turns;
explicit `review*` overrides are forwarded. Review's own defaults govern omitted
extra limits. These defaults are caller policy, not Conductor's old scaled budgets.

For task-bound attempts the last selected check runs through `test-boundary.mjs`,
which preserves that command's stdout/stderr and exit status and records the
source/index snapshot immediately before Review. The adapter wraps each stage to
retain its actual exit status, then appends the verified Git commit command to
**the same Conductor command list**. Normal delivery uses exactly one runner invocation.

## Automatic post-review commit

The native `execute_and_review` tool now includes local task finalization. Supply:

```json
"checkpoint": {"defaultBranch": "main", "protectedBranches": []}
```

Use the actual default and all additional known protected branches. The feature's
approved branch and original baseline come from Scaffold, not newly guessed values.
Missing metadata or a protected target blocks before source application.

The final commit is part of the **original** `conductor.request/v2`, not a
post-success callback or a second automatic request. An actual wire request looks
like this (paths are illustrative):

```json
{
  "schema": "conductor.request/v2",
  "working_directory": "/repo",
  "output_directory": "/repo/.scaffold/work/runs/attempt-unique",
  "commands": [
    {"name": "executor", "program": "/path/to/node", "args": ["/extension/command-stage.mjs", "/repo/.scaffold/work/runs/attempt-unique/0.stage.json"]},
    {"name": "invoice tests", "program": "/path/to/node", "args": ["/extension/command-stage.mjs", "/repo/.scaffold/work/runs/attempt-unique/1.stage.json"]},
    {"name": "review", "program": "/path/to/node", "args": ["/extension/command-stage.mjs", "/repo/.scaffold/work/runs/attempt-unique/2.stage.json"]},
    {"name": "git commit verified task", "program": "/path/to/node", "args": ["/extension/commit-task.mjs", "/repo/.scaffold/work/runs/attempt-unique/delivery.json"]}
  ]
}
```

Each stage descriptor contains the exact underlying executable/argv above.
`command-stage.mjs` runs that program with inherited stdout/stderr and retains its
actual process status before returning the same success/failure to Conductor.
Conductor alone advances through the list, so an earlier failure skips commit.
The final command additionally parses complete Executor/Review JSON and checks the
pre-review source/index boundary before any task completion or Git commit.

The enclosing runner has not returned when commit starts. Therefore the final
command seals a caller-owned `pi.command-results/v1` verification prefix from the
actual `pi.command-receipt/v1` records; it never fabricates a completed Conductor
response. The content-addressed task receipt marks its producer as
`pi.command-receipts/v2`, retains exact stage/input identities and the full delivery
request, and authenticates the reviewed source/baseline. The actual complete v2
runner response is retained separately in the attempt's `response.json` after the
one invocation finishes. Historical direct v2/v1 task receipts remain readable.

The final command reauthenticates retained feature authority, latest task evidence,
current issue design and checkpoint lineage, records matching Scaffold completion,
then uses the existing private-index/commit-tree/update-ref checkpoint logic to
commit the exact reviewed tree. No model decision, extra confirmation, indiscriminate
staging or hooks occur between review and commit. The workflow deadline applies
to the single list. A commit-only Conductor request is used **only for explicit
recovery** with `checkpoint_verified_task`, never for normal automatic delivery.

On success the native result has `stage: COMMITTED`, checkpoint provenance and
`nextBaseRef` for the next issue. Completion/checkpoint state is already recorded;
the agent must not repeat those operations. Failed implementation/check/review
never enters this stage. A failed commit returns BLOCKED with
`implementationStatus: PASSED`, the original evidence and finalization log path.
Do not replay source operations. Recover using `checkpoint_verified_task` and the
same receipt/scope; it resumes completion or commits as needed, including recovery
of a commit whose response was lost. Successful implementation receipts remain
immutable and continue to describe the pre-commit reviewed baseline.

Sealing and terminal failure recording share an exclusive per-attempt claim. If
an interrupted command still owns that claim, the result is BLOCKED with
`TERMINAL_RECEIPT_PENDING`; no competing success/failure receipt is invented.
Inspect the latest evidence and Git state before recovery. A STARTED receipt
never authorizes a commit or replaying the list.

The lower-level `executeAndReview` library still performs verification only for
existing integrations/tests. Automatic completion/commit is the native Pi delivery
entry point.

Conductor returns generic `conductor.result/v2`: exits 0/1/2 mean
PASSED/FAILED/BLOCKED. The adapter validates every returned command's index,
program, literal arguments and order, the stop location and the runner exit code.
It reads **complete** Executor and Review stdout from retained files, not truncated
previews. Inline output is accepted only when explicitly untruncated; this does
not make binaries lacking the request output_directory field compatible. Missing, unsafe, malformed or contradictory tool output blocks the
attempt. Structured tool JSON has a 16 MiB parser limit; complete logs remain on
disk for inspection if it is exceeded. Check diagnostics stay in their files.

The adapter projects results to `pi.conductor-result/v1` inside the existing
native tool result; this is a caller-owned domain view, not a Conductor wire schema:

| Tool outcome | Pi outcome |
| --- | --- |
| Executor succeeds, all requested checks exit 0, Review completes APPROVED/exit 0 | PASSED |
| Executor reports unsuccessful application, or a check exits nonzero | NEEDS_DESIGN |
| Review completes CHANGES_REQUESTED/exit 1 with blocking findings | NEEDS_DESIGN |
| Review INDETERMINATE/exit 3, setup/provider errors, signals, runner/protocol errors | BLOCKED |

The normalized verification view retains effective Executor/check/Review specifications,
complete parsed tool output and authenticated process receipts. Content-addressed
task receipts retain that prefix plus exact request-file contents, original args,
source boundary and the full single-list delivery request. The enclosing raw
Conductor request/response stays available in the attempt directory. Checkpoint
authentication reconstructs and cross-checks it without depending on mutable log
files still being present. Historical successful v1 receipts remain readable;
active calls never accept a v1 runner as a successful new attempt.

Requests, full logs and Review ledgers remain in Git metadata alongside receipts,
outside review diffs. Keep them while referenced by active tasks; do not delete an
attempt directory just because its preview was returned. The model-facing native
response omits raw request/output dumps and excerpts long findings; use
`inspect_conductor_evidence` and returned stdout/stderr paths for complete detail.
The runs and receipts are local data and are not transferred by Git push/clone.


## Current limits

- Conductor does not yet prove tests executed or detect unexpected source
  modifications during verification. The adapter imposes a 30-minute overall
  workflow deadline by default, covering execution, formatting, checks and
  independent review; it is not a per-check deadline. Callers may override it
  per invocation with `workflowTimeoutMs` (positive safe integer, maximum
  2147483647 ms, about 24.8 days). This overall deadline is independent of
  `reviewWallClockBudgetSecs` and the other review-specific budgets. Expiration
  blocks the attempt and does not authenticate tests or review. The adapter
  kills the direct Conductor child but does not explicitly terminate or await
  descendant processes.
