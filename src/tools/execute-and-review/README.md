> Current Pi continuation API: see [RECOVERY.md](RECOVERY.md). Continuations inherit
> context from receipts and Scaffold; no exact requirements-string copy or lifetime
> attempt allowance is required.

# Pi delivery extension

`index.ts` registers `execute_and_review` and delivery inspection and approval tools.
The workflow in `delivery.mjs`, `adapter.mjs`, and `pipeline.mjs` owns task
binding, continuation, and one execution/check/review pass. `workflow.mjs`
prepares Executor and Review inputs. Shared verification authenticates their results.

The workflow uses the sibling [Conductor client](../../../pi/conductor/README.md) to run
the plan. The Executor and [Review](../review/README.md) clients describe their
CLI invocations and validate their results. Execute and Review assembles those
steps and consumes shared authorization, evidence, and verification contracts.

The sibling `execution-recovery` extension registers handoff, suspension,
restore, and rebase tools and implements commit recovery. The `checkpoint`
extension owns task completion and Git checkpoint creation and registers
`checkpoint_verified_task`. `feature-validation` registers the final feature
gate and its evidence inspection tool.

Shared modules have narrower responsibilities.

| Library | Responsibility |
|---|---|
| `lib/scaffold` | Issue and feature types and structural request/response validation |
| `lib/verification` | Check plans, meaningful results, review evidence, attempt chains, and checkpoint history |
| `lib/evidence` | Immutable receipt retention, lookup, and reference integrity |
| `lib/git` | Source snapshots, tree/index operations, and tracked-input monitoring |
| `lib/authorization` | Feature approval and amendment authentication using supplied structures |
| `lib/delivery-state` | Context transformations, journal anchors, bindings, and retained handoffs |

The Scaffold extension owns CLI invocation and state reads. Execute and Review,
Recovery, and Checkpoint supply fresh Scaffold data to the shared validators and
own lifecycle writes. See [the library boundaries](../../lib/README.md).
Plans and retained workflows require guards and evaluators from `lib/verification`.
Obsolete helper identities and receipt producers are rejected, without rewriting retained evidence.

## Native Pi installation

Install the repository as a Pi package (see the root `README.md`); it loads every extension and skill
together with the shared `src/lib/` tree, so there is nothing to copy.

Install `conductor` on PATH or set `CONDUCTOR_BIN` to its executable path. Install `executor` and
`review-cli` separately on PATH, or set `EXECUTOR_BIN` and `REVIEW_CLI_BIN`.
Conductor must support v2 with retained-output/output_directory support;
v1 runner responses are rejected without fallback. Pi loads `/skill:init-feature` for Linear/requirements preparation without implementation,
or `/skill:feature-delivery` when autonomous feature implementation is requested, or you can
invoke it explicitly for the complete approved feature workflow. It
uses `/skill:executor` to author exact operations and the native
`execute_and_review` tool to apply them under retained overall feature authority.
`/skill:implement-task` owns task-scoped implementation, correction and checkpoint recovery; the native `execute_and_review` tool remains one bounded Conductor attempt.
`/skill:conductor` covers the standalone runner protocol. The legacy
`/skill:tdd` direct-edit workflow has been retired; TDD remains an optional
implementation strategy within Design.

Pi skills do not pin a model or establish a separate agent.
The active Pi model executes the Design persona in the current conversation.


## Reference

Each topic below has its own document in [`docs/`](docs/); [RECOVERY.md](RECOVERY.md) covers continuation and recovery of a
single attempt.

| Document | Covers |
|---|---|
| [Caller-selected task verification](docs/verification-checks.md) | The `checks` list, read-only checks, broad-check guardrail, how verification results gate a checkpoint |
| [Conductor v2 protocol](docs/conductor-protocol.md) | How `execute_and_review` becomes one Conductor request, the automatic post-review commit, result translation, current limits |
| [Continuing a review that hit a limit](docs/review-resume.md) | `reviewResume`, checkpoints and the conditions under which resuming is refused |
| [Task receipts and checkpoint preflight](docs/task-receipts.md) | Task binding, content-addressed receipts, `repair_check`, check evidence given to independent review |
| [Feature validation](docs/feature-validation.md) | `validate_feature`, and the precondition cache it uses |
| [Continuing after a rebase](docs/rebase.md) | `rewrite_feature_history` and the rebase workflow |
| [Issue workflow](docs/issue-workflow.md) | Recursive issues, suspend and resume, scoped issue context, the single feature direction approval |
| [Timing telemetry](docs/timing-telemetry.md) | Where delivery time is recorded and how to read it |
