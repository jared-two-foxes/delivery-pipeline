import { featureAuthorized } from "../scaffold/feature-authorization.mjs";
import { validateFeature, runFeatureChecks, inspectFeatureValidation } from "./feature.mjs";
import { acceptFeature } from "./acceptance.mjs";
import { NOTE_LIMIT } from "../../lib/verification/acceptance.mjs";
import { defineTool, toolResult, withApprovalReason, withFailureReporting } from "../../lib/host/tool.mjs";

// Validation binds to the ledger's movable `base` (moved by a rebase). The authorization check compares the
// immutable original baseline instead, so it is not given the validation base.
const withoutValidationBase = ({ featureBaseRef: _validationBase, ...rest }) => rest;

/** Host-neutral tools. `Type` is a TypeBox-style schema builder supplied by the host adapter. */
export function createFeatureValidationTools(Type) {
  return [
    withFailureReporting(defineTool({
      name: "validate_feature",
      label: "Validate complete feature",
      description:
        "Verification-only final gate: authenticate all task checkpoints, run approved full-project checks, independently review the original baseline through final HEAD, retain evidence and record Scaffold validation. Uses the retained overall feature authorization. No implementation, commits, publishing, retries or task selection.",
      parameters: Type.Object({
        featureId: Type.String(),
        designRef: Type.String(),
        branch: Type.String(),
        featureBaseRef: Type.String(),
        headRef: Type.String(),
        buildCommand: Type.Array(Type.String(), { minItems: 1 }),
        testCommand: Type.Array(Type.String(), { minItems: 1 }),
        testSuccessPattern: Type.String({
          description:
            "Approved literal output marker demonstrating meaningful tests ran, e.g. '42 passed'. Never choose a generic exit message.",
        }),
        integrationChecks: Type.Optional(
          Type.Array(
            Type.Object({
              name: Type.String(),
              command: Type.Array(Type.String(), { minItems: 1 }),
              successPattern: Type.String(),
            }),
          ),
        ),
        checkTimeoutMs: Type.Optional(Type.Integer()),
        review: Type.Optional(
          Type.Object({
            model: Type.Optional(Type.String()),
            wallClockBudgetSecs: Type.Optional(Type.Integer()),
            maxTurns: Type.Optional(Type.Integer()),
            maxCostUsd: Type.Optional(Type.Number()),
            maxToolCalls: Type.Optional(Type.Integer()),
            maxRepeatedActions: Type.Optional(Type.Integer()),
            maxCompletionAttempts: Type.Optional(Type.Integer()),
          }),
        ),
        resumeEvidenceRef: Type.Optional(
          Type.String({
            description:
              "Authentic retained successful feature receipt to reconcile with Scaffold; unchanged revision and plan required",
          }),
        ),
      }),
      async execute(params, host) {
        const result = await validateFeature(
          params,
          { directory: host.cwd, abort: host.signal },
          {
            authorize: async () =>
              featureAuthorized(withoutValidationBase(params), { directory: host.cwd, abort: host.signal }),
          },
        );
        return toolResult(result, { isError: result.status === "BLOCKED" });
      },
    })),
    withFailureReporting(defineTool({
      name: "run_feature_checks",
      label: "Run final feature checks",
      description:
        "Mechanical final gate: authenticate all task checkpoints, then run the approved full-project build, test and integration checks and require meaningful output. No agent review. Records the result in Scaffold as a checks-only result (PASSED makes the feature `checked`, never `verified`) and retains its own evidence; a feature already `verified` at this head is left unchanged. Uses the retained overall feature authorization. No implementation, commits, publishing, retries or task selection.",
      parameters: Type.Object({
        featureId: Type.String(),
        designRef: Type.String(),
        branch: Type.String(),
        featureBaseRef: Type.String(),
        headRef: Type.String(),
        buildCommand: Type.Array(Type.String(), { minItems: 1 }),
        testCommand: Type.Array(Type.String(), { minItems: 1 }),
        testSuccessPattern: Type.String({
          description:
            "Approved literal output marker demonstrating meaningful tests ran, e.g. '42 passed'. Never choose a generic exit message.",
        }),
        integrationChecks: Type.Optional(
          Type.Array(
            Type.Object({
              name: Type.String(),
              command: Type.Array(Type.String(), { minItems: 1 }),
              successPattern: Type.String(),
            }),
          ),
        ),
        checkTimeoutMs: Type.Optional(Type.Integer()),
      }),
      async execute(params, host) {
        const result = await runFeatureChecks(
          params,
          { directory: host.cwd, abort: host.signal },
          {
            authorize: async () =>
              featureAuthorized(withoutValidationBase(params), { directory: host.cwd, abort: host.signal }),
          },
        );
        return toolResult(result, { isError: result.status === "BLOCKED" });
      },
    })),
    withFailureReporting(defineTool({
      name: "accept_feature",
      interactive: true,
      label: "Accept the finished feature",
      description:
        "Record the user's sign-off that a finished feature is complete, on the feature's CURRENT checked or verified result (see scaffold_tasks summary validation_status). Call it ONLY when the user explicitly asks to mark the feature accepted or complete, typically after they reviewed it and merged; never on your own initiative and never from delivery workflows. Name the exact head (the validated head from run_feature_checks or scaffold_tasks); it shows the user a short Yes/No confirmation of exactly what is being accepted. Judged from the Scaffold ledger alone, so it works after the user merged and switched branches. Records `accepted`, which ends automatically at any later task-graph or history change, invalidation or new validation attempt. Idempotent. Grants nothing else: it does not publish, merge, or change the feature.",
      parameters: Type.Object(
        {
          featureId: Type.String(),
          headRef: Type.String({ description: "The validated head being accepted (full SHA), as reported by run_feature_checks binding.head" }),
          note: Type.Optional(Type.String({ maxLength: NOTE_LIMIT, description: "Optional free text, for example the merged PR reference" })),
        },
        { additionalProperties: false },
      ),
      async execute(params, host) {
        const result = await acceptFeature(
          params,
          { directory: host.cwd, abort: host.signal },
          {
            confirm: async (scope) =>
              host.confirm(
                "Accept feature " + scope.featureId + " at " + scope.head.slice(0, 12) + "?",
                "Branch: " + scope.branch + "\n" +
                  (scope.title ? "Feature: " + scope.title + "\n" : "") +
                  "Result being accepted: " + scope.fromStatus + (scope.resultKind === "checks-only"
                    ? " (the full build and tests passed; no independent review of the whole feature was performed)"
                    : " (reviewed independently)") + "\n" +
                  "Checks: " + (scope.checks.map((c) => c.name + (c.exit_code === 0 && c.meaningful ? " passed" : " NOT passed")).join(", ") || "none recorded") + "\n" +
                  (scope.note ? "Note: " + scope.note + "\n" : "") +
                  "\nThis records that you reviewed and accept this feature. It does not publish, merge or change anything, and it stops applying if the task graph or history changes or the feature is validated again.",
              ),
          },
        );
        return toolResult(withApprovalReason(host, result), { indent: 0, isError: result.ok === false });
      },
    })),
    withFailureReporting(defineTool({
      name: "inspect_feature_validation",
      label: "Inspect retained feature validation",
      description:
        "Read retained feature attempts and authenticate their applicability against current Git, task graph and checkpoint evidence. Historical PASSED may be stale. No checks, reviews or lifecycle writes.",
      parameters: Type.Object({
        featureId: Type.Optional(Type.String()),
        reference: Type.Optional(Type.String()),
      }),
      async execute(params, host) {
        return toolResult(await inspectFeatureValidation(params, { directory: host.cwd }));
      },
    })),
  ];
}
