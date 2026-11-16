import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { reviewStep, deliveryReviewSettings } from "../agent/lib/review/client.mjs";
import { deliveryReviewStep } from "../agent/lib/verification/workflow.mjs";
import {
  REVIEW_CHECKPOINT_FILE, inspectReviewCheckpoint, reviewCheckpointPath, withReviewCheckpoint,
} from "../agent/lib/review/checkpoint.mjs";

const inputs = { review: { requirements: "/out/requirements.md" }, requirements: "criteria" };
const flagValue = (args, flag) => args[args.indexOf(flag) + 1];

async function scratch(t) {
  const dir = await mkdtemp(path.join(tmpdir(), "review-resume-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
async function writeCheckpoint(directory, fields = {}) {
  await mkdir(directory, { recursive: true });
  await writeFile(reviewCheckpointPath(directory), JSON.stringify({
    version: 1, stopped_by: "kernel.session_limit_exceeded",
    progress: { turns: 7, tool_calls: 40, distinct_tool_calls: 31, completion_attempts: 0 }, ...fields,
  }));
}
const previousIn = (directory) => async () => ({ request: { output_directory: directory } });

test("attempts without checkpoint args build the same review command as before", () => {
  const step = deliveryReviewStep("/out", { reviewMaxToolCalls: 50 }, inputs, "review-cli");
  assert.ok(!step.args.includes("--checkpoint"));
  assert.ok(!step.args.includes("--resume-from"));
});

test("a checkpointing attempt asks review-cli to checkpoint inside its own output directory", () => {
  const step = deliveryReviewStep("/out", { reviewCheckpoint: true }, inputs, "review-cli");
  assert.equal(flagValue(step.args, "--checkpoint"), path.join("/out", REVIEW_CHECKPOINT_FILE));
  assert.ok(!step.args.includes("--resume-from"));
});

test("a resumed attempt loads the previous checkpoint and saves its own", () => {
  const step = deliveryReviewStep("/out/attempt-2",
    { reviewCheckpoint: true, reviewResumeFrom: "/out/attempt-1/review-checkpoint.json", reviewMaxToolCalls: 90 },
    inputs, "review-cli");
  assert.equal(flagValue(step.args, "--resume-from"), "/out/attempt-1/review-checkpoint.json");
  assert.equal(flagValue(step.args, "--checkpoint"), path.join("/out/attempt-2", REVIEW_CHECKPOINT_FILE));
  assert.equal(flagValue(step.args, "--max-tool-calls"), "90");
});

test("review settings reject a resume path without checkpointing or with bad types", () => {
  assert.throws(() => deliveryReviewSettings({ reviewResumeFrom: "/x" }), /Invalid reviewResumeFrom/);
  assert.throws(() => deliveryReviewSettings({ reviewCheckpoint: true, reviewResumeFrom: "a\0b" }), /Invalid reviewResumeFrom/);
  assert.throws(() => deliveryReviewSettings({ reviewCheckpoint: "yes" }), /Invalid reviewCheckpoint/);
});

test("reviewStep leaves the argument order stable and only adds the new flags when asked", () => {
  const plain = reviewStep("/r.json", { requirements: "/q.md" }, "c", { model: "m", budget: 1, turns: 2, limits: [] }, { program: "p" });
  const withBoth = reviewStep("/r.json", { requirements: "/q.md" }, "c", { model: "m", budget: 1, turns: 2, limits: ["--max-tool-calls", "9"] },
    { program: "p", checkpointPath: "/c.json", resumeFrom: "/p.json" });
  assert.deepEqual(withBoth.args.filter((a) => !["--checkpoint", "/c.json", "--resume-from", "/p.json"].includes(a)),
    [...plain.args, "--max-tool-calls", "9"]);
});

test("every new attempt checkpoints; a resume path supplied or inherited is discarded", async () => {
  const { args, problem } = await withReviewCheckpoint(
    { input: '{"operations":[]}', reviewResumeFrom: "/attacker/chosen.json" }, async () => assert.fail("no read"));
  assert.equal(problem, undefined);
  assert.equal(args.reviewCheckpoint, true);
  assert.ok(!("reviewResumeFrom" in args));
});

test("reviewResume derives the path from the previous attempt's retained output directory", async (t) => {
  const directory = path.join(await scratch(t), "attempt-1");
  await writeCheckpoint(directory);
  const out = await withReviewCheckpoint(
    { input: '{"operations":[]}', previousAttempt: "sha256:" + "a".repeat(64), reviewResume: true },
    previousIn(directory));
  assert.equal(out.problem, undefined);
  assert.equal(out.args.reviewResumeFrom, path.join(directory, REVIEW_CHECKPOINT_FILE));
  assert.deepEqual(out.resumed.progress, { turns: 7, toolCalls: 40, distinctToolCalls: 31, completionAttempts: 0 });
  assert.equal(out.resumed.stoppedBy, "kernel.session_limit_exceeded");
});

test("reviewResume is refused unless it is safe to continue the same review", async (t) => {
  const root = await scratch(t);
  const good = path.join(root, "good");
  await writeCheckpoint(good);
  const base = { input: '{"operations":[]}', previousAttempt: "sha256:" + "a".repeat(64), reviewResume: true };

  assert.match((await withReviewCheckpoint({ ...base, previousAttempt: undefined }, previousIn(good))).problem, /supply previousAttempt/);
  assert.match((await withReviewCheckpoint({ ...base, input: '{"operations":[{"op":"write"}]}' }, previousIn(good))).problem, /empty operations/);
  assert.match((await withReviewCheckpoint(base, previousIn(path.join(root, "missing")))).problem, /no review checkpoint/);
  assert.match((await withReviewCheckpoint(base, async () => ({ request: {} }))).problem, /no output directory/);

  const finished = path.join(root, "finished");
  await writeCheckpoint(finished, { stopped_by: "kernel.completion_accepted" });
  assert.match((await withReviewCheckpoint(base, previousIn(finished))).problem, /not stop in a resumable state/);
  const future = path.join(root, "future");
  await writeCheckpoint(future, { version: 2 });
  assert.match((await withReviewCheckpoint(base, previousIn(future))).problem, /unsupported version/);
});

test("without reviewResume a retained checkpoint is ignored and no previous evidence is read", async () => {
  const out = await withReviewCheckpoint(
    { input: '{"operations":[]}', previousAttempt: "sha256:" + "a".repeat(64) }, async () => assert.fail("no read"));
  assert.equal(out.args.reviewCheckpoint, true);
  assert.ok(!("reviewResumeFrom" in out.args));
});

test("inspectReviewCheckpoint tolerates absent, corrupt and partial files", async (t) => {
  const root = await scratch(t);
  assert.match((await inspectReviewCheckpoint(path.join(root, "nope.json"))).problem, /no review checkpoint/);
  await writeFile(path.join(root, "bad.json"), "{not json");
  assert.match((await inspectReviewCheckpoint(path.join(root, "bad.json"))).problem, /no review checkpoint/);
  await writeFile(path.join(root, "bare.json"), JSON.stringify({ version: 1, stopped_by: "kernel.session_stalled" }));
  const bare = await inspectReviewCheckpoint(path.join(root, "bare.json"));
  assert.deepEqual(bare.progress, { turns: 0, toolCalls: 0, distinctToolCalls: 0, completionAttempts: 0 });
});

import { prepareWorkflow } from "../agent/extensions/execute-and-review/workflow.mjs";
import { authenticateWorkflow } from "../agent/lib/verification/workflow.mjs";

async function prepared(t, extra) {
  const repository = await realpath(await scratch(t));
  const args = { input: '{"operations":[]}', requirements: "criteria", baseRef: "a".repeat(40), ...extra };
  const { request, inputs } = await prepareWorkflow(repository, path.join(repository, "runs"), args, []);
  return { repository, args, workflow: { request, inputs } };
}

test("a checkpointing workflow authenticates from its retained args and records the checkpoint flag", async (t) => {
  const { repository, args, workflow } = await prepared(t, { reviewCheckpoint: true });
  const review = JSON.parse(workflow.request.commands.at(-1).args[1]);
  assert.equal(flagValue(review.args, "--checkpoint"), path.join(workflow.request.output_directory, REVIEW_CHECKPOINT_FILE));
  assert.deepEqual(authenticateWorkflow(workflow, workflow.request, args, repository), []);
});

test("a resumed workflow authenticates, and tampering with its resume source is detected", async (t) => {
  const resumeFrom = "/retained/attempt-1/review-checkpoint.json";
  const { repository, args, workflow } = await prepared(t, { reviewCheckpoint: true, reviewResumeFrom: resumeFrom });
  const review = JSON.parse(workflow.request.commands.at(-1).args[1]);
  assert.equal(flagValue(review.args, "--resume-from"), resumeFrom);
  assert.deepEqual(authenticateWorkflow(workflow, workflow.request, args, repository), []);
  assert.throws(
    () => authenticateWorkflow(workflow, workflow.request, { ...args, reviewResumeFrom: "/elsewhere/other.json" }, repository),
    /Retained Executor\/Review invocation mismatch/);
  assert.throws(
    () => authenticateWorkflow(workflow, workflow.request, { ...args, reviewResumeFrom: undefined }, repository),
    /Retained Executor\/Review invocation mismatch/);
});

test("an attempt retained before checkpoints existed still authenticates", async (t) => {
  const { repository, args, workflow } = await prepared(t, {});
  assert.ok(!JSON.parse(workflow.request.commands.at(-1).args[1]).args.includes("--checkpoint"));
  assert.deepEqual(authenticateWorkflow(workflow, workflow.request, args, repository), []);
});
