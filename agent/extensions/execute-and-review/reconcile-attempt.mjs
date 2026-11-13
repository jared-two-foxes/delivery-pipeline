// Re-entry after someone other than the executor changed the working tree since the latest receipt (a manual
// deletion requested by review, a formatter, a teammate's edit). Every continuation requires the tree to equal the
// previous receipt's after-snapshot, so such a change strands the task. This records the change instead of
// refusing it: an authenticated BLOCKED receipt that starts at the previous receipt's after-snapshot and ends at the
// current tree, naming the changed paths and the user's confirmation. The reconciliation consumes one attempt.
// Nothing is verified here: the next attempt re-runs every check and the independent review on the current tree,
// and a checkpoint still commits only a tree that passed them. Source is never touched.
import path from "node:path";
import { isDeepStrictEqual as equal } from "node:util";
import { git } from "../../lib/git/tree.mjs";
import { snapshot } from "../../lib/git/snapshot.mjs";
import { readEvidence, retainEvidence } from "../../lib/evidence/store.mjs";
import { retainAttempt } from "../../lib/evidence/attempts.mjs";
import { authenticateAttemptChain, assertLatestAttempt } from "../../lib/verification/attempt-chain.mjs";
import { requireFeatureAuthorization } from "../scaffold/feature-authorization.mjs";
import { issueFeature } from "../scaffold/adapter.mjs";
import { deliveryEvent } from "./delivery-context.mjs";
import { renderContext } from "../../lib/delivery-state/delivery-context.mjs";

const MAX_LISTED = 200;
const blocked = (reason, message, extra = {}) => ({
  schema: "pi.execute-and-review.result/v1", status: "BLOCKED", stage: "RECOVERY", reason, message, ...extra,
});

/** Paths that differ between two implementation trees, e.g. `D\t.scaffold.zip`. Null when a tree is unreadable. */
export function changedPaths(repository, fromTree, toTree, run = git) {
  try {
    const lines = run(repository, ["diff-tree", "-r", "--name-status", "--no-renames", fromTree, toTree])
      .split("\n").filter(Boolean);
    return { total: lines.length, paths: lines.slice(0, MAX_LISTED) };
  } catch {
    return null;
  }
}

/**
 * params: { task, previousAttempt, reason }. `confirm(summary)` must obtain the user's explicit approval; the
 * tool wrapper supplies it. options.deps may replace any collaborator (tests).
 */
