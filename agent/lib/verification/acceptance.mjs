// Record the user's sign-off on a feature's CURRENT checked or verified result as a Scaffold
// `validation-accept`. Everything is judged from the ledger (the recorded head and the recorded
// validation result), never from the working tree: after the user has merged and switched branches,
// the feature branch may be gone and the tree is on another branch, which must not prevent accepting
// what the ledger validated. Acceptance grants nothing: it does not publish, merge or change the
// feature, and it ends exactly when the result it signs off does (any later graph or history change,
// invalidation, or new validation attempt). The user's approval is retained as a ledger artifact.
import { isDeepStrictEqual as equal } from 'node:util';

const requireValue = (ok, message) => { if (!ok) throw new Error(message); };
const sha = x => /^[a-f0-9]{40}$/.test(x ?? '');
const ACCEPTABLE = ['checked', 'verified'];
export const NOTE_LIMIT = 500;

// What the user is signing off, read only from the feature as Scaffold records it.
function derive(args, feature) {
  requireValue(feature?.id === args.featureId, 'Cannot inspect feature');
  requireValue(sha(args.headRef), 'The head being accepted must be a full SHA');
  requireValue(args.note === undefined || (typeof args.note === 'string' && args.note.length <= NOTE_LIMIT),
    'note must be text of at most ' + NOTE_LIMIT + ' characters');
  const validation = feature.validation ?? {};
  const status = validation.status;
  requireValue(validation.current && [...ACCEPTABLE, 'accepted'].includes(status),
    'Only a feature whose current result is checked or verified can be accepted (validation status is ' + status +
    '). Run run_feature_checks, or validate_feature, on the finished feature first');
  const finished = [...(validation.history ?? [])].reverse()
    .find(h => h.event === 'finished' && h.attempt_id === validation.current);
  requireValue(finished?.result?.status === 'PASSED', 'The current validation attempt has no passed result');
  const binding = finished.result.binding;
  requireValue(binding?.head === args.headRef,
    'Head mismatch: the current result validated ' + binding?.head + ', received ' + args.headRef);
  requireValue(feature.head === binding.head, 'The ledger head is no longer the head this result validated');
  requireValue(binding.task_revision === feature.task_revision, 'The task graph changed since this result');
  return { validation, status, finished, binding };
}

const scopeOf = (args, feature, { validation, status, finished, binding }) => ({
  featureId: feature.id, instanceId: feature.workflow?.instance_id, title: feature.title,
  designRef: feature.design_ref, branch: feature.branch,
  head: binding.head, tree: binding.tree, baseline: binding.baseline,
  attemptId: validation.current, fromStatus: status,
  resultKind: finished.result.schema === 'pi.feature-checks/v1' ? 'checks-only' : 'reviewed',
  reviewId: finished.result.review?.review_id ?? null,
  checks: (finished.result.checks ?? []).map(c => ({ name: c.name, exit_code: c.exit_code, meaningful: c.meaningful })),
  ...(args.note === undefined ? {} : { note: args.note }),
});

/**
 * `readFeature()` re-reads the feature through Scaffold. `confirm(scope)` is a trusted user approval.
 * `store(artifact)` returns a ledger reference; `record(payload)` appends the `validation-accept` entry.
 */
export async function acceptFeatureResult(args, { readFeature, store, record }, context = {}, options = {}) {
  let writing = false; // true once the write to Scaffold has been attempted: its outcome may be unknown
  try {
    context.abort?.throwIfAborted();
    let feature = await readFeature();
    const first = derive(args, feature);
    // Idempotent: a repeat, or a retry after a lost response, needs no new prompt. A note that was not part of
    // the recorded acceptance is not a repeat: it was never shown to the user or retained, so it is refused.
    if (first.status === 'accepted') {
      const recorded = first.validation.accepted;
      if (args.note !== undefined && args.note !== recorded?.note)
        throw Object.assign(new Error('Already accepted with a different note. The recorded note is ' +
          (recorded?.note === undefined ? 'absent' : JSON.stringify(recorded.note)) + '; the new note was not recorded'),
        { recovery: 'The existing acceptance is unchanged. Repeat without a note to confirm it, or give the recorded note.' });
      return { ok: true, status: 'ACCEPTED', recovered: true, featureId: feature.id, attemptId: first.validation.current,
        head: first.binding.head, accepted: recorded };
    }
    const scope = scopeOf(args, feature, first);
    requireValue(await options.confirm?.(scope) === true, 'Explicit user approval of this acceptance is required');
    context.abort?.throwIfAborted();
    feature = await readFeature();
    const second = derive(args, feature);
    requireValue(second.status !== 'accepted' && equal(scope, scopeOf(args, feature, second)),
      'The feature or its validation result changed during approval; nothing was recorded');
    // Deterministic content, so a retry stores the same artifact.
    const approval = await store({ kind: 'feature-acceptance-approval', scope });
    await options.interrupt?.('afterArtifact');
    const unchanged = derive(args, await readFeature());
    requireValue(unchanged.status !== 'accepted' && equal(scope, scopeOf(args, feature, unchanged)),
      'The validation result changed before the acceptance was recorded; nothing was recorded');
    // A cancelled call must never persist the user's sign-off: check immediately before the write.
    context.abort?.throwIfAborted();
    writing = true;
    await record({ attempt_id: scope.attemptId, binding: second.binding, approval, ...(args.note === undefined ? {} : { note: args.note }) });
    await options.interrupt?.('afterRecord');
    return { ok: true, status: 'ACCEPTED', featureId: feature.id, attemptId: scope.attemptId, head: scope.head,
      fromStatus: scope.fromStatus, resultKind: scope.resultKind, approval, ...(args.note === undefined ? {} : { note: args.note }) };
  } catch (error) {
    return { ok: false, status: 'BLOCKED', message: error.message,
      recovery: error.recovery ?? (writing
        ? 'The write to Scaffold may have completed, so do not assume it was rolled back. Check scaffold_tasks summary: if validation_status is accepted the sign-off is recorded, and repeating accept_feature with the same head is safe (it will not prompt again); otherwise retry with the exact head you approve.'
        : 'Nothing was recorded. Check scaffold_tasks summary: acceptance needs the current result to be checked or verified at the head you name. Retry only with the exact head you approve.') };
  }
}
