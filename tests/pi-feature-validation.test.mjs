import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFile, readdir, mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { git } from "../agent/lib/git/tree.mjs";
import { snapshot } from "../agent/lib/git/snapshot.mjs";
import { invoke } from "../agent/lib/scaffold/process.mjs";
import { readFeatureEvidence } from "../agent/lib/evidence/store.mjs";
import { approveFeatureDirection } from "../agent/extensions/scaffold/feature-authorization.mjs";
import { verifyHistory } from "../agent/lib/verification/history.mjs";
import { spawnSync } from "node:child_process";
import { executeAndReview as executeTaskAttempt } from "./helpers/conductor-v2.mjs";
import { checkpointVerifiedTask } from "../agent/extensions/checkpoint/scaffold.mjs";
import { scaffoldTasks } from "../agent/extensions/scaffold/adapter.mjs";
import { designReference } from "../agent/lib/scaffold/contracts.mjs";
import { authenticateIssueMutation } from "../agent/lib/verification/issue-mutation.mjs";
import {
  validateFeature,
  runFeatureChecks,
  inspectFeatureValidation,
} from "../agent/extensions/feature-validation/feature.mjs";
import { readEvidence } from "../agent/lib/evidence/store.mjs";
import { runCheck } from "../agent/extensions/feature-validation/check-process.mjs";
import { acceptFeature } from "../agent/extensions/feature-validation/acceptance.mjs";

