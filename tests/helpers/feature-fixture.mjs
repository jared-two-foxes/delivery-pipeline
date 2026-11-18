import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFile, readdir, mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { git } from "../../agent/lib/git/tree.mjs";
import { snapshot } from "../../agent/lib/git/snapshot.mjs";
import { approveFeatureDirection } from "../../agent/extensions/scaffold/feature-authorization.mjs";
import { verifyHistory } from "../../agent/lib/verification/history.mjs";
import { spawnSync } from "node:child_process";
import { executeAndReview as executeTaskAttempt } from "./conductor-v2.mjs";
import { checkpointVerifiedTask } from "../../agent/extensions/checkpoint/scaffold.mjs";
import { scaffoldTasks } from "../../agent/extensions/scaffold/adapter.mjs";
import { designReference } from "../../agent/lib/scaffold/contracts.mjs";
import { authenticateIssueMutation } from "../../agent/lib/verification/issue-mutation.mjs";
import {
  validateFeature,
  runFeatureChecks,
  inspectFeatureValidation,
} from "../../agent/extensions/feature-validation/feature.mjs";
import { approveGraph, requirementsFor } from "./issue-plan.mjs";
const fixtureScaffold = new Map();
export async function executeAndReview(args, context, options) {
  const scaffoldOptions = fixtureScaffold.get(context.directory);
  const r = await scaffoldTasks(
    { operation: "list", feature_id: args.task.featureId },
    context,
    scaffoldOptions,
  );
  if (r.ok && !args.previousAttempt)
    args = {
      ...args,
      requirements: requirementsFor(
        r.data.feature.tasks[args.task.taskId],
        args.requirements,
      ),
    };
  return executeTaskAttempt(args, context, { ...options, scaffoldOptions });
}

