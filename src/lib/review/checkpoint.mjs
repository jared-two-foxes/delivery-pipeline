// Re-entrant review: continue an independent review from the checkpoint its previous attempt left,
// instead of starting it over. review-cli saves a checkpoint (ledger, conversation, counters) after
// every turn and when it stops early; a later review given `--resume-from` continues from there under
// whatever limits it is invoked with. Limits are cumulative, so raising --max-tool-calls grants exactly
// the extra headroom. This module only decides whether a retained checkpoint may be resumed.
import { readFile } from "node:fs/promises";
import path from "node:path";

export const REVIEW_CHECKPOINT_FILE = "review-checkpoint.json";
const CHECKPOINT_VERSION = 1;
// Stops that leave resumable work: a limit or budget ran out, the run was cancelled, or the model
// call failed part-way. A review that finished has no checkpoint left to resume.
const RESUMABLE_STOPS = new Set([
  "kernel.session_limit_exceeded",
  "kernel.session_budget_exhausted",
  "kernel.session_cancelled",
  "kernel.session_stalled",
  "kernel.session_indeterminate",
]);

/** The checkpoint a review stage in `outputDirectory` would have written, if it wrote one. */
export const reviewCheckpointPath = (outputDirectory) => path.join(outputDirectory, REVIEW_CHECKPOINT_FILE);

/**
 * Read a retained checkpoint's summary. Returns { stoppedBy, progress } for a resumable checkpoint, or
 * { problem } explaining why it cannot be resumed. Never throws on a missing or malformed file.
 */
export async function inspectReviewCheckpoint(file) {
  let checkpoint;
  try {
    checkpoint = JSON.parse(await readFile(file, "utf8"));
  } catch {
    return { problem: "no review checkpoint was retained by the previous attempt (the review stage may not have run, or review-cli predates checkpoints)" };
  }
  if (checkpoint?.version !== CHECKPOINT_VERSION)
    return { problem: "the retained review checkpoint has an unsupported version" };
  if (!RESUMABLE_STOPS.has(checkpoint.stopped_by))
    return { problem: "the previous review did not stop in a resumable state (" + (checkpoint.stopped_by ?? "still running") + ")" };
  const p = checkpoint.progress ?? {};
  const count = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : 0);
  return {
    stoppedBy: checkpoint.stopped_by,
    progress: {
      turns: count(p.turns),
      toolCalls: count(p.tool_calls),
      distinctToolCalls: count(p.distinct_tool_calls),
      completionAttempts: count(p.completion_attempts),
    },
  };
}

/**
 * Drop the arguments only the adapter may set. A caller cannot choose where a review resumes from or
 * whether it checkpoints, and a continuation must not inherit either from the receipt it continues
 * (hydration spreads the previous attempt's retained args). Call this before anything validates them.
 */
export function stripInternalReviewArgs(args) {
  const { reviewCheckpoint: _checkpoint, reviewResumeFrom: _resumeFrom, ...rest } = args;
  return rest;
}

/**
 * Finalize the review-related arguments of one attempt.
 *
 * Every new attempt asks review-cli to checkpoint (`reviewCheckpoint`). A caller that sets `reviewResume`
 * additionally continues the previous attempt's review (`reviewResumeFrom`, derived here and never taken
 * from the caller). Resuming is refused unless it is safe:
 *  - it continues a previous attempt, whose after-snapshot the adapter has already matched to the
 *    current working tree;
 *  - this attempt applies no source operations, so the tree the review saw is the tree it will review.
 *
 * Returns { args } or { problem }.
 */
export async function withReviewCheckpoint(args, readPrevious) {
  const { reviewResumeFrom: _inherited, ...rest } = args;
  const next = { ...rest, reviewCheckpoint: true };
  if (args.reviewResume !== true) return { args: next };
  if (!args.previousAttempt)
    return { problem: "reviewResume continues a previous attempt's review; supply previousAttempt" };
  if (JSON.parse(args.input).operations.length)
    return { problem: "reviewResume requires empty operations: the review can only continue over the same source it already examined" };
  const previous = await readPrevious(args.previousAttempt);
  const directory = previous?.request?.output_directory ?? previous?.workflow?.request?.output_directory;
  if (typeof directory !== "string" || !path.isAbsolute(directory))
    return { problem: "the previous attempt retained no output directory to resume from" };
  const file = reviewCheckpointPath(directory);
  const checkpoint = await inspectReviewCheckpoint(file);
  if (checkpoint.problem) return { problem: checkpoint.problem };
  return { args: { ...next, reviewResumeFrom: file }, resumed: checkpoint };
}
