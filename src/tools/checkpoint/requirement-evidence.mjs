// Requirement evidence for a task's completing attempt, recorded in Scaffold before `complete`.
//
// Scaffold refuses `complete` until the completing attempt has an association for every requirement role
// the task holds. Pi authenticates the receipt first (checks, APPROVED review, attempt chain); this module
// then turns the review's explicit per-requirement assessments into those associations. It never invents
// a result: a requirement the review did not verify blocks, and a mapping that changed after the review
// blocks rather than being re-bound to evidence that assessed a different scope.
import { isDeepStrictEqual as equal } from "node:util";
import { scaffoldTasks } from "../scaffold/adapter.mjs";
import { scopedRequirements } from "../execute-and-review/delivery-context.mjs";
import {
  requiredRequirements,
  requirementObligationId,
  requirementBinding,
  unverifiedRequirements,
  describeUnverifiedRequirements,
} from "../../lib/verification/requirements.mjs";

const requireValue = (ok, message) => { if (!ok) throw new Error(message); };

async function scaffold(repository, params, options) {
  const response = await scaffoldTasks(params, { directory: repository }, options.scaffoldOptions);
  requireValue(response.ok, "Scaffold " + params.operation + " failed: " + response.message +
    (response.stderr ? " " + String(response.stderr).slice(0, 2000) : ""));
  return response.data;
}

/**
 * The associations the completing attempt supports, without writing anything. Throws with a diagnostic
 * when the receipt's reviewed requirement scope no longer matches Scaffold's current mapping, or when the
 * review left a required requirement unverified.
 */
export async function plannedRequirementEvidence(repository, feature, record, receipt, options = {}) {
  const task = feature.tasks[record.task.taskId];
  const design = task.designs?.at(-1)?.reference;
  requireValue(design, "Requirement evidence needs the task's approved design record");
  const current = (await scopedRequirements(repository, record.task, options, { withHolders: true }))
    .filter((r) => r.roles.length > 0);
  const reviewed = requiredRequirements(record.args?.deliveryContext);
  const scope = (items) => items.map((r) => ({ id: r.requirement ?? r.id, text: r.text, roles: [...r.roles].sort() }))
    .sort((a, b) => a.id.localeCompare(b.id));
  requireValue(
    equal(scope(current), scope(reviewed)),
    "REQUIREMENT_SCOPE_CHANGED: the reviewed attempt assessed requirements " +
      JSON.stringify(scope(reviewed).map(({ id, roles }) => ({ id, roles }))) + " but Scaffold now assigns this task " +
      JSON.stringify(scope(current).map(({ id, roles }) => ({ id, roles }))) +
      ". The evidence cannot be bound to a different mapping; run the task again under the current design",
  );
  const review = record.result?.conductor?.review;
  const open = unverifiedRequirements(reviewed, review);
  requireValue(open.length === 0, describeUnverifiedRequirements(open));
  return current.flatMap((r) => {
    const assessment = review.obligation_assessments.find((a) => a.obligation_id === requirementObligationId(r.id));
    const binding = requirementBinding(r.id, r);
    return r.roles.map((role) => ({
      artifact: {
        schema: "pi.requirement-evidence/v1",
        feature_id: feature.id,
        instance_id: feature.workflow.instance_id,
        task_id: record.task.taskId,
        requirement: { id: r.id, text: r.text },
        role,
        basis: "independent-review",
        receipt,
        attempt: record.attempt,
        tree: record.after.tree,
        design,
        binding,
        review: {
          review_id: review.review_id,
          obligation_id: assessment.obligation_id,
          disposition: assessment.disposition,
          evidence: assessment.evidence,
        },
      },
      association: {
        feature_id: feature.id,
        instance_id: feature.workflow.instance_id,
        requirement: r.id,
        role,
        result: "PASSED",
        // The task gate admits a receipt only with an APPROVED independent review that verified this
        // requirement, so checks alone are never recorded here.
        basis: "independent-review",
        receipt,
        tree: record.after.tree,
        binding,
        design,
      },
    }));
  });
}

/**
 * Retain one deterministic artifact per requirement role and record its association. Replays are
 * idempotent: the same content yields the same artifact reference, which Scaffold accepts unchanged.
 */
export async function recordRequirementEvidence(repository, feature, record, receipt, options = {}) {
  const planned = await plannedRequirementEvidence(repository, feature, record, receipt, options);
  const recorded = [];
  for (const { artifact, association } of planned) {
    const { reference } = await scaffold(repository,
      { operation: "artifact-put", feature_id: feature.id, payload: artifact }, options);
    await scaffold(repository, {
      operation: "evidence-record",
      feature_id: feature.id,
      task_id: record.task.taskId,
      payload: { ...association, reference },
    }, options);
    recorded.push({ requirement: association.requirement, role: association.role, reference });
  }
  return recorded;
}

/**
 * After a recorded history rewrite, carry each applicable association onto its task's rewritten checkpoint
 * tree. The rewrite was accepted only with fresh full-project checks and an independent review of the
 * rebased result (`verification`); each equivalence retains that link. Associations already naming the
 * current tree, or already carried to it, are left alone, so a repeat is a no-op.
 */
