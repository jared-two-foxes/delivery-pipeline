/** Native task persistence only. Pi reasons; Scaffold validates; Conductor executes. */
import { scaffoldTasks } from "./adapter.mjs";
import { authenticateIssueMutation } from "../../lib/verification/issue-mutation.mjs";
import { compactMutation } from "./compact-mutation.mjs";
import { defineTool, toolResult, withFailureReporting } from "../../lib/host/tool.mjs";

/** Host-neutral tools. `Type` is a TypeBox-style schema builder supplied by the host adapter. */
const designMutations = new Set(["init", "add", "decompose", "design-record", "design-reopen", "design-revise", "design-finish"]);
// After a design-phase mutation, report what is still unmapped so the agent can fix it before
// design-finish. A failed follow-up query never hides the mutation's success, and never reads
// as "fully mapped": it is reported with its diagnostic and a retry query.
export async function designCoverage(params, result, cwd, options = {}) {
  if (!result.ok || !designMutations.has(params.operation) || params.operation === "design-finish") return undefined;
  const retry = { operation: "requirements", feature_id: params.feature_id, payload: { unmapped: true } };
  let query;
  try {
    query = await scaffoldTasks(retry, { directory: cwd.directory, abort: cwd.abort }, options);
  } catch (error) {
    query = { ok: false, reason: "EXECUTION_ERROR", message: error.message };
  }
  return query.ok ? query.data : { error: { reason: query.reason, message: query.message }, retry };
}

export function createScaffoldTools(Type) {
  const text = () => Type.String({ minLength: 1 });
  const common = {
    id: text(), title: text(), objective: text(),
    context: Type.Optional(Type.String()),
    constraints: Type.Optional(Type.Array(text())),
  };
  // Feature requirements: stable author-chosen ids with their text and provenance; never positional.
  const requirement = Type.Object({
    id: Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$", description: "Stable id from the ticket or user (for example SA-663.AC1); never a list position" }),
    text: text(), source: Type.Optional(text()),
  }, { additionalProperties: false });
  const requirements = Type.Array(requirement, { minItems: 1 });
  const link = Type.Object({ id: text(), roles: Type.Array(Type.Union([Type.Literal("contribute"), Type.Literal("verify")]), { minItems: 1, uniqueItems: true }) }, { additionalProperties: false });
  const task = Type.Object({ ...common,
    acceptance_criteria: Type.Array(text(), { minItems: 1, description: "Task-local criteria, preserved as written" }),
    requirements: Type.Optional(Type.Array(link, { minItems: 1, description: "Requirements this task contributes to and/or verifies" })),
    requirements_rationale: Type.Optional(text()),
    origin: Type.Optional(Type.Object({ kind: Type.Union(["ticket", "design", "review", "discovery"].map(v => Type.Literal(v))), reference: text() }, { additionalProperties: false })),
    dependencies: Type.Optional(Type.Array(text(), { uniqueItems: true })),
  }, { additionalProperties: false });
  const feature = Type.Object({ ...common, requirements, design_ref: text(), baseline: text(), branch: text() }, { additionalProperties: false });
  const evidence = Type.Object({
    feature_id: text(), task_id: text(), result: Type.Literal("PASSED"),
    source: text(), reference: text(), summary: text(),
  }, { additionalProperties: false });
  // Keep the tool schema an object for Pi/provider function-tool compatibility.
  // The adapter enforces operation-specific required/forbidden fields as well.
  const parameters = Type.Object({
    operation: Type.Union((["init", "add", "list", "start", "complete", "block", "fail", "retry", "decompose", "design-record", "design-finish", "design-reopen", "design-revise", "checkpoint-record", "issue-resume", "summary", "issue", "select", "design-select", "requirements"]).map(value => Type.Literal(value))),
    feature_id: text(),
    task_id: Type.Optional(text()),
    payload: Type.Optional(Type.Union([feature, Type.Array(task, { minItems: 1 }), evidence,
      Type.Object({ summary: text(), verification: text(), approval: text(), disposition: Type.Union([Type.Literal("leaf"), Type.Literal("decomposed")]) }, { additionalProperties: false }),
      Type.Object({ context: text(), title: Type.Optional(text()), objective: Type.Optional(text()), requirements: Type.Optional(requirements), constraints: Type.Optional(Type.Array(text())) }, { additionalProperties: false }),
      Type.Object({ ids: Type.Optional(Type.Array(text(), { minItems: 1 })), unmapped: Type.Optional(Type.Boolean()) }, { additionalProperties: false }),
      Type.Object({ reason: text(), reference: Type.Optional(text()) }, { additionalProperties: false }),
      Type.Object({ commit: text(), parent: text(), tree: text(), reference: text() }, { additionalProperties: false }),
      Type.Object({ reference: text(), handoff: text() }, { additionalProperties: false })])),
    reason: Type.Optional(text()),
  }, { additionalProperties: false });

  return [
    withFailureReporting(defineTool({
      name: "scaffold_tasks",
      label: "Scaffold Issues",
      description: "Perform ONE explicit Scaffold task lifecycle operation in the current repository. " +
        "Persists task state only; never implements, verifies, invokes Conductor or automatically advances work. " +
        "Completion records externally obtained task-bound PASSED evidence; Scaffold does not authenticate it. " +
        "Use summary for phase/counts/coverage; issue for one scoped context (stable requirement ids, text and roles); select/design-select for eligible scoped work; " +
        "requirements (optional payload {ids, unmapped}) for per-requirement contributors, verifiers and missing coverage. list is an explicit full-state diagnostic. Null selection never implies completion. " +
        "Tasks carry requirements [{id, roles:[contribute|verify]}] or a requirements_rationale; design-finish refuses until every requirement has a leaf contributor and an ordered verifier.",
      parameters,
      async execute(params, host) {
        const result = await scaffoldTasks(params, { directory: host.cwd, abort: host.signal }, {
          authorizeIssueMutation: authenticateIssueMutation,
        });
        const compact = compactMutation(result, await designCoverage(params, result, { directory: host.cwd, abort: host.signal }));
        return toolResult(compact, { isError: !result.ok });
      },
    })),
  ];
}