export async function reconcileExternalChanges(params, context = {}, options = {}) {
  const d = {
    git, snapshot, readEvidence, retainEvidence, retainAttempt, deliveryEvent, issueFeature, authenticateAttemptChain,
    assertLatestAttempt, requireFeatureAuthorization, changedPaths, confirm: async () => false, ...options.deps,
  };
  try {
    const { task, previousAttempt } = params;
    if (!task?.featureId || !task?.taskId || !task?.designRef || !previousAttempt || !params.reason?.trim())
      return blocked("INVALID_ARGUMENTS", "task {featureId, taskId, designRef}, previousAttempt and a reason are required");
    const repository = path.resolve(d.git(context.directory ?? ".", ["rev-parse", "--show-toplevel"]).trim());
    await d.requireFeatureAuthorization({ task }, context, options);
    const found = await d.issueFeature(repository, task, options);
    const issue = found?.tasks?.[task.taskId];
    const journal = issue?.delivery;
    if (!journal)
      return blocked("NOT_STARTED", "No delivery journal exists for this task; there is no receipt to reconcile from.");
    if (journal.inflight)
      return blocked("INVOCATION_RECOVERY_REQUIRED", "An invocation is still in flight for this task; close it with abandon_inflight_attempt first.");
    if (journal.head !== previousAttempt)
      return blocked("CONTINUATION_RECEIPT_STALE", "previousAttempt is not the task's latest receipt (" + journal.head + "); use that one.");

    const chain = await d.authenticateAttemptChain(repository, previousAttempt, task);
    const previous = chain.record;
    await d.assertLatestAttempt(repository, previousAttempt, task, previous.attempt);
    if (previous.result.status === "PASSED")
      return blocked("CONTINUATION_RECEIPT_INAPPLICABLE", "The latest attempt PASSED; finish its checkpoint instead of reconciling.");

    if (previous.kind === "issue-zero-handoff")
      return blocked("UNSUPPORTED_ZERO_ATTEMPT", "No attempt has run since this handoff and it carries no verification plan to continue from. Restore the tree to the handoff state, or suspend and resume the issue.");
    const before = await d.snapshot(repository);
    if (before.bookkeepingVisible)
      return blocked("SCAFFOLD_REVIEW_SCOPE", "Scaffold state is visible in the working tree; establish an authorised ignore rule first.");
    // A HEAD_CHANGED receipt ends at a different HEAD than its baseline; the chain cannot continue from it.
    if (before.head !== previous.after.head || previous.after.head !== previous.args.baseRef)
      return blocked("HEAD_CHANGED", "HEAD differs from the receipt's ending HEAD or its baseline. Reconciling covers working-tree changes only; if someone committed, use inspect_feature_drift.");
    if (before.digest === previous.after.digest && before.tree === previous.after.tree)
      return blocked("NOTHING_TO_RECONCILE", "The working tree already matches the latest receipt; continue with it as previousAttempt.");

    const changes = d.changedPaths(repository, previous.after.tree, before.tree);
    const listing = changes
      ? changes.paths.join("\n") + (changes.total > changes.paths.length ? "\n… and " + (changes.total - changes.paths.length) + " more" : "")
      : "(the retained tree is no longer readable; the files differ by digest only)";
    const approved = await d.confirm({
      title: "Record outside changes to the working tree?",
      message: "Changes since attempt " + previous.attempt + " (" + params.reason.trim() + "):\n" + listing + "\n\n" +
        "This uses attempt " + (previous.attempt + 1) + ". Nothing is marked verified; the next attempt re-runs all checks and the review on this tree.",
    });
    if (!approved) return blocked("CANCELLED", "Not confirmed; nothing changed.");
    // The tree must not move between the preview and the write.
    const again = await d.snapshot(repository);
    if (!equal(again, before)) return blocked("REPOSITORY_CHANGED", "The working tree changed during confirmation; rerun.");

    const attempt = previous.attempt + 1;
    const instanceId = found.workflow?.instance_id;
    const scoped = { ...options, featureInstanceId: instanceId };
    const args = { ...previous.args, previousAttempt, contextUpdates: [] };
    delete args.input;
    // A handoff's requirements carry recovery text that is not the rendered context; the next attempt renders afresh.
    if (args.deliveryContext) args.requirements = renderContext(args.deliveryContext);
    const started = await d.retainEvidence(repository, {
      repository, ...(instanceId ? { featureInstanceId: instanceId } : {}), task, attempt, args,
      // Same boundaries as the terminal receipt, so abandoning an interrupted reconciliation still chains.
      before: previous.after, after: before,
      result: { schema: "pi.execute-and-review.result/v1", status: "BLOCKED", stage: "STARTED", reason: "INTERRUPTED_OR_RUNNING" },
    });
    let current = await d.deliveryEvent(repository, task, journal,
      { kind: "begun", reference: started, previous: previousAttempt, sequence: attempt }, scoped);
    const record = {
      repository, ...(instanceId ? { featureInstanceId: instanceId } : {}), task, attempt, args,
      // Chain rule: a correction starts exactly where its predecessor ended; the outside change is the delta.
      before: previous.after, after: before, startedReference: started,
      result: {
        schema: "pi.execute-and-review.result/v1", status: "BLOCKED", stage: "EVIDENCE", reason: "EXTERNAL_CHANGES_RECONCILED",
        message: "Outside changes were recorded: " + params.reason.trim() + ". Nothing was verified; continue to re-run checks and review.",
        external: { reason: params.reason.trim(), from: previous.after, to: before, changes: changes ?? null, confirmed: true },
      },
    };
    const reference = await d.retainAttempt(repository, record);
    current = await d.deliveryEvent(repository, task, current, { kind: "finished", started, reference }, scoped);
    return {
      schema: "pi.execute-and-review.result/v1", status: "BLOCKED", stage: "RECOVERY", reason: "EXTERNAL_CHANGES_RECONCILED",
      evidence: { reference, task, attempt }, changes: changes ?? null,
      message: "Outside changes recorded as attempt " + attempt + ". Continue with previousAttempt = " + reference +
        " and {\"operations\":[]} (or corrections authored against the current tree) to run the checks and review.",
    };
  } catch (error) {
    return blocked("RECONCILE_FAILED", error.message);
  }
}
