/**
 * The execute_and_review delivery tools, host-neutral (see lib/host/tool.mjs).
 *
 * Sends the conductor.request/v2 command-list protocol to the deterministic Rust Conductor CLI.
 * `Type` is a TypeBox-style schema builder supplied by the host adapter.
 */
import { executeAndCheckpoint } from "./delivery.mjs";
import { executionSummary } from "./workflow.mjs";
import { approveFeatureDirection } from "../scaffold/feature-authorization.mjs";
import { inspectEvidence } from "./inspect-evidence.mjs";
import { abandonInflightAttempt } from "./abandon-attempt.mjs";
import { reconcileExternalChanges } from "./reconcile-attempt.mjs";
import { scaffoldCliUsage, scaffoldCliUsageSince } from "../scaffold/adapter.mjs";
import { combineScaffoldUsage } from "../../lib/verification/timings.mjs";
import { approveDeliveryAmendment } from "./context-amendment.mjs";
import { defineTool, toolResult, withFailureReporting } from "../../lib/host/tool.mjs";

export function createExecuteAndReviewTools(Type) {
  return [
    withFailureReporting(defineTool({
      name: "approve_delivery_amendment",
      label: "Approve material contract amendment",
      description:
        "Records the user's approval of a concrete material scope/criterion/finding/constraint delta, including before an issue's first attempt (supply task instead of previousAttempt), so an incorrect recorded obligation can be overridden by the user. There is no dialog: first show the user the original IDs, the replacement and the reason in chat, and call this only after they explicitly say yes to that exact change; never on your own initiative and never to unblock yourself. Retains original obligations, source, authorization and all execution history. Routine corrections do not use this tool. Apply the returned reference through contextUpdates.apply_amendment; approval never establishes verification.",
      parameters: Type.Object(
        {
          previousAttempt: Type.Optional(
            Type.String({ description: "Latest unfinished attempt receipt. Omit only before the issue's first attempt." }),
          ),
          task: Type.Optional(
            Type.Object(
              { featureId: Type.String(), taskId: Type.String(), designRef: Type.String() },
              { additionalProperties: false, description: "Scaffold task identity; supply instead of previousAttempt before the first attempt" },
            ),
          ),
          ids: Type.Array(Type.String(), { minItems: 1 }),
          replacement: Type.String({ minLength: 1 }),
          reason: Type.String({ minLength: 1 }),
        },
        { additionalProperties: false },
      ),
      async execute(params, host) {
        const result = await approveDeliveryAmendment(
          params,
          { directory: host.cwd, abort: host.signal },
          {
            // The user's yes in the conversation is the approval; no dialog (dialogs stall hosts that cannot show them).
            confirm: async () => true,
          },
        );
        return toolResult(result, { indent: 0 });
      },
    })),
    withFailureReporting(defineTool({
      name: "approve_feature_direction",
      label: "Approve feature direction",
      description:
        "The single approval for this feature's direction and local delivery loop. Called by init-feature straight after scaffold_tasks init, with the feature's exact designRef; it refuses if the stored design differs. There is no user prompt and no approval gate: this only records the scope-bound authority that execution, checkpoints and recovery require, and it must not be described as a user approval. scaffold_tasks design-revise is refused once it is recorded. Persists authority for scoped design, implementation, checks, independent review, checkpoints and recovery across sessions. No per-issue confirmations. Does not authorize publishing, merging or changing the approved objectives/constraints.",
      parameters: Type.Object(
        {
          featureId: Type.String(),
          designRef: Type.String({ description: "design_ref of the design the user just read and accepted (sha256:...)" }),
        },
        { additionalProperties: false },
      ),
      async execute(params, host) {
        const result = await approveFeatureDirection(
          params,
          { directory: host.cwd, abort: host.signal },
          {
            // The user's yes in the conversation is the approval; no dialog.
            confirm: async () => true,
          },
        );
        return toolResult(result, { indent: 0 });
      },
    })),
    withFailureReporting(defineTool({
      name: "execute_and_review",
      label: "Execute and Review (Conductor)",
      description:
        "Under the approved feature direction, construct and run ONE Conductor v2 command list: " +
        "external Executor, caller-selected verification, then external Review. After approval, automatically record task completion and run a verified Git commit command through Conductor. " +
        "Returns PASSED, NEEDS_DESIGN or BLOCKED. One call never retries or generates fixes; Pi diagnoses recoverable failures and continues with an applicable issueHandoffRef or the latest previousAttempt against its retained after-tree. Use empty operations for verification-only retries.",
      parameters: Type.Object({
        checkpoint: Type.Optional(
          Type.Object(
            {
              defaultBranch: Type.String({
                description:
                  "Known repository default branch; protected from automatic commits",
              }),
              protectedBranches: Type.Array(Type.String(), {
                description: "All additional known protected branches, or []",
              }),
            },
            {
              additionalProperties: false,
              description:
                "Automatic post-review local commit context; branch and original baseline come from the approved feature; inherited on continuation",
            },
          ),
        ),
        task: Type.Optional(
          Type.Object(
            {
              featureId: Type.String(),
              taskId: Type.String(),
              designRef: Type.String(),
            },
            {
              description:
                "Scaffold task identity and approved immutable design reference",
            },
          ),
        ),
        previousAttempt: Type.Optional(
          Type.String({
            description:
              "Retained receipt for the previous attempt of this same task. Supply this or issueHandoffRef for corrections/recovery.",
          }),
        ),
        issueHandoffRef: Type.Optional(
          Type.String({
            description:
              "Applicable saved issue handoff. Resolve its exact latest receipt for continuation. Use instead of previousAttempt.",
          }),
        ),
        reviewProbe: Type.Optional(
          Type.Boolean({
            description:
              "Explicit bounded no-source health probe after environment-only credential repair. A failed probe is throttled for five minutes; no assertion of repair grants approval.",
          }),
        ),
        reviewContextMaxBytes: Type.Optional(
          Type.Integer({
            minimum: 1024,
            maximum: 8388608,
            description:
              "Review context resource allowance; default 200000 UTF-8 bytes. Increase explicitly when required without dropping obligations or resetting history.",
          }),
        ),
        input: Type.String({
          description:
            "Exact executor JSON with an operations array; authored by the agent",
        }),
        requirements: Type.Optional(
          Type.String({
            description:
              "Additional initial scope; inherited original obligations are assembled from persisted records. Omit on continuation and use structured contextUpdates.",
          }),
        ),
        baseRef: Type.Optional(
          Type.String({
            description:
              "Original task-start full 40-character Git SHA; resolved from the retained receipt on continuation",
          }),
        ),
        contextUpdates: Type.Optional(
          Type.Array(
            Type.Union([
              Type.Object(
                {
                  kind: Type.Literal("apply_amendment"),
                  reference: Type.String(),
                  reason: Type.String(),
                },
                { additionalProperties: false },
              ),
              Type.Object(
                {
                  kind: Type.Literal("add_obligation"),
                  id: Type.Optional(Type.String()),
                  text: Type.String(),
                  findingId: Type.Optional(Type.String()),
                  reason: Type.String(),
                },
                { additionalProperties: false },
              ),
              ...["annotate", "correct_assumption", "revise_design"].map((kind) =>
                Type.Object(
                  {
                    kind: Type.Literal(kind),
                    text: Type.String(),
                    reason: Type.String(),
                  },
                  { additionalProperties: false },
                ),
              ),
              Type.Object(
                {
                  kind: Type.Literal("propose_addressed"),
                  findingId: Type.String(),
                  reason: Type.String(),
                },
                { additionalProperties: false },
              ),
              Type.Object(
                {
                  kind: Type.Literal("repair_check"),
                  checkId: Type.String(),
                  command: Type.Optional(
                    Type.Array(Type.String(), { minItems: 1 }),
                  ),
                  useMeaningfulTestEvaluator: Type.Optional(Type.Literal(true)),
                  reason: Type.String(),
                },
                { additionalProperties: false },
              ),
              Type.Object(
                {
                  kind: Type.Literal("add_check"),
                  check: Type.Object(
                    {
                      name: Type.String(),
                      command: Type.Array(Type.String(), { minItems: 1 }),
                      successCondition: Type.Optional(
                        Type.Array(Type.String(), { minItems: 1 }),
                      ),
                    },
                    { additionalProperties: false },
                  ),
                  reason: Type.String(),
                },
                { additionalProperties: false },
              ),
              Type.Object(
                {
                  kind: Type.Literal("diagnose"),
                  text: Type.String(),
                  signature: Type.String(),
                  reason: Type.String(),
                },
                { additionalProperties: false },
              ),
            ]),
            {
              maxItems: 64,
              description:
                "Append-only discoveries/design annotations and verification repairs. Original criteria cannot be removed. Agent claims never independently verify findings.",
            },
          ),
        ),
        checkEnvironmentInputs: Type.Optional(
          Type.Object(
            {
              files: Type.Array(Type.String()),
              variables: Type.Array(Type.String()),
              executables: Type.Array(Type.String()),
            },
            {
              additionalProperties: false,
              description:
                "Complete relevant environment inputs for pure deterministic checks. Enables reuse only when source/index/HEAD, all definitions and measured inputs match. Omit when ambient state cannot be measured. Never include credentials.",
            },
          ),
        ),
        checks: Type.Optional(
          Type.Array(
            Type.Object(
              {
                name: Type.String({ minLength: 1, maxLength: 256 }),
                command: Type.Array(Type.String(), { minItems: 1, maxItems: 64 }),
                successCondition: Type.Optional(
                  Type.Array(Type.String(), {
                    minItems: 1,
                    maxItems: 64,
                    description:
                      "Optional evaluator executable and arguments; Conductor supplies the original exit code and complete output paths via environment variables. Exit 0 permits the next command.",
                  }),
                ),
              },
              { additionalProperties: false },
            ),
            {
              minItems: 1,
              maxItems: 64,
              description:
                "Ordered named verification commands for this task, using executable/argv arrays. Prefer targeted tests for leaves and scoped integration checks for intermediate parents. A bare full-suite command is rejected on the first attempt unless justified in broadCheckJustifications; reserve the full suite for final root verification via validate_feature. Inspect output for actual coverage. The only supported verification format.  Required on the first attempt; continuations may omit it to inherit the retained verification plan. Revise commands through structured repairs; preserve required coverage and validators.",
            },
          ),
        ),
        broadCheckJustifications: Type.Optional(
          Type.Array(
            Type.Object(
              {
                check: Type.String({
                  minLength: 1,
                  maxLength: 256,
                  description: "Exact name of a check in this plan",
                }),
                reason: Type.String({
                  minLength: 20,
                  maxLength: 2000,
                  description:
                    "Why this check must run the whole test suite, for example that the runner cannot select the necessary tests",
                }),
              },
              { additionalProperties: false },
            ),
            {
              maxItems: 64,
              description:
                "First attempt only. A check that would run an entire test suite (for example a bare cargo test, npm test, pytest, go test ./... or dotnet test) is rejected unless it is named here with the reason the whole suite is unavoidable. Narrow the check instead where the runner can select tests. Continuations inherit the retained plan and do not need this.",
            },
          ),
        ),
        reviewModel: Type.Optional(
          Type.String({
            description: "Independent review model; default opencode/gpt-6-luna",
          }),
        ),
        workflowTimeoutMs: Type.Optional(
          Type.Integer({
            minimum: 1,
            maximum: 2147483647,
            description:
              "Optional overall Conductor workflow deadline in milliseconds, covering execution, formatting, checks and review. " +
              "Defaults to 30 minutes. Maximum 2147483647 ms (~24.8 days). Independent of all review budgets.",
          }),
        ),
        reviewWallClockBudgetSecs: Type.Optional(
          Type.Integer({
            description:
              "Optional review wall-clock budget in seconds " +
              "(forwards to review-cli --wall-clock-budget-secs). Defaults to 180 seconds.",
          }),
        ),
        reviewMaxTurns: Type.Optional(
          Type.Integer({
            description:
              "Optional maximum model turns for review " +
              "(forwards to review-cli --max-turns). Defaults to 20 turns.",
          }),
        ),
        reviewMaxCostUsd: Type.Optional(
          Type.Number({
            description:
              "Optional review cost budget in USD " +
              "(forwards to review-cli --max-cost-usd). Omit for no cost cap.",
          }),
        ),
        reviewMaxToolCalls: Type.Optional(
          Type.Integer({
            description:
              "Optional maximum tool calls for review " +
              "(forwards to review-cli --max-tool-calls). Omit to use the review engine default.",
          }),
        ),
        reviewMaxRepeatedActions: Type.Optional(
          Type.Integer({
            description:
              "Optional maximum identical repeated tool calls before stalling " +
              "(forwards to review-cli --max-repeated-actions). Omit to use the review engine default.",
          }),
        ),
        reviewMaxCompletionAttempts: Type.Optional(
          Type.Integer({
            description:
              "Optional maximum completion attempts before stopping " +
              "(forwards to review-cli --max-completion-attempts). Omit to use the review engine default.",
          }),
        ),
        reviewResume: Type.Optional(
          Type.Boolean({
            description:
              "Continue the previous attempt's independent review from where it stopped instead of reviewing from scratch. " +
              "Use after a review stopped on a limit (LIMIT_EXCEEDED, BUDGET_EXHAUSTED, CANCELLED) when it was making progress: " +
              "supply previousAttempt, empty operations and a higher reviewMaxToolCalls / reviewMaxTurns. " +
              "Review limits are cumulative across the resumed attempts, so a raised limit grants exactly the extra headroom. " +
              "Refused unless the previous attempt retained a resumable review checkpoint and no source operations are applied.",
          }),
        ),
      }),
      async execute(params, host) {
        const scaffoldBefore = scaffoldCliUsage();
        const startedAt = Date.now();
        const result = await executeAndCheckpoint(
          params,
          {
            directory: host.cwd,
            abort: host.signal,
          },
          { issueWorkflowOnly: true },
        );
        return toolResult(
          {
            ...result,
            // Telemetry for this call only; the model-facing text is unchanged.
            telemetry: {
              wall_ms: Date.now() - startedAt,
              scaffold_cli: combineScaffoldUsage(
                scaffoldCliUsageSince(scaffoldBefore),
                result?.telemetry?.finalization_scaffold_cli,
              ),
            },
          },
          { isError: result.status === "BLOCKED", text: executionSummary(result) },
        );
      },
    })),
    withFailureReporting(defineTool({
      name: "abandon_inflight_attempt",
      label: "Close an interrupted invocation",
      description:
        "Escape hatch for INVOCATION_RECOVERY_REQUIRED when the original process died (killed session, lost connection) and no terminal receipt exists. Writes an authenticated INTERRUPTED terminal receipt for the in-flight attempt: the attempt stays consumed, the applied source and history are retained, nothing is verified and no operations are replayed. Returns the receipt to use as previousAttempt with empty operations. Refused while the invocation may still be running unless force is set. There is no dialog: set force or restore only after the user has said in chat that the process tree is gone (force) or that the working tree may be reset (restore).",
      parameters: Type.Object(
        {
          task: Type.Object(
            { featureId: Type.String(), taskId: Type.String(), designRef: Type.String() },
            { additionalProperties: false },
          ),
          reason: Type.String({ minLength: 1, description: "Why the invocation is believed dead, e.g. observed connection loss" }),
          restore: Type.Optional(Type.Literal("checkpoint", { description: "Also reset the working tree to the task's base commit after saving the interrupted tree to a recovery ref. Requires the user's explicit confirmation in chat first. Omit to keep the files as found." })),
          force: Type.Optional(Type.Boolean({ description: "Skip the liveness allowance after the user confirms in chat that no process is running" })),
        },
        { additionalProperties: false },
      ),
      async execute(params, host) {
        const result = await abandonInflightAttempt(params, { directory: host.cwd, abort: host.signal });
        return toolResult(result, { isError: result.status === "BLOCKED" && !result.evidence });
      },
    })),
    withFailureReporting(defineTool({
      name: "reconcile_external_changes",
      label: "Record outside changes to the working tree",
      description:
        "Use when CONTINUATION_RECEIPT_INAPPLICABLE or a stale handoff says the working tree no longer matches the latest receipt because someone other than the executor changed files (a manual removal the review asked for, a formatter, a teammate's edit). There is no dialog: first show the user the changed paths in chat and call this only after they confirm; then it writes an authenticated BLOCKED receipt that starts at the previous receipt's tree and ends at the current one. It consumes one attempt, verifies nothing, replays nothing and never touches source; the next attempt re-runs every check and the independent review. Returns the receipt to use as previousAttempt. Not for new commits (inspect_feature_drift) or an in-flight invocation (abandon_inflight_attempt).",
      parameters: Type.Object(
        {
          task: Type.Object(
            { featureId: Type.String(), taskId: Type.String(), designRef: Type.String() },
            { additionalProperties: false },
          ),
          previousAttempt: Type.String({ description: "The task's latest receipt reference (inspect_issue_attempt)" }),
          reason: Type.String({ minLength: 1, description: "What changed and why, e.g. user removed the stray archive requested by review" }),
        },
        { additionalProperties: false },
      ),
      async execute(params, host) {
        const result = await reconcileExternalChanges(params, { directory: host.cwd, abort: host.signal },
          // The user's yes in the conversation is the approval; no dialog.
          { deps: { confirm: async () => true } });
        return toolResult(result, { isError: result.status === "BLOCKED" && !result.evidence });
      },
    })),
    withFailureReporting(defineTool({
      name: "inspect_conductor_evidence",
      label: "Inspect retained Conductor evidence",
      description:
        "Read a content-addressed task receipt and compare its tree fingerprint. No writes or lifecycle transitions. Inspect check/review output before completing a task.",
      parameters: Type.Object({ reference: Type.String() }),
      async execute(params, host) {
        return toolResult(await inspectEvidence(params.reference, { directory: host.cwd }));
      },
    })),
  ];
}
