// Explicit recovery: re-record requirement evidence that went stale only because a requirement's contributor
// or verifier set changed (typically a corrective task). The final gates never do this themselves; they block
// on stale coverage and name this tool.
import path from "node:path";
import { git } from "../../lib/git/tree.mjs";
import { authenticateTaskEvidence } from "../../lib/verification/task-evidence.mjs";
import { requireFeatureAuthorization } from "../scaffold/feature-authorization.mjs";
import { scaffoldTasks } from "../scaffold/adapter.mjs";
import { rebindRequirementEvidence } from "../checkpoint/requirement-evidence.mjs";

const requireValue = (ok, message) => { if (!ok) throw new Error(message); };
const result = (fields) => ({ schema: "pi.requirement-rebinding/v1", ...fields });

export async function rebindFeatureRequirementEvidence(args, context = {}, options = {}) {
  try {
    requireValue(typeof args?.featureId === "string" && args.featureId.trim() &&
      typeof args.designRef === "string" && args.designRef.trim(), "featureId and designRef are required");
    const repository = path.resolve(git(context.directory, ["rev-parse", "--show-toplevel"]));
    // Recording evidence is within the retained feature authority (the same scope as task checkpoints).
    await requireFeatureAuthorization({ featureId: args.featureId, designRef: args.designRef }, { ...context, directory: repository }, options);
    const listed = await scaffoldTasks({ operation: "list", feature_id: args.featureId }, { directory: repository }, options.scaffoldOptions);
    requireValue(listed.ok, "Cannot inspect Scaffold: " + listed.message);
    requireValue(listed.data.feature.workflow.phase === "implement", "Finish issue graph design before re-binding evidence");
    const outcome = await rebindRequirementEvidence(repository, args.featureId, options.authenticate ?? authenticateTaskEvidence, options);
    const view = await scaffoldTasks({ operation: "requirements", feature_id: args.featureId }, { directory: repository }, options.scaffoldOptions);
    requireValue(view.ok, "Cannot read requirement coverage: " + view.message);
    const outstanding = view.data.requirements.filter((r) => r.evidence?.status !== "satisfied")
      .map((r) => ({ requirement: r.id, status: r.evidence?.status ?? "missing" }));
    return result({ ok: true, ...outcome, outstanding });
  } catch (error) {
    return result({ ok: false, message: error.message });
  }
}