export async function carryRequirementEvidence(repository, featureId, verification, options = {}) {
  const feature = (await scaffold(repository, { operation: "list", feature_id: featureId }, options)).feature;
  const carried = [], seen = new Set();
  for (const entry of feature.evidence ?? []) {
    // Scaffold keys an equivalence by task, requirement, role and receipt.
    const key = JSON.stringify([entry.task_id, entry.requirement, entry.role, entry.receipt]);
    if (seen.has(key)) continue;
    seen.add(key);
    const task = feature.tasks[entry.task_id];
    const completion = [...(task?.history ?? [])].reverse().find((h) => h.evidence)?.evidence?.reference;
    const tree = task?.checkpoint?.tree;
    if (task?.status !== "completed" || completion !== entry.receipt || !tree) continue;
    if (entry.tree === tree || (entry.equivalent ?? []).some((e) => e.tree === tree)) continue;
    const { reference } = await scaffold(repository, {
      operation: "artifact-put",
      feature_id: featureId,
      payload: {
        schema: "pi.requirement-evidence-equivalence/v1",
        feature_id: featureId,
        task_id: entry.task_id,
        requirement: entry.requirement,
        role: entry.role,
        receipt: entry.receipt,
        previous_tree: entry.tree,
        tree,
        verification,
      },
    }, options);
    await scaffold(repository, {
      operation: "evidence-equivalence",
      feature_id: featureId,
      task_id: entry.task_id,
      payload: { requirement: entry.requirement, role: entry.role, receipt: entry.receipt, tree, reference },
    }, options);
    carried.push({ task: entry.task_id, requirement: entry.requirement, role: entry.role, reference });
  }
  return carried;
}

/**
 * Reassess completed work after the coverage binding changed (for example a corrective task was added as
 * another contributor). Scaffold makes every association of that requirement stale, and accepts the same
 * completing receipt again only as a new association under the new binding with its own reference.
 *
 * Nothing is re-bound on trust. An association is carried only when the task is still completed with the
 * same receipt, design and checkpoint tree, still holds the role, and the retained receipt re-authenticates
 * with an independent review that verified exactly this requirement. Anything else stays stale and blocks.
 * `authenticate(repository, reference, binding)` is the task-receipt authentication used by checkpoints.
 */
export async function rebindRequirementEvidence(repository, featureId, authenticate, options = {}) {
  const feature = (await scaffold(repository, { operation: "list", feature_id: featureId }, options)).feature;
  const view = await scaffold(repository, { operation: "requirements", feature_id: featureId }, options);
  const holders = new Map(view.requirements.map((r) => [r.id, {
    contributors: r.contributors.map((h) => h.id), verifiers: r.verifiers.map((h) => h.id),
  }]));
  const rebound = [], skipped = [];
  const keys = new Map();
  for (const entry of feature.evidence ?? [])
    keys.set(JSON.stringify([entry.task_id, entry.requirement, entry.role, entry.receipt]), entry);
  for (const [key, entry] of keys) {
    const current = holders.get(entry.requirement);
    if (!current) continue;
    const binding = requirementBinding(entry.requirement, current);
    if ((feature.evidence ?? []).some((e) => JSON.stringify([e.task_id, e.requirement, e.role, e.receipt]) === key &&
      e.binding === binding)) continue;
    const task = feature.tasks[entry.task_id];
    const completion = [...(task?.history ?? [])].reverse().find((h) => h.evidence)?.evidence?.reference;
    // Associations of attempts that did not complete the task are history, not outstanding work.
    if (task?.status !== "completed" || completion !== entry.receipt) continue;
    const why = entry.design !== task.designs?.at(-1)?.reference ? "the task's design changed"
      : !(entry.role === "contribute" ? current.contributors : current.verifiers).includes(entry.task_id) ? "the task no longer holds this role"
      : task.checkpoint?.tree !== entry.tree ? "the checkpoint tree was rewritten after this association"
      : null;
    if (why) { skipped.push({ task: entry.task_id, requirement: entry.requirement, role: entry.role, reason: why }); continue; }
    const record = await authenticate(repository, entry.receipt, { featureId, taskId: entry.task_id, designRef: feature.design_ref });
    const reviewed = requiredRequirements(record.args?.deliveryContext).find((r) => r.requirement === entry.requirement);
    const open = unverifiedRequirements(reviewed ? [reviewed] : [], record.result?.conductor?.review);
    if (!reviewed || !reviewed.roles.includes(entry.role) || open.length) {
      skipped.push({ task: entry.task_id, requirement: entry.requirement, role: entry.role,
        reason: "the retained review did not verify this requirement in this role" });
      continue;
    }
    const assessment = record.result.conductor.review.obligation_assessments
      .find((a) => a.obligation_id === requirementObligationId(entry.requirement));
    const { reference } = await scaffold(repository, {
      operation: "artifact-put",
      feature_id: featureId,
      payload: {
        schema: "pi.requirement-evidence-rebinding/v1",
        feature_id: featureId,
        instance_id: feature.workflow.instance_id,
        task_id: entry.task_id,
        requirement: entry.requirement,
        role: entry.role,
        receipt: entry.receipt,
        tree: entry.tree,
        design: entry.design,
        previous: { reference: entry.reference, binding: entry.binding },
        binding,
        holders: current,
        review: { review_id: record.result.conductor.review.review_id, obligation_id: assessment.obligation_id,
          disposition: assessment.disposition, evidence: assessment.evidence },
      },
    }, options);
    await scaffold(repository, {
      operation: "evidence-record",
      feature_id: featureId,
      task_id: entry.task_id,
      payload: { feature_id: featureId, instance_id: feature.workflow.instance_id, requirement: entry.requirement,
        role: entry.role, result: "PASSED", basis: entry.basis, receipt: entry.receipt, tree: entry.tree, binding,
        design: entry.design, reference },
    }, options);
    rebound.push({ task: entry.task_id, requirement: entry.requirement, role: entry.role, reference });
  }
  return { rebound, skipped };
}
