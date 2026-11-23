// Design-phase workflow against real Scaffold: structured requirements, explicit task mappings,
// scoped context and actionable coverage gaps, driven only through the shared host-neutral tool.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { designReference } from "../../src/lib/scaffold/contracts.mjs";
import { createScaffoldTools } from "../../src/tools/scaffold/tools.mjs";
import { approveFeatureDirection } from "../../src/tools/scaffold/feature-authorization.mjs";
import { integration } from "../helpers/feature-fixture.mjs";
import { scopedRequirements } from "../../src/tools/execute-and-review/delivery-context.mjs";
import { deliveryContractItems } from "../../src/lib/delivery-state/delivery-context.mjs";

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

  // Delivery consumes Scaffold's task-scoped output: each task sees only its requirements and roles.
  const feature = (await w.ok({ operation: "list" })).data.feature;
  const binding = (taskId) => ({ featureId: "SA-1", taskId, designRef: feature.design_ref });
  const scoped = {};
  for (const id of ["store", "view", "e2e", "tooling"]) {
    scoped[id] = await scopedRequirements(w.dir, binding(id));
    const items = deliveryContractItems(feature, feature.tasks[id], binding(id), scoped[id])
      .filter((item) => item.requirement);
    // Stable Scaffold ids flow straight into the review obligations: never positions, never text digests.
    assert.deepEqual(items.map((item) => [item.id, item.text, item.roles]),
      scoped[id].map((r) => ["requirement:" + r.id, r.text, r.roles]));
  }
  assert.deepEqual(Object.fromEntries(Object.entries(scoped).map(([id, list]) => [id, list.map((r) => [r.id, r.roles])])), {
    store: [["SA-1.AC1", ["contribute"]], ["SA-1.AC3", ["contribute"]]],
    view: [["SA-1.AC2", ["contribute", "verify"]]],
    e2e: [["SA-1.AC1", ["verify"]], ["SA-1.AC3", ["verify"]]],
    tooling: [],
  });
  assert.equal(summary.data.summary.requirements.unmapped, 0);
});

test("invalid mappings and a missing verification plan fail with actionable messages", integration, async (t) => {
  const w = await workspace(t);
  await w.ok({ operation: "init", payload: w.feature(w.requirements) });

  // Request-level mistakes are caught before Scaffold runs.
  for (const [payload, message] of [
    [[child("a")], /exactly one of requirements/],
    [[child("a", { requirements: [{ id: "SA-1.AC1", roles: ["contribute"] }] }), child("b", { requirements: [{ id: "SA-1.AC2", roles: ["build"] }] })],
      /Task b link SA-1\.AC2: invalid role "build"/],
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

test("a revision that drops and reorders requirements keeps every surviving id and never renumbers", integration, async (t) => {
  const w = await workspace(t);
  const original = [...w.requirements, { id: "SA-1.AC3", text: "Activity survives restart", source: "SA-1 acceptance criterion 3" }];
  await w.ok({ operation: "init", payload: w.feature(original) });

  // Drop AC1 and supply the rest in a different order. Positional ids would make AC2 "first" here.
  const revised = [original[2], { ...original[1], text: "Activity is displayed newest first" }];
  await w.ok({ operation: "design-revise", payload: { context: w.context + " (AC1 dropped)", requirements: revised } });
  const view = await w.ok({ operation: "requirements" });
  assert.deepEqual(view.data.requirements.map(({ id, text, source }) => ({ id, text, source })), [
    { id: "SA-1.AC2", text: "Activity is displayed newest first", source: "SA-1 acceptance criterion 2" },
    { id: "SA-1.AC3", text: "Activity survives restart", source: "SA-1 acceptance criterion 3" },
  ]);
  // The dropped id cannot come back under a new meaning.
  const reused = await w.call({ operation: "design-revise", payload: { context: w.context + " (AC1 reused)",
    requirements: [...revised, { id: "SA-1.AC1", text: "Something else" }] } });
  assert.equal(reused.error, true);
  assert.match(reused.data.message, /SA-1\.AC1/);

  const approved = await approveFeatureDirection({ featureId: "SA-1" }, { directory: w.dir }, { confirm: async () => true });
  assert.equal(approved.ok, true, JSON.stringify(approved));

  // A link to the dropped id is unknown; the surviving ids decompose and finish.
  const stale = await w.call({ operation: "decompose", task_id: "SA-1", payload: [child("old", { requirements: [both("SA-1.AC1")] })] });
  assert.equal(stale.error, true);
  assert.match(stale.data.message, /unknown requirement ids: SA-1\.AC1/);
  const added = await w.ok({ operation: "decompose", task_id: "SA-1", payload: [
    child("view", { requirements: [both("SA-1.AC2")] }), child("persist", { requirements: [both("SA-1.AC3")] }) ] });
  assert.equal(added.data.coverage.complete, true);
  await w.ok({ operation: "design-record", task_id: "SA-1", payload: record("decomposed") });
  for (const id of ["view", "persist"]) await w.ok({ operation: "design-record", task_id: id, payload: record("leaf") });
  assert.equal((await w.ok({ operation: "design-finish" })).data.phase, "implement");
  const issue = await w.ok({ operation: "issue", task_id: "persist" });
  assert.deepEqual(issue.data.context.requirements.map((r) => [r.id, r.text, r.roles]),
    [["SA-1.AC3", "Activity survives restart", ["contribute", "verify"]]]);
});

test("legacy criteria are refused rather than translated into generated ids", integration, async (t) => {
  const w = await workspace(t);
  const { requirements, ...rest } = w.feature(w.requirements);
  const legacy = { ...rest, acceptance_criteria: ["Activity is recorded", "Activity is displayed"] };
  const refused = await w.call({ operation: "init", payload: legacy });
  assert.equal(refused.error, true);
  assert.match(refused.data.message, /acceptance_criteria no longer exist/);
  // Supplying both is refused as well: criteria are never merged into, or alongside, requirements.
  const mixed = await w.call({ operation: "init", payload: { ...legacy, requirements } });
  assert.equal(mixed.error, true);
  assert.match(mixed.data.message, /acceptance_criteria no longer exist/);
  // Nothing was created, so no generated R1/R2 (or any other) ids exist anywhere.
  const summary = await w.call({ operation: "summary" });
  assert.equal(summary.error, true);
  assert.match(summary.data.message, /Unknown feature/);
  // Scaffold itself refuses the legacy shape too: there is no translation path below the adapter.
  const direct = spawnSync("scaffold", ["init", "--feature=SA-1", "--input", "-"],
    { cwd: w.dir, input: JSON.stringify({ ...legacy, design_ref: designReference(w.context) }), encoding: "utf8" });
  assert.notEqual(direct.status, 0);
  assert.match(direct.stderr, /acceptance_criteria are replaced by requirements/);
  assert.equal((await w.call({ operation: "summary" })).error, true);
});

test("malformed requirement ids are refused by the id syntax check", integration, async (t) => {
  const w = await workspace(t);
  for (const id of ["bad id", "-leading", "", "a/b"]) {
    const r = await w.call({ operation: "init", payload: w.feature([{ id, text: "x" }]) });
    assert.equal(r.error, true, id);
    assert.match(r.data.message, /must match/);
  }
  assert.equal(designReference("x"), "sha256:2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881");
});
