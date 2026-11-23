// Design-phase workflow against real Scaffold: structured requirements, explicit task mappings,
// scoped context and actionable coverage gaps, driven only through the shared host-neutral tool.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { designReference } from "../../src/lib/scaffold/contracts.mjs";
import { createScaffoldTools } from "../../src/tools/scaffold/tools.mjs";
import { approveFeatureDirection } from "../../src/tools/scaffold/feature-authorization.mjs";
import { integration } from "../helpers/feature-fixture.mjs";

const Type = new Proxy({}, { get: (_t, kind) => (...args) => ({ kind, args }) });
const [tool] = createScaffoldTools(Type);
const git = (dir, ...args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();

async function workspace(t) {
  const dir = await mkdtemp(path.join(tmpdir(), "pi-requirements-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q", "-b", "main", dir]);
  git(dir, "config", "user.name", "Test");
  git(dir, "config", "user.email", "test@example.invalid");
  git(dir, "commit", "-q", "--allow-empty", "-m", "base");
  git(dir, "switch", "-qc", "feature/req");
  const baseline = git(dir, "rev-parse", "HEAD");
  const call = async (params) => {
    const result = await tool.execute({ feature_id: "SA-1", ...params }, { cwd: dir });
    return { error: result.isError, data: result.details };
  };
  const ok = async (params) => {
    const r = await call(params);
    assert.equal(r.error, false, JSON.stringify(r.data));
    return r.data;
  };
  const context = "Ticket SA-1: record and display activity";
  const feature = (requirements) => ({
    id: "SA-1", title: "Activity", objective: "Record and display activity", context,
    design_ref: "sha256:context", baseline, branch: "feature/req", requirements,
  });
  const requirements = [
    { id: "SA-1.AC1", text: "Activity is recorded", source: "SA-1 acceptance criterion 1" },
    { id: "SA-1.AC2", text: "Activity is displayed", source: "SA-1 acceptance criterion 2" },
  ];
  return { dir, call, ok, context, feature, requirements, baseline };
}
const child = (id, extra) => ({ id, title: id, objective: "Do " + id, acceptance_criteria: [id + " works"], constraints: [], ...extra });
const both = (id) => ({ id, roles: ["contribute", "verify"] });
const record = (disposition) => ({ summary: "Design", verification: "Checks", approval: "Agent-designed", disposition });

test("a fully mapped feature is initialized, revised, approved, decomposed and finished", integration, async (t) => {
  const w = await workspace(t);
  await w.ok({ operation: "init", payload: w.feature(w.requirements) });

  // Pre-approval revision replaces the set by id: AC1 is unchanged, AC2 is reworded, AC3 is new.
  const revised = [w.requirements[0], { ...w.requirements[1], text: "Activity is displayed newest first" },
    { id: "SA-1.AC3", text: "Activity survives restart", source: "user" }];
  await w.ok({ operation: "design-revise", payload: { context: w.context + " (revised)", requirements: revised } });
  const view = await w.ok({ operation: "requirements" });
  assert.deepEqual(view.data.requirements.map((r) => [r.id, r.text]),
    revised.map((r) => [r.id, r.text]), "ids stay stable; nothing is renumbered");

  const approved = await approveFeatureDirection({ featureId: "SA-1" }, { directory: w.dir }, { confirm: async () => true });
  assert.equal(approved.ok, true, JSON.stringify(approved));
  assert.deepEqual(approved.scope.requirements.map((r) => r.id), ["SA-1.AC1", "SA-1.AC2", "SA-1.AC3"]);

  // The single direction approval freezes the requirement set.
  const late = await w.call({ operation: "design-revise", payload: { context: w.context, requirements: revised } });
  assert.equal(late.error, true);
  assert.match(late.data.message, /already approved|frozen/);

  // Decompose with explicit roles; a verifier supports one requirement across contributors.
  const added = await w.ok({ operation: "decompose", task_id: "SA-1", payload: [
    child("store", { requirements: [{ id: "SA-1.AC1", roles: ["contribute"] }, { id: "SA-1.AC3", roles: ["contribute"] }] }),
    child("view", { requirements: [{ id: "SA-1.AC2", roles: ["contribute", "verify"] }], dependencies: ["store"] }),
    child("e2e", { requirements: [{ id: "SA-1.AC1", roles: ["verify"] }, { id: "SA-1.AC3", roles: ["verify"] }], dependencies: ["store", "view"] }),
    child("tooling", { requirements_rationale: "Shared test harness the other issues need" }),
  ] });
  // Nothing is missing, and the compact response says so without a follow-up query.
  assert.equal(added.data.coverage.complete, true);
  assert.deepEqual(added.data.coverage.unmapped, []);

  // Scoped context carries stable ids, text and roles for this issue only.
  const issue = await w.ok({ operation: "issue", task_id: "view" });
  assert.deepEqual(issue.data.context.requirements.map((r) => [r.id, r.roles]), [["SA-1.AC2", ["contribute", "verify"]]]);
  assert.equal(issue.data.context.requirements[0].text, "Activity is displayed newest first");
  assert.deepEqual(issue.data.context.issue.acceptance_criteria, ["view works"], "task-local criteria are preserved");

  await w.ok({ operation: "design-record", task_id: "SA-1", payload: record("decomposed") });
  for (const id of ["store", "view", "e2e", "tooling"]) await w.ok({ operation: "design-record", task_id: id, payload: record("leaf") });
  const finished = await w.ok({ operation: "design-finish" });
  assert.equal(finished.data.phase, "implement");
  const summary = await w.ok({ operation: "summary" });
  assert.equal(summary.data.summary.coverage.complete, true);
  assert.equal(summary.data.summary.requirements.unmapped, 0);
});

test("invalid mappings and a missing verification plan fail with actionable messages", integration, async (t) => {
  const w = await workspace(t);
  await w.ok({ operation: "init", payload: w.feature(w.requirements) });

  // Request-level mistakes are caught before Scaffold runs.
  for (const [payload, message] of [
    [[child("a")], /exactly one of requirements/],
    [[child("a", { requirements: [{ id: "SA-1.AC1", roles: ["build"] }] })], /roles must be/],
    [[child("a", { requirements: [both("SA-1.AC1")], requirements_rationale: "x" })], /exactly one of/],
  ]) {
    const r = await w.call({ operation: "decompose", task_id: "SA-1", payload });
    assert.equal(r.error, true);
    assert.match(r.data.message, message);
  }
  // Scaffold-level mistakes name the offending id.
  const unknown = await w.call({ operation: "decompose", task_id: "SA-1", payload: [child("a", { requirements: [both("SA-1.AC9")] })] });
  assert.equal(unknown.error, true);
  assert.match(unknown.data.message, /SA-1\.AC9/);

  // Only AC1 is mapped, and only by a contributor: the response lists exactly what is missing.
  const partial = await w.ok({ operation: "decompose", task_id: "SA-1", payload: [
    child("a", { requirements: [{ id: "SA-1.AC1", roles: ["contribute"] }] }) ] });
  assert.equal(partial.data.coverage.complete, false);
  assert.deepEqual(partial.data.coverage.unmapped, [
    { id: "SA-1.AC1", missing: ["verify"] }, { id: "SA-1.AC2", missing: ["contribute", "verify"] }]);

  await w.ok({ operation: "design-record", task_id: "SA-1", payload: record("decomposed") });
  await w.ok({ operation: "design-record", task_id: "a", payload: record("leaf") });
  const refused = await w.call({ operation: "design-finish" });
  assert.equal(refused.error, true);
  assert.match(refused.data.message, /Design coverage incomplete/);
  assert.match(refused.data.message, /SA-1\.AC2: missing contributor/);
  assert.match(refused.data.message, /SA-1\.AC1: missing verifier/);

  // Queried directly, the gaps are actionable per requirement.
  const gaps = await w.ok({ operation: "requirements", payload: { unmapped: true } });
  assert.deepEqual(gaps.data.requirements.map((r) => r.id), ["SA-1.AC1", "SA-1.AC2"]);
  assert.deepEqual(gaps.data.requirements[0].missing, ["verify"]);

  // Fixing the mapping is ordinary decomposition in the same design phase: add issues, design them, finish. No extra approval.
  await w.ok({ operation: "decompose", task_id: "SA-1", payload: [
    child("b", { requirements: [both("SA-1.AC2")] }), child("check", { requirements: [{ id: "SA-1.AC1", roles: ["verify"] }], dependencies: ["a"] }) ] });
  await w.ok({ operation: "design-record", task_id: "SA-1", payload: record("decomposed") });
  for (const id of ["a", "b", "check"]) await w.ok({ operation: "design-record", task_id: id, payload: record("leaf") });
  assert.equal((await w.ok({ operation: "design-finish" })).data.phase, "implement");
});

test("legacy criteria and positional ids are refused rather than translated", integration, async (t) => {
  const w = await workspace(t);
  const { requirements, ...rest } = w.feature(w.requirements);
  const legacy = await w.call({ operation: "init", payload: { ...rest, acceptance_criteria: ["Activity is recorded"] } });
  assert.equal(legacy.error, true);
  assert.match(legacy.data.message, /acceptance_criteria no longer exist/);
  const positional = await w.call({ operation: "init", payload: w.feature([{ id: "bad id", text: "x" }]) });
  assert.equal(positional.error, true);
  assert.match(positional.data.message, /must match/);
  assert.equal(designReference("x").length, 71);
});