import { approveGraph, requirementsFor } from "./helpers/issue-plan.mjs";
const fixtureScaffold = new Map();
async function executeAndReview(args, context, options) {
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
async function artifactPath(dir, reference) {
  const features = path.join(dir, ".scaffold", "features");
  const [instance] = await readdir(features);
  return path.join(features, instance, "artifacts", reference.split(":").at(-1));
}
const integration = { skip: !hasScaffold && "Real Scaffold (schema 3) is not on PATH" };
async function fixture(t) {
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

test(
  "A → B → C → D feature review, failed integration, corrective E and revalidation A → E",
  integration,
  async (t) => {
    const f = await fixture(t);
    await f.add("parent");
    await f.add("one", [], "parent");
    await f.add("two", ["one"], "parent");
    await f.finish("one");
    await f.finish("two");
    const d = await f.finish("parent", true);
    assert.equal(f.g("rev-list", "--count", f.base + "..HEAD"), "3");
    await f.reviewer("CHANGES_REQUESTED");
    const failed = await f.validate();
    assert.equal(failed.status, "NEEDS_DESIGN", JSON.stringify(failed));
    assert.equal((await f.call("list")).feature.validation.status, "failed");
    let capture = JSON.parse(await readFile(f.capture, "utf8"));
    assert.equal(capture.req.base_ref, f.base);
    assert.equal(capture.req.head_ref, f.g("rev-parse", "HEAD"));
    assert.match(
      capture.requirements,
      /Approved feature: producer and consumer/,
    );
    assert.match(capture.requirements, /Producer and consumer interoperate/);
    assert.match(capture.requirements, /12 integration tests passed/);
    assert.match(capture.requirements, /cross-task integration/);
    assert.equal(
      capture.args[capture.args.indexOf("--max-tool-calls") + 1],
      "30",
    );
    await f.add("fix", ["parent"]);
    assert.equal((await f.validate()).status, "BLOCKED");
    const e = await f.finish("fix");
    await f.reviewer();
    const passed = await f.validate();
    assert.equal(passed.status, "PASSED", JSON.stringify(passed));
    assert.equal(passed.binding.head, e.commit);
    assert.equal(passed.binding.baseline, f.base);
    // Telemetry is retained beside, never inside, the authenticated fields.
    const timed = await readFeatureEvidence(f.dir, passed.evidenceRef);
    assert.equal(timed.timings.kind, "feature");
    assert.ok(timed.timings.checks.length >= 1);
    assert.ok(timed.timings.review_ms >= 0);
    // initial + post-authorization + after the check(s) + after review + before retention
    assert.ok(timed.timings.precondition_checks >= 5);
    // The first and last derivations before retention always recompute in full; the
    // ones between reuse the immutable authentication while nothing it reads changed.
    assert.ok(timed.timings.precondition_cache.fresh >= 2);
    assert.ok(timed.timings.precondition_cache.hits >= 1);
    capture = JSON.parse(await readFile(f.capture, "utf8"));
    assert.equal(capture.req.head_ref, e.commit);
    const feature = (await f.call("list")).feature;
    assert.equal(feature.validation.status, "verified");
    assert.deepEqual(
      feature.validation.history
        .filter((h) => h.event === "finished")
        .map((h) => h.result.status),
      ["NEEDS_DESIGN", "PASSED"],
    );
    const retry = await f.validate({ resumeEvidenceRef: passed.evidenceRef });
    assert.equal(retry.status, "PASSED", JSON.stringify(retry));
    assert.equal(retry.recovered, true);
    assert.deepEqual(
      (await f.call("list")).feature.validation.history,
      feature.validation.history,
    );
  },
);

test(
  "unfinished, blocked, missing-checkpoint, unrelated-commit and changed-design features fail closed",
  integration,
  async (t) => {
    for (const variant of [
      "pending",
      "blocked",
      "missingCheckpoint",
      "unrelated",
      "design",
    ]) {
      const f = await fixture(t);
      await f.add("one");
      if (variant === "blocked")
        await f.call("block", { task_id: "one", reason: "Needs architecture" });
      if (["unrelated", "missingCheckpoint", "design"].includes(variant))
        await f.finish("one");
      if (variant === "unrelated")
        f.g("commit", "--allow-empty", "-qm", "Unrelated commit");
      if (variant === "missingCheckpoint") f.g("reset", "--hard", f.base);
      const r = await f.validate(
        variant === "design" ? { designRef: "wrong" } : {},
      );
      assert.equal(r.status, "BLOCKED", variant + JSON.stringify(r));
      assert.equal(
        ((await f.call("list")).feature.validation?.history ?? []).length,
        0,
      );
    }
  },
);

test(
  "full checks: nonzero, missing tool, absent meaningful tests, integration failure and indeterminate review",
  integration,
  async (t) => {
    const f = await fixture(t);
    await f.add("one");
    await f.finish("one");
    for (const [patch, expected] of [
      [
        {
          testCommand: [
            process.execPath,
            "-e",
            'console.error("integration defect");process.exit(7)',
          ],
        },
        "NEEDS_DESIGN",
      ],
      [
        { buildCommand: ["definitely-missing-verification-program"] },
        "BLOCKED",
      ],
      [
        { testCommand: [process.execPath, "-e", 'console.log("0 tests ran")'] },
        "BLOCKED",
      ],
      [
        {
          integrationChecks: [
            {
              name: "smoke",
              command: [process.execPath, "-e", "process.exit(5)"],
              successPattern: "smoke passed",
            },
          ],
        },
        "NEEDS_DESIGN",
      ],
    ]) {
      const r = await f.validate(patch);
      assert.equal(r.status, expected, JSON.stringify(r));
      assert.notEqual(
        (await f.call("list")).feature.validation.status,
        "verified",
      );
      assert.ok(r.evidenceRef);
    }
    await f.reviewer("INDETERMINATE");
    assert.equal((await f.validate()).status, "BLOCKED");
  },
);

test(
  "source mutations during checks/review, branch changes and stale successful evidence cannot complete",
  integration,
  async (t) => {
    for (const variant of ["check", "review", "head", "staged", "branch"]) {
      const f = await fixture(t);
      await f.add("one");
      await f.finish("one");
      if (variant === "check") {
        const r = await f.validate({
          testCommand: [
            process.execPath,
            "-e",
            'require("fs").writeFileSync("source.txt","changed");console.log("12 integration tests passed")',
          ],
        });
        assert.equal(r.status, "BLOCKED");
        assert.match(r.message, /clean|changed/);
      } else if (variant === "review") {
        await f.reviewer(
          "APPROVED",
          'fs.writeFileSync(require("node:path").join(req.repository_path,"source.txt"),"changed");',
        );
        assert.equal((await f.validate()).status, "BLOCKED");
      } else {
        const r = await f.validate();
        assert.equal(r.status, "PASSED", JSON.stringify(r));
        if (variant === "head")
          f.g("commit", "--allow-empty", "-qm", "changed HEAD");
        if (variant === "staged") {
          await writeFile(path.join(f.dir, "source.txt"), "changed");
          f.g("add", ".");
        }
        if (variant === "branch") f.g("switch", "-qc", "other-feature");
        assert.equal(
          (await f.validate({ resumeEvidenceRef: r.evidenceRef })).status,
          "BLOCKED",
        );
        const inspected = await inspectFeatureValidation(
          { reference: r.evidenceRef },
          { directory: f.dir },
          f.options,
        );
        assert.equal(inspected.ok, true);
        assert.equal(inspected.results[0].applicable, false);
        assert.equal(
          (await readFeatureEvidence(f.dir, r.evidenceRef)).result.status,
          "PASSED",
        );
      }
    }
  },
);

test(
  "interruption before/during verification never infers success; retained complete results reconcile once",
  integration,
  async (t) => {
    for (const point of [
      "beforeChecks",
      "beforeReview",
      "beforeRetention",
      "afterRetention",
      "afterCompletion",
    ]) {
      const f = await fixture(t);
      await f.add("one");
      await f.finish("one");
      const interrupted = await f.validate(
        {},
        {
          interrupt: async (stage) => {
            if (stage === point) throw Error("Interrupted at " + point);
          },
        },
      );
      assert.equal(interrupted.status, "BLOCKED");
      if (["afterRetention", "afterCompletion"].includes(point)) {
        const recovered = await f.validate({
          resumeEvidenceRef: interrupted.evidenceRef,
        });
        assert.equal(recovered.status, "PASSED", JSON.stringify(recovered));
        const before = (await f.call("list")).feature.validation.history;
        assert.equal(
          (await f.validate({ resumeEvidenceRef: interrupted.evidenceRef }))
            .status,
          "PASSED",
        );
        assert.deepEqual(
          (await f.call("list")).feature.validation.history,
          before,
        );
      } else {
        assert.notEqual(
          (await f.call("list")).feature.validation.status,
          "verified",
        );
        // Interrupted runs keep the timing evidence gathered so far: at least the
        // initial and post-authorization precondition derivations.
        const diagnostic = await readFeatureEvidence(
          f.dir,
          interrupted.diagnosticEvidenceRef,
        );
        assert.equal(diagnostic.timings.kind, "feature", point);
        assert.ok(diagnostic.timings.precondition_checks >= 2, point);
        assert.equal(
          (
            await f.validate({
              resumeEvidenceRef: interrupted.startedReference,
            })
          ).status,
          "BLOCKED",
        );
        assert.equal((await f.validate()).status, "PASSED");
      }
    }
  },
);

test(
  "no UI authority, task changes during checks and tampered feature evidence fail closed",
  integration,
  async (t) => {
    const f = await fixture(t);
    await f.add("one");
    await f.finish("one");
    assert.equal(
      (await f.validate({}, { authorize: undefined })).status,
      "BLOCKED",
    );
    assert.equal(
      (await f.validate({}, { authorize: async () => false })).status,
      "BLOCKED",
    );
    const passed = await f.validate();
    assert.equal(passed.status, "PASSED");
    await writeFile(await artifactPath(f.dir, passed.evidenceRef), "{}");
    assert.equal(
      (await f.validate({ resumeEvidenceRef: passed.evidenceRef })).status,
      "BLOCKED",
    );
    const r = await f.validate(
      {},
      {
        interrupt: async (stage) => {
          if (stage === "beforeReview") await f.add("correction", ["one"]);
        },
      },
    );
    assert.equal(r.status, "BLOCKED");
  },
);

test("verification subprocess bounds, cancellation and diagnostics preserve actual exit codes", async () => {
  const run = (code, options = {}) =>
    runCheck([process.execPath, "-e", code], options);
  assert.equal(
    (await run('console.error("failure detail");process.exit(9)')).exit_code,
    9,
  );
  assert.equal((await run('console.log("ok")')).stdout.trim(), "ok");
  assert.equal(
    (await run("setInterval(()=>{},1000)", { timeoutMs: 50 })).problem,
    "TIMEOUT",
  );
  assert.equal(
    (
      await run(
        'process.stdout.write("x".repeat(100000));setInterval(()=>{},1000)',
      )
    ).problem,
    "OUTPUT_LIMIT",
  );
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 50);
  assert.equal(
    (await run("setInterval(()=>{},1000)", { signal: controller.signal }))
      .problem,
    "CANCELLED",
  );
  assert.equal((await runCheck(["missing-check-program"])).problem, "ENOENT");
});

test(
  "restored tracked edits fail, ignored generated outputs pass, and invalid review plans run no commands",
  integration,
  async (t) => {
    const f = await fixture(t);
    await f.add("one");
    await f.finish("one");
    const restored = await f.validate({
      testCommand: [
        process.execPath,
        "-e",
        'const fs=require("fs");const original=fs.readFileSync("source.txt");fs.writeFileSync("source.txt","transient");fs.writeFileSync("source.txt",original);console.log("12 integration tests passed")',
      ],
    });
    assert.equal(restored.status, "BLOCKED", JSON.stringify(restored));
    const generated = await f.validate({
      testCommand: [
        process.execPath,
        "-e",
        'const fs=require("fs");fs.mkdirSync("output",{recursive:true});fs.writeFileSync("output/report.txt","generated");console.log("12 integration tests passed")',
      ],
    });
    assert.equal(generated.status, "PASSED", JSON.stringify(generated));
    const invalid = await f.validate({
      review: { maxTurns: 0 },
      buildCommand: [
        process.execPath,
        "-e",
        'require("fs").writeFileSync("source.txt","must not run")',
      ],
    });
    assert.equal(invalid.status, "BLOCKED");
    assert.equal(f.g("status", "--porcelain"), "");
  },
);

test(
  "interrupted check/review and failed completion retention remain recoverable diagnostics",
  integration,
  async (t) => {
    const f = await fixture(t);
    await f.add("one");
    await f.finish("one");
    const timeout = await f.validate({
      testCommand: [process.execPath, "-e", "setInterval(()=>{},1000)"],
      checkTimeoutMs: 100,
    });
    assert.equal(timeout.status, "BLOCKED");
    const receipt = await readFeatureEvidence(f.dir, timeout.evidenceRef);
    assert.ok(receipt.checks.some((c) => c.problem === "TIMEOUT"));
    await f.reviewer("APPROVED", "while(true) {}");
    const blocked = await f.validate(
      {},
      { reviewOptions: { ...f.options.reviewOptions, timeoutMs: 100 } },
    );
    assert.equal(blocked.status, "BLOCKED");
    await f.reviewer();
    const invokeScaffold = invoke;
    const failedHandoff = await f.validate(
      {},
      {
        scaffoldOptions: {
          invokeScaffold: async (program, args, ctx) =>
            args[0] === "validation-record"
              ? { code: 1, stderr: "simulated handoff outage" }
              : invokeScaffold(program, args, ctx),
        },
      },
    );
    assert.equal(failedHandoff.status, "BLOCKED");
    assert.equal(
      (await readFeatureEvidence(f.dir, failedHandoff.evidenceRef)).result
        .status,
      "PASSED",
    );
    assert.equal(
      (await f.validate({ resumeEvidenceRef: failedHandoff.evidenceRef }))
        .status,
      "PASSED",
    );
  },
);

test("Git design references are rejected; context hashes are required", async () => {
  const { approvedDesign } = await import("../agent/lib/verification/feature.mjs");
  assert.throws(() => approvedDesign("/unused", {
    context: "Original approved design", design_ref: "approved.md@" + "a".repeat(40),
  }), /design|context/i);
});

// The mechanical final gate: same checks and coverage rule as validate_feature, but no agent review.
// Scaffold records its result as a checks-only result: PASSED makes the feature "checked", never "verified".
async function finishedFeature(f) {
  await f.add("parent");
  await f.add("one", [], "parent");
  await f.finish("one");
  await f.finish("parent", true);
}
const exists = (file) => readFile(file).then(() => true, () => false);
const finished = async (f) =>
  (await f.call("list")).feature.validation.history.filter((h) => h.event === "finished");

test("run_feature_checks passes without a review and Scaffold records the feature as checked, not verified", integration, async (t) => {
  const f = await fixture(t);
  await finishedFeature(f);
  await f.prepare(); // completes the root issue; this, not the gate, moves Scaffold to awaiting_validation
  assert.equal((await f.call("list")).feature.validation.status, "awaiting_validation");
  const passed = await f.checks();
  assert.equal(passed.status, "PASSED", JSON.stringify(passed));
  assert.equal(passed.schema, "pi.feature-checks/v1");
  assert.equal(passed.mode, "checks-only");
  assert.equal(passed.review, null);
  assert.deepEqual(passed.scaffold, { recorded: true, validation_status: "checked" });
  assert.match(passed.message, /No independent feature review was performed/);
  assert.equal(passed.binding.baseline, f.base);
  assert.equal(passed.binding.head, f.g("rev-parse", "HEAD"));
  assert.deepEqual(passed.checks.map((c) => [c.name, c.meaningful]), [["build", true], ["test", true]]);
  assert.equal(await exists(f.capture), false, "the reviewer was never invoked");
  // Scaffold holds a checks-only result: "checked", never "verified", with no review attached.
  const validation = (await f.call("list")).feature.validation;
  assert.equal(validation.status, "checked");
  assert.equal(validation.reference, passed.evidenceRef);
  const [result] = await finished(f);
  assert.equal(result.result.schema, "pi.feature-checks/v1");
  assert.equal(result.result.review, null);
  assert.equal(Object.hasOwn(result.result, "mode"), false, "pipeline-only fields are not sent to Scaffold");
  // Its own evidence is retained, readable and clearly not a reviewed validation.
  const record = await readFeatureEvidence(f.dir, passed.evidenceRef);
  assert.equal(record.result.schema, "pi.feature-checks/v1");
  assert.equal(record.review, null);
  assert.equal(record.scaffoldRecorded, true);
  assert.equal(record.timings.kind, "feature");
  assert.equal((await snapshot(f.dir)).clean, true, "the gate leaves the worktree clean");
  // inspect_feature_validation recognises it as the current checks-only result, not a broken review.
  const inspected = await inspectFeatureValidation({ featureId: "F5" }, { directory: f.dir }, f.options);
  assert.equal(inspected.ok, true, JSON.stringify(inspected));
  assert.deepEqual(inspected.results.map((r) => [r.kind, r.applicable]), [["checks-only", true]]);
  // validate_feature is unchanged: a reviewed validation of the same head supersedes "checked".
  const full = await f.validate();
  assert.equal(full.status, "PASSED", JSON.stringify(full));
  assert.equal((await f.call("list")).feature.validation.status, "verified");
});

test("run_feature_checks never downgrades a verified feature, and any graph change invalidates checked", integration, async (t) => {
  const f = await fixture(t);
  await finishedFeature(f);
  const full = await f.validate();
  assert.equal(full.status, "PASSED", JSON.stringify(full));
  const verified = (await f.call("list")).feature.validation;
  assert.equal(verified.status, "verified");
  // The checks still run and retain evidence, but Scaffold is left exactly as it was.
  const rerun = await f.checks();
  assert.equal(rerun.status, "PASSED", JSON.stringify(rerun));
  assert.equal(rerun.scaffold.recorded, false);
  assert.equal(rerun.scaffold.validation_status, "verified");
  assert.deepEqual((await f.call("list")).feature.validation, verified);
  assert.equal((await readFeatureEvidence(f.dir, rerun.evidenceRef)).scaffoldRecorded, false);
  // A failing rerun of an already verified feature is reported but still does not touch Scaffold.
  const failing = await f.checks({ testCommand: [process.execPath, "-e", 'console.log("12 integration tests passed");process.exit(1)'] });
  assert.equal(failing.status, "NEEDS_DESIGN");
  assert.deepEqual((await f.call("list")).feature.validation, verified);
  // Graph changes make a checks-only result inapplicable, as for a reviewed one.
  const g = await fixture(t);
  await finishedFeature(g);
  assert.equal((await g.checks()).status, "PASSED");
  assert.equal((await g.call("list")).feature.validation.status, "checked");
  await g.call("design-reopen", { payload: { reason: "Additional work" } });
  assert.equal((await g.call("list")).feature.validation.current, null);
  assert.equal((await g.call("list")).feature.validation.status, "awaiting_validation");
  const stale = await inspectFeatureValidation({ featureId: "F5" }, { directory: g.dir }, g.options);
  assert.equal(stale.results[0].applicable, false, "no longer the current result");
});

test("run_feature_checks records failed and non-meaningful checks and fails closed before any Scaffold write", integration, async (t) => {
  const f = await fixture(t);
  await finishedFeature(f);
  const failing = await f.checks({ testCommand: [process.execPath, "-e", 'console.log("12 integration tests passed");process.exit(1)'] });
  assert.equal(failing.status, "NEEDS_DESIGN", JSON.stringify(failing));
  assert.match(failing.message, /Project check failed: test/);
  assert.equal((await f.call("list")).feature.validation.status, "failed");
  const vacuous = await f.checks({ testCommand: [process.execPath, "-e", 'console.log("0 tests passed")'], testSuccessPattern: "0 tests passed" });
  assert.equal(vacuous.status, "BLOCKED", JSON.stringify(vacuous));
  assert.match(vacuous.message, /Meaningful coverage not established: test/);
  assert.equal((await f.call("list")).feature.validation.status, "blocked");
  const unmarked = await f.checks({ testSuccessPattern: "an approved marker the output never prints" });
  assert.equal(unmarked.status, "BLOCKED");
  // Every recorded result is checks-only with no review; none claims a pass.
  const results = await finished(f);
  assert.deepEqual(results.map((h) => h.result.status), ["NEEDS_DESIGN", "BLOCKED", "BLOCKED"]);
  assert.ok(results.every((h) => h.result.schema === "pi.feature-checks/v1" && h.result.review === null));
  // Authorization and preconditions fail before anything is written to Scaffold.
  const before = (await f.call("list")).feature.validation;
  const unauthorized = await f.checks({}, { authorize: async () => false });
  assert.equal(unauthorized.status, "BLOCKED");
  assert.match(unauthorized.message, /authorization required/);
  assert.deepEqual((await f.call("list")).feature.validation, before);
  assert.equal(await exists(f.capture), false, "no failure path invoked a reviewer");
  // A passing rerun then supersedes the earlier failures: the latest result decides.
  assert.equal((await f.checks()).status, "PASSED");
  assert.equal((await f.call("list")).feature.validation.status, "checked");
});

test("run_feature_checks refuses an unfinished feature and a head that is not the clean checkpointed HEAD", integration, async (t) => {
  const f = await fixture(t);
  await f.add("parent");
  await f.add("one", [], "parent");
  await f.finish("one");
  const unfinished = await f.checks();
  assert.equal(unfinished.status, "BLOCKED", JSON.stringify(unfinished));
  await f.finish("parent", true);
  await f.prepare();
  const before = (await f.call("list")).feature.validation;
  const stale = await f.checks({ headRef: f.base });
  assert.equal(stale.status, "BLOCKED", JSON.stringify(stale));
  await appendFile(path.join(f.dir, "one.txt"), "dirty\n");
  const dirty = await f.checks();
  assert.equal(dirty.status, "BLOCKED", JSON.stringify(dirty));
  assert.match(dirty.message, /clean matching HEAD/);
  assert.deepEqual((await f.call("list")).feature.validation, before, "rejected before any Scaffold write");
});

test("run_feature_checks blocks source edited, or edited then restored, while a check runs, and keeps diagnostics", integration, async (t) => {
  const passing = 'console.log("12 integration tests passed")';
  const variants = {
    edited: `require("fs").writeFileSync("source.txt","changed");${passing}`,
    restored: `const fs=require("fs");const original=fs.readFileSync("source.txt");fs.writeFileSync("source.txt","transient");fs.writeFileSync("source.txt",original);${passing}`,
  };
  for (const [name, code] of Object.entries(variants)) {
    const f = await fixture(t);
    await f.add("one");
    await f.finish("one");
    await f.prepare();
    const r = await f.checks({ testCommand: [process.execPath, "-e", code] });
    assert.equal(r.status, "BLOCKED", name + ": " + JSON.stringify(r));
    assert.equal(r.schema, "pi.feature-checks/v1");
    assert.equal(r.evidenceRef, undefined, name + ": a blocked run retains no success receipt");
    // The interrupted run leaves a readable BLOCKED diagnostic receipt, never a PASSED one.
    assert.ok(r.diagnosticEvidenceRef, name + ": diagnostic evidence retained");
    const diagnostic = await readFeatureEvidence(f.dir, r.diagnosticEvidenceRef);
    assert.equal(diagnostic.result.status, "BLOCKED");
    assert.equal(diagnostic.review, null);
    assert.ok(diagnostic.checks.some((c) => c.name === "test"), name + ": the offending check is recorded");
    // Scaffold closes the attempt as BLOCKED: not left running, never passed.
    const validation = (await f.call("list")).feature.validation;
    assert.equal(validation.status, "blocked", name);
    const [result, ...rest] = await finished(f);
    assert.equal(rest.length, 0, name);
    assert.equal(result.result.status, "BLOCKED");
    assert.equal(result.result.reference, r.diagnosticEvidenceRef);
    assert.equal(result.result.review, null);
    assert.equal(await exists(f.capture), false, name + ": no reviewer ran");
  }
  // Ignored generated output is not a source change, as for validate_feature.
  const g = await fixture(t);
  await g.add("one");
  await g.finish("one");
  const generated = await g.checks({
    testCommand: [process.execPath, "-e", `const fs=require("fs");fs.mkdirSync("output",{recursive:true});fs.writeFileSync("output/report.txt","generated");${passing}`],
  });
  assert.equal(generated.status, "PASSED", JSON.stringify(generated));
  assert.equal(g.g("status", "--porcelain"), "");
});

test("run_feature_checks refuses to start over a validation that finished while authorization was pending", integration, async (t) => {
  const f = await fixture(t);
  await finishedFeature(f);
  await f.prepare(); // so the nested validation changes only Scaffold's validation state
  let nested;
  const r = await f.checks({}, {
    authorize: async () => {
      // A reviewed validation completes inside the authorization window: tasks and source are untouched.
      nested = await f.validate();
      return true;
    },
  });
  assert.equal(nested.status, "PASSED", JSON.stringify(nested));
  assert.equal(r.status, "BLOCKED", JSON.stringify(r));
  assert.match(r.message, /Validation state changed during authorization/);
  // The reviewed result survives untouched: no checks-only attempt was started over it.
  const validation = (await f.call("list")).feature.validation;
  assert.equal(validation.status, "verified");
  assert.deepEqual((await finished(f)).map((h) => h.result.schema), ["pi.feature-validation/v1"]);
});

test("run_feature_checks leaves Scaffold agreeing with a BLOCKED result at every interruption point", integration, async (t) => {
  // [stage, expected Scaffold status]. Before the handoff the attempt is closed as blocked; once it has
  // been recorded it is invalidated, so "checked" never outlives a BLOCKED result.
  for (const [stage, status] of [["beforeChecks", "blocked"], ["beforeRetention", "blocked"],
    ["afterRetention", "blocked"], ["afterCompletion", "awaiting_validation"]]) {
    const f = await fixture(t);
    await f.add("one");
    await f.finish("one");
    await f.prepare();
    const r = await f.checks({}, { interrupt: async (at) => { if (at === stage) throw new Error("Interrupted at " + stage); } });
    assert.equal(r.status, "BLOCKED", stage + ": " + JSON.stringify(r));
    const validation = (await f.call("list")).feature.validation;
    assert.equal(validation.status, status, stage);
    assert.notEqual(validation.status, "checked", stage);
    assert.notEqual(validation.status, "validating", stage + ": the attempt is never left running");
    assert.ok(r.diagnosticEvidenceRef, stage + ": diagnostics retained");
    const results = await finished(f);
    assert.equal(results.at(-1).result.status, stage === "afterCompletion" ? "PASSED" : "BLOCKED", stage);
    assert.equal(await exists(f.capture), false, stage + ": no reviewer ran");
  }
});

test("run_feature_checks cleans up an edit-and-restore detected after the evidence is retained", integration, async (t) => {
  // The worktree is clean and HEAD unchanged again, so only the monitor can see it.
  for (const [stage, status] of [["afterRetention", "blocked"], ["afterCompletion", "awaiting_validation"]]) {
    const f = await fixture(t);
    await f.add("one");
    await f.finish("one");
    await f.prepare();
    const source = path.join(f.dir, "source.txt");
    const r = await f.checks({}, {
      interrupt: async (at) => {
        if (at !== stage) return;
        const original = await readFile(source);
        await writeFile(source, "transient");
        await writeFile(source, original);
        await new Promise((resolve) => setTimeout(resolve, 300)); // let the filesystem notification arrive
      },
    });
    assert.equal(r.status, "BLOCKED", stage + ": " + JSON.stringify(r));
    assert.equal((await snapshot(f.dir)).clean, true, stage + ": nothing is left to see in Git");
    const validation = (await f.call("list")).feature.validation;
    assert.equal(validation.status, status, stage);
    assert.notEqual(validation.status, "checked", stage + ": the tool said BLOCKED, so Scaffold must not say checked");
  }
});

test("run_feature_checks never touches an attempt that has since been superseded", integration, async (t) => {
  const f = await fixture(t);
  await finishedFeature(f);
  await f.prepare();
  let nested;
  const r = await f.checks({}, {
    interrupt: async (at) => {
      if (at !== "afterCompletion") return;
      nested = await f.validate(); // supersedes this run's recorded "checked" with a reviewed result
      throw new Error("Interrupted after completion");
    },
  });
  assert.equal(nested.status, "PASSED", JSON.stringify(nested));
  assert.equal(r.status, "BLOCKED");
  // The reviewed result is not invalidated by the interrupted checks-only run's cleanup.
  assert.equal((await f.call("list")).feature.validation.status, "verified");
});

// Acceptance: the user's sign-off on the current checked or verified result.
const acceptArgs = (head, patch = {}) => ({ featureId: "F5", headRef: head, ...patch });
const acceptWith = (f, head, patch = {}, optionPatch = {}) =>
  acceptFeature(acceptArgs(head, patch), { directory: f.dir },
    { scaffoldOptions: f.options.scaffoldOptions, confirm: async () => true, ...optionPatch });
const checkedFeature = async (t) => {
  const f = await fixture(t);
  await finishedFeature(f);
  const passed = await f.checks();
  assert.equal(passed.status, "PASSED", JSON.stringify(passed));
  assert.equal((await f.call("list")).feature.validation.status, "checked");
  return { f, head: passed.binding.head, passed };
};

test("accept_feature records the user's sign-off on a checked result, showing exactly what is accepted", integration, async (t) => {
  const { f, head } = await checkedFeature(t);
  let shown = 0, scope;
  const r = await acceptWith(f, head, { note: "Merged as PR 42" }, { confirm: async (s) => { shown += 1; scope = s; return true; } });
  assert.equal(r.status, "ACCEPTED", JSON.stringify(r));
  assert.equal(r.fromStatus, "checked");
  assert.equal(r.resultKind, "checks-only");
  // The user was shown the exact feature, head, result kind and checks.
  assert.equal(shown, 1);
  assert.equal(scope.featureId, "F5");
  assert.equal(scope.head, head);
  assert.equal(scope.fromStatus, "checked");
  assert.equal(scope.resultKind, "checks-only");
  assert.equal(scope.reviewId, null);
  assert.deepEqual(scope.checks.map((c) => [c.name, c.exit_code, c.meaningful]), [["build", 0, true], ["test", 0, true]]);
  assert.equal(scope.note, "Merged as PR 42");
  // Scaffold records it against the validated binding, with the approval retained as an artifact.
  const validation = (await f.call("list")).feature.validation;
  assert.equal(validation.status, "accepted");
  assert.equal(validation.accepted.from_status, "checked");
  assert.equal(validation.accepted.note, "Merged as PR 42");
  assert.equal(validation.accepted.approval, r.approval);
  const artifact = await f.call("artifact-get", { payload: { reference: r.approval } });
  assert.equal(artifact.artifact.kind, "feature-acceptance-approval");
  assert.deepEqual(artifact.artifact.scope, scope);
  // Idempotent: a repeat neither prompts again nor changes Scaffold.
  const before = (await f.call("list")).feature.validation;
  const again = await acceptWith(f, head, {}, { confirm: async () => { throw new Error("must not prompt again"); } });
  assert.equal(again.status, "ACCEPTED", JSON.stringify(again));
  assert.equal(again.recovered, true);
  assert.deepEqual((await f.call("list")).feature.validation, before);
});

test("accept_feature can accept a verified result too", integration, async (t) => {
  const f = await fixture(t);
  await finishedFeature(f);
  const full = await f.validate();
  assert.equal(full.status, "PASSED", JSON.stringify(full));
  let scope;
  const r = await acceptWith(f, full.binding.head, {}, { confirm: async (s) => { scope = s; return true; } });
  assert.equal(r.status, "ACCEPTED", JSON.stringify(r));
  assert.equal(scope.fromStatus, "verified");
  assert.equal(scope.resultKind, "reviewed");
  assert.equal(scope.reviewId, "feature-review");
  assert.equal((await f.call("list")).feature.validation.status, "accepted");
});

test("accept_feature works after the user merged and left the feature branch, from the ledger alone", integration, async (t) => {
  const { f, head } = await checkedFeature(t);
  // The user merged, switched to main and left stray files behind: none of it concerns the ledger's result.
  f.g("switch", "-q", "main");
  await writeFile(path.join(f.dir, "scratch.txt"), "unrelated work in progress\n");
  const r = await acceptWith(f, head);
  assert.equal(r.status, "ACCEPTED", JSON.stringify(r));
  assert.equal((await f.call("list")).feature.validation.status, "accepted");
});

test("accept_feature fails closed: no approval, nothing to accept, wrong head, bad input", integration, async (t) => {
  const { f, head } = await checkedFeature(t);
  const unchanged = async (message, result) => {
    assert.equal(result.status, "BLOCKED", message + ": " + JSON.stringify(result));
    assert.equal(result.ok, false);
    assert.equal((await f.call("list")).feature.validation.status, "checked", message);
    return result;
  };
  await unchanged("declined", await acceptWith(f, head, {}, { confirm: async () => false }));
  assert.match((await acceptWith(f, head, {}, { confirm: async () => false })).message, /approval .* required/);
  await unchanged("no way to ask", await acceptWith(f, head, {}, { confirm: undefined }));
  const wrong = await unchanged("wrong head", await acceptWith(f, f.base));
  assert.match(wrong.message, /Head mismatch/);
  await unchanged("short sha", await acceptWith(f, head.slice(0, 12)));
  await unchanged("note too long", await acceptWith(f, head, { note: "x".repeat(501) }));
  assert.equal((await acceptWith(f, head, { featureId: "NOPE" })).status, "BLOCKED");
  // Nothing validated yet: a feature at awaiting_validation cannot be accepted.
  const g = await fixture(t);
  await finishedFeature(g);
  await g.prepare();
  const none = await acceptWith(g, g.g("rev-parse", "HEAD"));
  assert.equal(none.status, "BLOCKED", JSON.stringify(none));
  assert.match(none.message, /checked or verified/);
  assert.equal((await g.call("list")).feature.validation.status, "awaiting_validation");
  // A failed or blocked result cannot be accepted either.
  const h = await fixture(t);
  await finishedFeature(h);
  const failing = await h.checks({ testCommand: [process.execPath, "-e", 'console.log("12 integration tests passed");process.exit(1)'] });
  assert.equal(failing.status, "NEEDS_DESIGN");
  assert.match((await acceptWith(h, failing.binding.head)).message, /checked or verified/);
});

test("accept_feature records nothing when the result changes while the user is deciding", integration, async (t) => {
  const { f, head } = await checkedFeature(t);
  const r = await acceptWith(f, head, {}, {
    confirm: async () => {
      // More work is added while the prompt is open: the validated result no longer applies.
      await f.call("design-reopen", { payload: { reason: "More work" } });
      return true;
    },
  });
  assert.equal(r.status, "BLOCKED", JSON.stringify(r));
  const validation = (await f.call("list")).feature.validation;
  assert.notEqual(validation.status, "accepted");
  assert.ok(!validation.history.some((h) => h.event === "accepted"), "nothing was recorded");
});

test("an interrupted acceptance records nothing and a retry succeeds", integration, async (t) => {
  const { f, head } = await checkedFeature(t);
  const r = await acceptWith(f, head, {}, { interrupt: async (at) => { if (at === "afterArtifact") throw new Error("Interrupted"); } });
  assert.equal(r.status, "BLOCKED");
  assert.equal((await f.call("list")).feature.validation.status, "checked");
  const retried = await acceptWith(f, head);
  assert.equal(retried.status, "ACCEPTED", JSON.stringify(retried));
  assert.equal((await f.call("list")).feature.validation.history.filter((h) => h.event === "accepted").length, 1);
});

test("a rerun of the checks leaves an accepted feature alone, and a graph change ends the acceptance", integration, async (t) => {
  const { f, head } = await checkedFeature(t);
  assert.equal((await acceptWith(f, head)).status, "ACCEPTED");
  const accepted = (await f.call("list")).feature.validation;
  // Passing and failing reruns both leave Scaffold exactly as it was.
  const rerun = await f.checks();
  assert.equal(rerun.status, "PASSED", JSON.stringify(rerun));
  assert.deepEqual(rerun.scaffold, { recorded: false, validation_status: "accepted",
    reason: "Already accepted by the user at this head; left unchanged" });
  const failing = await f.checks({ testCommand: [process.execPath, "-e", 'console.log("12 integration tests passed");process.exit(1)'] });
  assert.equal(failing.status, "NEEDS_DESIGN");
  assert.deepEqual((await f.call("list")).feature.validation, accepted);
  // The accepted checks-only result is still the current, applicable one.
  const inspected = await inspectFeatureValidation({ featureId: "F5" }, { directory: f.dir }, f.options);
  assert.deepEqual(inspected.results.map((r) => [r.kind, r.applicable]), [["checks-only", true]]);
  // Any later graph change ends the acceptance; it must be given again for a new result.
  await f.call("design-reopen", { payload: { reason: "Additional work" } });
  const reopened = (await f.call("list")).feature.validation;
  assert.equal(reopened.status, "awaiting_validation");
  assert.equal(reopened.accepted, undefined);
  assert.match((await acceptWith(f, head)).message, /checked or verified/);
});
