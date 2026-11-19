import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFile, readdir, mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { invoke } from "../../src/lib/scaffold/process.mjs";
import { readFeatureEvidence } from "../../src/lib/evidence/store.mjs";
import {
  validateFeature,
  runFeatureChecks,
  inspectFeatureValidation,
} from "../../src/tools/feature-validation/feature.mjs";
import { runCheck } from "../../src/tools/feature-validation/check-process.mjs";
import { artifactPath, integration, fixture, finished } from "../helpers/feature-fixture.mjs";

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
  "ignored generated outputs pass, and invalid review plans run no commands",
  integration,
  async (t) => {
    const f = await fixture(t);
    await f.add("one");
    await f.finish("one");
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
  const { approvedDesign } = await import("../../src/lib/verification/feature.mjs");
  assert.throws(() => approvedDesign("/unused", {
    context: "Original approved design", design_ref: "approved.md@" + "a".repeat(40),
  }), /design|context/i);
});
