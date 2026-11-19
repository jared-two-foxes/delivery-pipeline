// Re-entry for an invocation that never produced a terminal receipt (killed process, lost connection,
// crashed host). The journal still holds `inflight`, so every continuation is refused. This closes that
// intent with an authenticated INTERRUPTED terminal receipt: the attempt stays consumed, the applied
// tree and history are retained, and nothing is asserted as verified. Source is never touched and
// operations are never replayed. The result is an ordinary previousAttempt for the next invocation.
import path from "node:path";
import { isDeepStrictEqual as equal } from "node:util";
import { git } from "../../lib/git/tree.mjs";
import { snapshot } from "../../lib/git/snapshot.mjs";
import { readEvidence } from "../../lib/evidence/store.mjs";
import { retainAttempt, taskReceipts } from "../../lib/evidence/attempts.mjs";
import { DEFAULT_TIMEOUT_MS } from "../../lib/conductor/client.mjs";
import { restoreCheckpoint } from "../../lib/git/checkpoint-restore.mjs";
import { liveLocks } from "../../lib/verification/terminal-lock.mjs";
import { requireFeatureAuthorization } from "../scaffold/feature-authorization.mjs";
import { issueFeature } from "../scaffold/adapter.mjs";
import { deliveryEvent } from "./delivery-context.mjs";

const GRACE_MS = 5 * 60 * 1000;
const blocked = (reason, message, extra = {}) => ({
  schema: "pi.execute-and-review.result/v1", status: "BLOCKED", stage: "RECOVERY", reason, message, ...extra,
});

/**
 * params: { task, reason, force?, restore? }. restore: "checkpoint" saves the dirty tree to a ref and resets to the
 * task base (the caller must have obtained explicit confirmation); default keeps the files as found.
 * `force` is the user's statement that the original process is gone;
 * the caller must have obtained explicit confirmation before passing it (see the tool).
 * options.deps may replace any collaborator (tests).
 */
export async function abandonInflightAttempt(params, context = {}, options = {}) {
  const d = {
    git, snapshot, readEvidence, retainAttempt, taskReceipts, deliveryEvent, issueFeature,
    requireFeatureAuthorization, liveLocks, restoreCheckpoint, now: Date.now, ...options.deps,
  };
  try {
    const { task } = params;
    if (!task?.featureId || !task?.taskId || !task?.designRef || !params.reason?.trim())
      return blocked("INVALID_ARGUMENTS", "task {featureId, taskId, designRef} and a reason are required");
    const repository = path.resolve(d.git(context.directory ?? ".", ["rev-parse", "--show-toplevel"]).trim());
    await d.requireFeatureAuthorization({ task }, context, options);
    const found = await d.issueFeature(repository, task, options);
    const issue = found?.tasks?.[task.taskId];
    const journal = issue?.delivery;
    if (!journal?.inflight)
      return blocked("NOTHING_IN_FLIGHT", "No invocation is in flight for this task; continue from its latest receipt (inspect_issue_attempt).");
    const instanceId = found.workflow?.instance_id;
    const scoped = { ...options, featureInstanceId: instanceId };

    const started = await d.readEvidence(repository, journal.inflight, { featureId: task.featureId });
    if (!equal(started.task, task) || started.result?.stage !== "STARTED")
      return blocked("EVIDENCE_RECOVERY_REQUIRED", "The in-flight reference is not this task's retained start receipt.");

    // A terminal receipt may exist already (lost response): the normal continuation reconciles it.
    const terminal = (await d.taskReceipts(repository, task, options))
      .filter(({ record }) => record.startedReference === journal.inflight);
    if (terminal.length)
      return blocked("TERMINAL_RECEIPT_EXISTS",
        "A terminal receipt exists for this invocation; continue with previousAttempt = " + terminal.at(-1).reference + ".",
        { reference: terminal.at(-1).reference });

    // Liveness: refuse while the owner may still be running, unless the user declared it gone.
    const startedMs = Date.parse(started.recordedAt) || 0;
    const timeout = (started.args?.workflowTimeoutMs ?? DEFAULT_TIMEOUT_MS) + GRACE_MS;
    const age = d.now() - startedMs;
    const live = await d.liveLocks(path.join(repository, ".scaffold", "work", "runs"), startedMs);
    if (!params.force && (live.length || age < timeout))
      return blocked("INVOCATION_MAY_BE_RUNNING",
        live.length
          ? "A process named by a terminal.lock is still alive (pid " + live.map((l) => l.pid).join(", ") + "); let it finish."
          : "The invocation started " + Math.round(age / 1000) + "s ago, within its " + Math.round(timeout / 1000) +
            "s allowance. Wait, or pass force after confirming its process tree is gone.",
        { retryAfterMs: Math.max(0, timeout - age) });

    let saved = null;
    if (params.restore !== undefined && params.restore !== "checkpoint")
      return blocked("INVALID_ARGUMENTS", "restore must be \"checkpoint\" when supplied");
    if (params.restore === "checkpoint") {
      if (!started.args?.baseRef) return blocked("RESTORE_UNSAFE", "The start receipt has no base commit to restore to.");
      try {
        saved = await d.restoreCheckpoint(repository, started.args.baseRef,
          "refs/pi-delivery-recovery/" + task.featureId + "/" + task.taskId + "/attempt-" + started.attempt);
      } catch (error) {
        return blocked(error.code === "RESTORE_UNSAFE" ? "RESTORE_UNSAFE" : "ABANDON_FAILED", error.message);
      }
    }
    const after = await d.snapshot(repository);
    const record = {
      repository,
      ...(instanceId ? { featureInstanceId: instanceId } : {}),
      task, attempt: started.attempt, args: started.args,
      before: started.before, after,
      startedReference: journal.inflight,
      result: {
        schema: "pi.execute-and-review.result/v1",
        status: "BLOCKED", stage: "EVIDENCE", reason: "INVOCATION_ABANDONED",
        message: "Invocation closed without a terminal receipt: " + params.reason.trim() +
          ". Source was preserved as found; no check or review was verified.",
        abandoned: { started: journal.inflight, forced: Boolean(params.force), liveOwners: live.length, ageMs: age,
          ...(saved ? { restoredTo: started.args.baseRef, savedWorkingTree: saved } : {}) },
      },
    };
    const reference = await d.retainAttempt(repository, record);
    await d.deliveryEvent(repository, task, journal,
      { kind: "finished", started: journal.inflight, reference }, scoped);
    return {
      schema: "pi.execute-and-review.result/v1", status: "BLOCKED", stage: "RECOVERY",
      reason: "INVOCATION_ABANDONED", evidence: { reference, task, attempt: started.attempt },
      ...(saved ? { savedWorkingTree: saved } : {}),
      message: "Attempt " + started.attempt + " is closed as interrupted and remains consumed. " + (saved
        ? "The working tree was reset to " + started.args.baseRef + "; the interrupted tree is saved at " + saved.ref +
          ". Continue with previousAttempt = " + reference + " and author the operations again."
        : "Continue with previousAttempt = " + reference + " and {\"operations\":[]} to run the checks and review against the retained tree."),
    };
  } catch (error) {
    return blocked("ABANDON_FAILED", error.message);
  }
}
