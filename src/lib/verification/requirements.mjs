// Requirement traceability shared by execution, review, finalization and feature validation.
//
// Scaffold owns requirement identity, task roles and evidence associations. This module never stores
// requirements: it names them for the review protocol, derives a task's roles from Scaffold's own
// contributor/verifier sets, and judges independent review assessments against those roles.
import { createHash } from "node:crypto";

const requireValue = (ok, message) => { if (!ok) throw new Error(message); };
const text = (v) => typeof v === "string" && !!v.trim() && !v.includes("\0");

/**
 * Review obligation id for a canonical requirement. The prefix keeps requirement ids apart from
 * dynamic obligations (`finding-`, `check-`, `amendment-`, `obligation-`) and task-local criteria,
 * so a requirement id from a ticket can never collide with, or be closed as, any of them.
 */
export const REQUIREMENT_PREFIX = "requirement:";
export const requirementObligationId = (id) => REQUIREMENT_PREFIX + id;
export const isRequirementObligationId = (id) => typeof id === "string" && id.startsWith(REQUIREMENT_PREFIX);

/**
 * This task's roles for one scoped requirement, derived from Scaffold's contributor/verifier sets (the
 * same sets Scaffold checks evidence against). A childless root holds every requirement implicitly, so
 * its link-derived `roles` are empty even though it must contribute and verify.
 */
export function taskRoles(requirement, taskId) {
  if (Array.isArray(requirement.contributors) && Array.isArray(requirement.verifiers))
    return [
      ...(requirement.contributors.includes(taskId) ? ["contribute"] : []),
      ...(requirement.verifiers.includes(taskId) ? ["verify"] : []),
    ];
  return [...(requirement.roles ?? [])].sort();
}

// Python's json.dumps(value, sort_keys=True, separators=(",", ":")) with its default ensure_ascii.
function pythonJson(value) {
  if (Array.isArray(value)) return "[" + value.map(pythonJson).join(",") + "]";
  if (value !== null && typeof value === "object")
    return "{" + Object.keys(value).sort().map((k) => pythonJson(k) + ":" + pythonJson(value[k])).join(",") + "}";
  if (typeof value === "string")
    return JSON.stringify(value).replace(/[\u007f-￿]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
  return JSON.stringify(value);
}

/**
 * Digest of who must contribute to and verify one requirement: Scaffold's
 * `ticket_pipeline.lib.evidence.binding`. Scaffold refuses an evidence record whose binding is not the
 * current one, so a mismatch here can never be recorded, only rejected.
 */
export function requirementBinding(id, { contributors, verifiers }) {
  requireValue(text(id) && Array.isArray(contributors) && Array.isArray(verifiers),
    "Requirement binding needs the requirement id and its contributor and verifier sets");
  return createHash("sha256").update(pythonJson({ requirement: id, contributors, verifiers }), "utf8").digest("hex");
}

/** Requirement contract items of a delivery context: [{id, requirement, text, roles}]. */
export const requirementItems = (context) => (context?.contractItems ?? []).filter((i) => typeof i.requirement === "string");
/** Requirements this task must contribute to or verify: they need an explicit verified assessment. */
export const requiredRequirements = (context) => requirementItems(context).filter((i) => i.roles?.length > 0);
/** Requirements visible to this task but assigned elsewhere: deferred, never satisfied here. */
export const deferredRequirements = (context) => requirementItems(context).filter((i) => !i.roles?.length);

/**
 * Required requirement ids this review did not explicitly verify, with what the review said. Only a
 * `verified` assessment with evidence counts. `not_applicable` never waives required work (the mapping
 * is Scaffold's, not the reviewer's), and `unresolved`, a wrong id or no assessment leave it open.
 */
export function unverifiedRequirements(items, review) {
  const assessments = review?.obligation_assessments ?? [];
  return items
    .map((item) => {
      const a = assessments.find((x) => x.obligation_id === item.id);
      return {
        id: item.id,
        requirement: item.requirement,
        assessed: !a ? "not assessed"
          : a.disposition === "verified" ? (text(a.evidence) ? null : "verified without evidence")
          : a.disposition,
      };
    })
    .filter((r) => r.assessed !== null);
}

export function describeUnverifiedRequirements(open) {
  return open.length + " required requirement(s) not independently verified by this review: " +
    open.map((r) => r.id + " [" + r.assessed + "]").join(", ") +
    ". Each needs an obligation_assessments entry with that exact id, disposition `verified` and concrete " +
    "evidence; `not_applicable` cannot waive required work. If the requirement truly belongs to another task, " +
    "correct the mapping through the issue design instead";
}
