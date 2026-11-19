import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFile, readdir, mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { snapshot } from "../../src/lib/git/snapshot.mjs";
import { readFeatureEvidence } from "../../src/lib/evidence/store.mjs";
import {
  validateFeature,
  runFeatureChecks,
  inspectFeatureValidation,
} from "../../src/tools/feature-validation/feature.mjs";
import { integration, fixture, finishedFeature, exists, finished } from "../helpers/feature-fixture.mjs";

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

test("run_feature_checks blocks source edited while a check runs, and keeps diagnostics", integration, async (t) => {
  const passing = 'console.log("12 integration tests passed")';
  const variants = {
    edited: `require("fs").writeFileSync("source.txt","changed");${passing}`,
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
