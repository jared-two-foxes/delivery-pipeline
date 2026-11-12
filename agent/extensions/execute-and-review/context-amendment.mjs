// Explicit user authority for a material contract delta. Never resets execution history.
import path from "node:path";
import { isDeepStrictEqual as equal } from "node:util";
import { git } from "../../lib/git/tree.mjs";
import { snapshot } from "../../lib/git/snapshot.mjs";
import { readEvidence, retainFeatureEvidence } from "../../lib/evidence/store.mjs";
import { requireFeatureAuthorization } from "../scaffold/feature-authorization.mjs";
import { assertLatestAttempt } from "../../lib/verification/attempt-chain.mjs";
import { validateBinding } from "../../lib/delivery-state/binding.mjs";
import { deliveryContractItems } from "../../lib/delivery-state/delivery-context.mjs";
import { taskReceipts } from "../../lib/evidence/attempts.mjs";
import { issueFeature } from "../scaffold/adapter.mjs";
const requireValue = (ok, message) => {
  if (!ok) throw new Error(message);
};

// The retained attempt an amendment is made against, or, before any attempt exists, the issue's current
// contract read from Scaffold. Either way the user confirms a concrete delta against original obligations.
async function amendmentBasis(repository, args, options) {
  if (args.previousAttempt !== undefined) {
    requireValue(args.task === undefined, "Supply previousAttempt or task, not both");
    const previous = await readEvidence(repository, args.previousAttempt),
      task = previous.task;
    await assertLatestAttempt(repository, args.previousAttempt, task, previous.attempt);
    requireValue(
      previous.result.status !== "PASSED" &&
        equal(await snapshot(repository), previous.after),
      "Amend the latest unfinished issue against its unchanged source/index",
    );
    return {
      task,
      source: previous.after,
      items: (previous.args.deliveryContext?.contractItems ?? []).concat(
        previous.args.deliveryContext?.obligations ?? [],
      ),
      recheck: () => assertLatestAttempt(repository, args.previousAttempt, task, previous.attempt),
    };
  }
  // Pre-execution: no attempt receipt exists, so the contract comes from the recorded issue itself.
  validateBinding(args.task);
  const task = args.task;
  requireValue(
    (await taskReceipts(repository, task, options)).length === 0,
    "This issue already has attempts; amend against its latest receipt with previousAttempt",
  );
  const feature = await issueFeature(repository, task, options);
  const issue = feature?.tasks?.[task.taskId];
  requireValue(feature && issue, "Unknown issue or design reference for this amendment");
  return {
    task,
    source: await snapshot(repository),
    items: deliveryContractItems(feature, issue, task),
    recheck: async () =>
      requireValue(
        (await taskReceipts(repository, task, options)).length === 0,
        "An attempt was recorded during amendment approval",
      ),
  };
}

export async function approveDeliveryAmendment(args, context, options = {}) {
  try {
    const repository = path.resolve(
      git(context.directory, ["rev-parse", "--show-toplevel"]),
    );
    requireValue(
      (args.previousAttempt === undefined) !== (args.task === undefined),
      "Supply exactly one of previousAttempt (after an attempt) or task (before the first attempt)",
    );
    const basis = await amendmentBasis(repository, args, options),
      task = basis.task;
    await requireFeatureAuthorization({ task }, context, options);
    requireValue(
      Array.isArray(args.ids) &&
        args.ids.length > 0 &&
        new Set(args.ids).size === args.ids.length &&
        ["replacement", "reason"].every(
          (k) => typeof args[k] === "string" && args[k].trim(),
        ),
      "Explicit delta, IDs and reason required",
    );
    const items = basis.items;
    requireValue(
      args.ids.every((id) => items.some((i) => i.id === id)),
      "Unknown original criterion/finding identity; available: " +
        items.map((i) => i.id + " (" + String(i.text).slice(0, 60) + ")").join("; "),
    );
    const scope = {
      task,
      previousAttempt: args.previousAttempt ?? null,
      source: basis.source,
      ids: args.ids,
      original: items.filter((i) => args.ids.includes(i.id)),
      replacement: args.replacement,
      reason: args.reason,
    };
    requireValue(
      await options.confirm?.(scope),
      "Material scope/obligation amendment requires user approval",
    );
    context.abort?.throwIfAborted();
    await requireFeatureAuthorization({ task }, context, options);
    requireValue(
      equal(await snapshot(repository), scope.source),
      "Source changed during amendment approval",
    );
    await basis.recheck();
    const reference = await retainFeatureEvidence(repository, {
      kind: "delivery-amendment",
      featureId: task.featureId,
      approved: true,
      scope,
    });
    return {
      ok: true,
      reference,
      note: "Apply this explicit amendment via contextUpdates. Original text, sequence and receipts remain retained; this is not verification.",
    };
  } catch (error) {
    return { ok: false, message: error.message };
  }
}
