// Authenticate retained contract deltas without consulting the task runtime.
import { isDeepStrictEqual as equal } from "node:util";
import { readEvidence, readFeatureEvidence } from "../evidence/store.mjs";
const requireValue = (ok, message) => {
  if (!ok) throw new Error(message);
};

export async function authenticateAmendment(repository, reference, task) {
  const record = await readFeatureEvidence(repository, reference);
  requireValue(
    record.kind === "delivery-amendment" &&
      record.approved === true &&
      record.scope.task.featureId === task.featureId &&
      record.scope.task.designRef === task.designRef,
    "Amendment requires explicit matching feature authority",
  );
  if (record.scope.previousAttempt === null) {
    // Approved before any attempt: there is no receipt to check against. The originals the user was shown
    // are retained in the scope, and the caller that applies the amendment must match its ids to the
    // issue's current contract items (see applyAmendment in delivery-context).
    requireValue(
      equal(record.scope.task.taskId, task.taskId) &&
        Array.isArray(record.scope.ids) && record.scope.ids.length > 0 &&
        record.scope.ids.every((id) => record.scope.original?.some((o) => o.id === id)),
      "Amendment has no retained originating obligations",
    );
    return { reference, ...record.scope };
  }
  const previous = await readEvidence(repository, record.scope.previousAttempt);
  requireValue(
    equal(previous.task, record.scope.task) &&
      equal(previous.after, record.scope.source) &&
      record.scope.ids.every((id) =>
        (previous.args.deliveryContext?.contractItems ?? [])
          .concat(previous.args.deliveryContext?.obligations ?? [])
          .some((o) => o.id === id),
      ),
    "Amendment has no authenticated originating obligations",
  );
  return { reference, ...record.scope };
}
