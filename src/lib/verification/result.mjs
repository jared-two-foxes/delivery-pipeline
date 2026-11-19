import { unverifiedObligations } from "./obligations.mjs";
import { verificationChecks } from "./checks.mjs";
import { authenticNormalized } from "./workflow.mjs";

// The first unmet precondition of a verified result, as text a person can act on, or null when none is unmet.
// Structural success is necessary, never proof that meaningful tests ran. Pi
// must also inspect check output and the independently produced review content.
// With `noDelta` (the task changed nothing relative to its base) open obligations are not required to be
// verified by this task-level review: they stay open on the task, so final feature validation still must
// verify every one of them before anything passes.
export function verificationFailure(result, args, { noDelta = false } = {}) {
  let checks;
  try {
    checks = verificationChecks(args);
  } catch (error) {
    return "verification checks are invalid: " + error.message;
  }
  const c = result?.conductor;
  if (result?.status !== "PASSED") return "result status is " + result?.status + ", not PASSED";
  if (c?.schema !== "pi.conductor-result/v1") return "no pi.conductor-result/v1 in the result";
  if (!authenticNormalized(c))
    return "the retained Conductor result does not re-derive from its own request, receipts and tool outputs";
  if (c.status !== "PASSED") return "Conductor status is " + c.status + ", not PASSED";
  if (c.phase !== "review") return "Conductor stopped in phase " + c.phase + ", before review";
  if (c.error) return "Conductor reported an error: " + JSON.stringify(c.error).slice(0, 300);
  if (c.execution?.success !== true) return "Executor did not report success";
  if (!Array.isArray(c.checks) || c.checks.length !== checks.length)
    return "the receipt has " + (c.checks?.length ?? 0) + " check results but the verification plan has " +
      checks.length + " (" + checks.map((k) => k.name).join(", ") + ")";
  for (const [index, check] of checks.entries()) {
    const got = c.checks[index];
    if (got?.name !== check.name)
      return "check " + index + " is " + got?.name + " in the receipt but " + check.name + " in the plan";
    if (got.status !== "PASSED") return 'check "' + check.name + '" status is ' + got.status;
    if (!check.successCondition && got.exit_code !== 0)
      return 'check "' + check.name + '" exited ' + got.exit_code;
  }
  if (c.review?.status !== "APPROVED") return "review status is " + c.review?.status + ", not APPROVED";
  if (!noDelta) {
    const open = unverifiedObligations(args ?? {}, c.review, { deferNotApplicable: true });
    if (open.length)
      return open.length + " open obligation(s) not resolved by this review (a `verified` assessment with evidence, " +
        "a `not_applicable` one with evidence that defers it to feature validation, or an approved amendment " +
        "naming the id): " +
        open.map((o) => o.id + " [" + o.assessed + "]").join(", ");
  }
  return null;
}

export function verifiedResult(result, args, options) {
  return verificationFailure(result, args, options) === null;
}