const hasScaffold = spawnSync("scaffold", ["--help"], { encoding: "utf8" }).status === 0;
// A receipt or feature record is a ledger artifact: tamper with its stored bytes.
export async function artifactPath(dir, reference) {
  const features = path.join(dir, ".scaffold", "features");
  const [instance] = await readdir(features);
  return path.join(features, instance, "artifacts", reference.split(":").at(-1));
}
export const integration = { skip: !hasScaffold && "Real Scaffold (schema 3) is not on PATH" };
export async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "pi-feature-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dir = path.join(root, "repo");
  execFileSync("git", ["init", "-q", "-b", "main", dir]);
  const g = (...args) => git(dir, args);
  g("config", "user.name", "Test");
  g("config", "user.email", "test@example.invalid");
  g("config", "core.autocrlf", "false");
  g("config", "core.excludesfile", "");
  await writeFile(path.join(dir, ".gitignore"), ".scaffold/\noutput/\n");
  await writeFile(path.join(dir, "source.txt"), "base\n");
  g("add", ".");
  g("commit", "-qm", "A");
  g("switch", "-qc", "feature/test");
  const base = g("rev-parse", "HEAD");
  const scaffoldOptions = {};
  fixtureScaffold.set(dir, scaffoldOptions);
  t.after(() => fixtureScaffold.delete(dir));
  const call = async (operation, extra = {}) => {
    if (operation === "start") {
      await approveGraph(call);
      const state = (await call("list")).feature;
      if (state.workflow.phase === "implement" && !state.direction) {
        const approved = await approveFeatureDirection({ featureId: "F5" }, { directory: dir }, { confirm: async () => true });
        assert.equal(approved.ok, true, JSON.stringify(approved));
      }
    }
    const response = await scaffoldTasks(
      { operation, feature_id: "F5", ...extra },
      { directory: dir },
      { ...scaffoldOptions, authorizeIssueMutation: authenticateIssueMutation },
    );
    assert.equal(response.ok, true, JSON.stringify(response));
    return response.data;
  };
  const context =
    "Approved feature: producer and consumer must interoperate. Preserve errors.\nOriginal baseline: " +
    base;
  const designRef = designReference(context);
  await call("init", {
    payload: {
      id: "F5",
      title: "Complete feature",
      objective: "Integrated behavior",
      context,
      design_ref: designRef,
      baseline: base,
      branch: "feature/test",
      acceptance_criteria: [
        "Producer and consumer interoperate",
        "Errors handled",
      ],
    },
  });
  const add = async (id, dependencies = [], parent) => {
    const feature = (await call("list")).feature;
    if (feature.workflow.phase === "implement")
      await call("design-reopen", {
        payload: { reason: "Plan additional fixture issues" },
      });
    return call(parent ? "decompose" : "add", {
      ...(parent ? { task_id: parent } : {}),
      payload: [
        {
          id,
          title: id,
          objective: id,
          acceptance_criteria: ["Verified " + id],
          dependencies,
        },
      ],
    });
  };
  async function finish(id, empty = false) {
    await call("start", { task_id: id });
    const args = {
      task: { featureId: "F5", taskId: id, designRef },
      baseRef: g("rev-parse", "HEAD"),
      input: '{"operations":[]}',
      requirements: "Only task " + id,
      checks: [
        { name: "build", command: ["build"] },
        { name: "test", command: ["test"] },
      ],
    };
    const attempt = await executeAndReview(
      args,
      { directory: dir },
      {
        invokeConductor: async (json) => {
          if (!empty) await writeFile(path.join(dir, id + ".txt"), id + "\n");
          const req = JSON.parse(json),
            boundary = JSON.parse(req.checks[1].args[1]);
          await writeFile(boundary.output, JSON.stringify(await snapshot(dir)));
          return {
            code: 0,
            stdout: JSON.stringify({
              schema: "fixture.delivery-outcome/v1",
              status: "PASSED",
              phase: "review",
              execution: { success: true },
              checks: ["build", "test"].map((name) => ({ name, exit_code: 0 })),
              review: { status: "APPROVED" },
            }),
          };
        },
      },
    );
    assert.equal(attempt.status, "PASSED", JSON.stringify(attempt));
    await call("complete", {
      task_id: id,
      payload: {
        feature_id: "F5",
        task_id: id,
        result: "PASSED",
        source: "conductor",
        reference: attempt.evidence.reference,
        summary: "Verified task",
      },
    });
    const checkpoint = await checkpointVerifiedTask(
      {
        task: args.task,
        evidenceRef: attempt.evidence.reference,
        featureBaseRef: base,
        branch: "feature/test",
        defaultBranch: "main",
        protectedBranches: [],
        authorizationMode: "manual",
      },
      { directory: dir },
      { scaffoldOptions, authorize: async () => true },
    );
    assert.equal(checkpoint.ok, true, JSON.stringify(checkpoint));
    return checkpoint;
  }
  const review = path.join(root, "review.cjs"),
    capture = path.join(root, "capture.json");
  async function reviewer(status = "APPROVED", mutation = "") {
    await writeFile(
      review,
      `const fs=require('node:fs');const args=process.argv.slice(2);
const req=JSON.parse(fs.readFileSync(args[args.indexOf('--request')+1],'utf8'));
fs.writeFileSync(${JSON.stringify(capture)}, JSON.stringify({req,requirements:fs.readFileSync(req.requirements,'utf8'),args}));
${mutation}
const requirements=fs.readFileSync(req.requirements,'utf8');
const obligations=[];
for(const line of requirements.split('\\n')) {
 if(line.startsWith('[{"id":')) for(const task of JSON.parse(line)) obligations.push(...(task.deliveryContext?.obligations??[]));
 if(line.startsWith('Persisted feature obligations: ')) obligations.push(...JSON.parse(line.slice('Persisted feature obligations: '.length)));
}
const obligation_assessments=[...new Set(obligations.map(o=>o.id))].map(id=>({obligation_id:id,disposition:'verified',evidence:'Independent fixture inspected the correction and integration regressions'}));
console.log(JSON.stringify({schema:'review.result/v1',obligation_assessments,status:${JSON.stringify(status)},reason:${JSON.stringify(status === "INDETERMINATE" ? "BUDGET_EXHAUSTED" : "REVIEW_COMPLETED")},review_id:'feature-review',completed_at:'2026-10-26T00:00:00Z',findings:${status === "CHANGES_REQUESTED" ? "[{blocking:true,severity:'high',message:'Consumer interface mismatches producer'}]" : "[]"}}));process.exit(${{ APPROVED: 0, CHANGES_REQUESTED: 1, INDETERMINATE: 3 }[status]});`,
    );
  }
  await reviewer();
  const options = {
    scaffoldOptions,
    authorize: async () => true,
    reviewOptions: { executable: process.execPath, prefixArgs: [review] },
  };
  const args = () => ({
    featureId: "F5",
    designRef,
    featureBaseRef: base,
    headRef: g("rev-parse", "HEAD"),
    branch: "feature/test",
    buildCommand: [process.execPath, "-e", 'console.log("project built")'],
    testCommand: [
      process.execPath,
      "-e",
      'console.log("12 integration tests passed")',
    ],
    testSuccessPattern: "12 integration tests passed",
    review: { maxTurns: 8, maxToolCalls: 30, wallClockBudgetSecs: 30 },
  });
  const prepare = async () => {
    const feature = (await call("list")).feature;
    if (
      feature.tasks.F5.status !== "completed" &&
      Object.values(feature.tasks)
        .filter((t) => t.id !== "F5")
        .every((t) => t.status === "completed")
    ) {
      try {
        verifyHistory(dir, feature, { head: g("rev-parse", "HEAD") });
        if ((await snapshot(dir)).clean) await finish("F5", true);
      } catch {} // Invalid checkpoints/source are tested by the real final gate below.
    }
  };
  const validate = async (patch = {}, optionPatch = {}) => {
    await prepare();
    return validateFeature(
      { ...args(), ...patch },
      { directory: dir },
      { ...options, ...optionPatch },
    );
  };
  const checks = async (patch = {}, optionPatch = {}) => {
    await prepare();
    const { review: _review, ...mechanical } = args();
    return runFeatureChecks(
      { ...mechanical, ...patch },
      { directory: dir },
      { ...options, ...optionPatch },
    );
  };
  return {
    dir,
    g,
    base,
    prepare,
    checks,
    add,
    finish,
    call,
    reviewer,
    options,
    args,
    validate,
    capture,
  };
}

// The mechanical final gate: same checks and coverage rule as validate_feature, but no agent review.
// Scaffold records its result as a checks-only result: PASSED makes the feature "checked", never "verified".
export async function finishedFeature(f) {
  await f.add("parent");
  await f.add("one", [], "parent");
  await f.finish("one");
  await f.finish("parent", true);
}
export const exists = (file) => readFile(file).then(() => true, () => false);
export const finished = async (f) =>
  (await f.call("list")).feature.validation.history.filter((h) => h.event === "finished");
