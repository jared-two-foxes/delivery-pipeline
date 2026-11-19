import { hash } from "../delivery-state/context-digest.mjs";
const text = v => typeof v === "string" && v.trim() && !v.includes("\0");
export function findingObligations(records) {
  const found = new Map();
  for (const r of records) {
    const review = r.result.conductor?.review;
    for (const [i, f] of (review?.findings ?? []).entries()) {
      if (!f.blocking) continue;
      // Occurrences never disappear through fuzzy deduplication or line movement.
      const id = "finding-" + hash([review.review_id, i, f]).slice(0, 24);
      found.set(id, {
        id,
        text: f.message,
        path: f.path,
        source: review.review_id,
        status: "open",
      });
    }
    for (const [i, c] of (r.result.conductor?.checks ?? []).entries()) {
      if (c.status === "PASSED") continue;
      const id = "check-" + hash([r.task, r.attempt, i, c.name]).slice(0, 24);
      found.set(id, {
        id,
        text:
          "Resolve failed check " +
          c.name +
          (r.result.conductor?.runner?.receipts?.[i + 1]?.sourceBefore
            ? " (retained attempt " + r.attempt + ")"
            : ": " + String(c.stderr ?? c.problem ?? c.stdout ?? "").slice(0, 2000)),
        source: "attempt:" + r.attempt + ":check:" + c.name,
        status: "open",
      });
    }
    if (review?.reason === "REVIEW_COMPLETED")
      for (const a of review.obligation_assessments ?? []) {
        if (
          a.disposition === "verified" &&
          found.has(a.obligation_id) &&
          text(a.evidence)
        )
          found.get(a.obligation_id).status = "independently_verified";
      }
  }
  return [...found.values()];
}


// Open obligations this review did not close, each with what the review actually said about it. Only an
// explicit `verified` assessment with evidence closes one (or an approved amendment naming it); `unresolved`,
// `not_applicable`, an assessment without evidence, or no assessment at all leave it open.
//
// With `deferNotApplicable` (the task-level commit gate only), a `not_applicable` assessment that carries evidence
// does not block the task checkpoint: the obligation belongs to a later task. It is NOT marked verified, so it stays
// open on this task and final feature validation (which never sets this option) must still verify it.
export function unverifiedObligations(args, review, { deferNotApplicable = false } = {}) {
  return (args.deliveryContext?.obligations ?? [])
    .filter((o) => o.status !== "independently_verified")
    .filter(
      (o) =>
        !(args.deliveryContext?.amendments ?? []).some((a) =>
          a.ids.includes(o.id),
        ) &&
        !(deferNotApplicable &&
          review?.obligation_assessments?.some(
            (a) =>
              a.obligation_id === o.id &&
              a.disposition === "not_applicable" &&
              text(a.evidence),
          )) &&
        !review?.obligation_assessments?.some(
          (a) =>
            a.obligation_id === o.id &&
            a.disposition === "verified" &&
            text(a.evidence),
        ),
    )
    .map((o) => {
      const a = review?.obligation_assessments?.find((x) => x.obligation_id === o.id);
      return {
        id: o.id,
        assessed: !a
          ? "not assessed"
          : a.disposition === "verified"
            ? "verified without evidence"
            : a.disposition,
      };
    });
}

export function obligationsVerified(args, review) {
  return unverifiedObligations(args, review).length === 0;
}
