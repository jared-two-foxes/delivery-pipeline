import { authenticateAmendment } from '../authorization/amendment.mjs';
import { authenticateAttemptChain } from './attempt-chain.mjs';
import { readEvidence } from '../evidence/store.mjs';
import { verificationFailure } from './result.mjs';
import { taskHasNoDelta } from './no-delta.mjs';
import { isDeepStrictEqual as equal } from 'node:util';
const requireValue = (ok, message) => { if (!ok) throw new Error(message); };
const sha = x => /^[a-f0-9]{40}$/.test(x ?? '');

// When the commit command fails after an approved review, the attempt is retained as BLOCKED/COMMIT_GATE_FAILED even though
// every earlier stage passed. That receipt is exactly what recovery must be able to use, so it is judged on its Conductor
// evidence (re-derived and checked by verificationFailure) rather than on the outer status the failed commit stamped on it.
// It must still describe the reviewed tree: the review boundary snapshot has to equal the post-attempt snapshot.
function commitGateRecovery(record) {
  const { result, reviewSnapshot: s, after } = record;
  const sealed = s && after && s.head === after.head && s.tree === after.tree && s.digest === after.digest && !s.bookkeepingVisible;
  return result?.status === 'BLOCKED' && result.stage === 'EVIDENCE' && result.reason === 'COMMIT_GATE_FAILED' && sealed
    ? { ...result, status: 'PASSED' } : result;
}

// Shared authentication for task checkpoints and cumulative feature validation.
// A receipt is written by Pi and stored as a hash-verified ledger artifact, so it is not re-derived from
// the Conductor request, the workflow or the review handoff. What is checked is what catches a mistake:
// the receipt belongs to this task and design, passed its checks and review, describes a clean tree,
// carries only amendments the user approved, and continues the recorded attempt chain.
export async function authenticateTaskEvidence(repository, reference, binding) {
  const record = await readEvidence(repository, reference, { featureId: binding.featureId });
  for (const a of record.args.deliveryContext?.amendments ?? [])
    requireValue(equal(await authenticateAmendment(repository, a.reference, binding), a), 'Invalid amendment authority');
  requireValue(['featureId', 'taskId', 'designRef'].every(k => record.task[k] === binding[k]), 'Task/design identity mismatch');
  const failure = verificationFailure(commitGateRecovery(record), record.args, { noDelta: taskHasNoDelta(repository, record.args?.baseRef, record.after?.tree) }) ??
    (record.before?.head !== record.args?.baseRef ? 'the receipt started from ' + record.before?.head + ', not the task base ' + record.args?.baseRef
      : record.after?.head !== record.before.head ? 'HEAD moved from ' + record.before.head + ' to ' + record.after?.head + ' during the attempt'
      : !sha(record.after?.tree) ? 'the receipt carries no Git tree' : null);
  requireValue(failure === null, 'Missing successful task-bound verification or Git tree: ' + failure);
  await authenticateAttemptChain(repository, reference, binding);
  return record;
}
