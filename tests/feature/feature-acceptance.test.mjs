import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFile, readdir, mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import {
  validateFeature,
  runFeatureChecks,
  inspectFeatureValidation,
} from "../../src/tools/feature-validation/feature.mjs";
import { acceptFeature } from "../../src/tools/feature-validation/acceptance.mjs";
import { integration, fixture, finishedFeature } from "../helpers/feature-fixture.mjs";

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
