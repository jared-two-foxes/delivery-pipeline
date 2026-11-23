import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  requirementBinding,
  requirementObligationId,
  taskRoles,
  unverifiedRequirements,
  requiredRequirements,
  deferredRequirements,
  requirementItems,
} from "../../src/lib/verification/requirements.mjs";
import { deliveryContractItems, refreshRequirementItems, renderContext, updateContext } from "../../src/lib/delivery-state/delivery-context.mjs";
import { hash } from "../../src/lib/delivery-state/context-digest.mjs";
import { plannedRequirementEvidence, planRebinding } from "../../src/tools/checkpoint/requirement-evidence.mjs";

const feature = { objective: "Objective", constraints: [] };
const issue = { acceptance_criteria: ["Issue works"], constraints: [] };
const scoped = [
  { id: "SA-1.AC1", text: "Recorded", roles: ["contribute", "verify"], contributors: ["T"], verifiers: ["T"] },
  { id: "SA-1.AC2", text: "Displayed elsewhere", roles: [], contributors: ["U"], verifiers: ["U"] },
];
const context = () => ({
  schema: "pi.delivery-context/v1",
  original: "Original",
  design: { reference: "sha256:" + "a".repeat(64), summary: "s", verification: "v", approval: "a" },
  obligations: [],
  updates: [],
  contractItems: deliveryContractItems(feature, issue, { taskId: "T" }, scoped),
});
const check = [{ name: "test", command: ["node", "-e", "console.log('1 test passed')"] }];
const assess = (id, disposition, evidence = "Inspected the change") => ({ obligation_id: id, disposition, evidence });

test("the evidence binding is byte-for-byte Scaffold's digest", (t) => {
  const source = process.env.SCAFFOLD_SOURCE;
  const holders = [
    ["R1", { contributors: ["a", "b"], verifiers: ["c"] }],
    ["SA-1.AC2", { contributors: [], verifiers: ["déjà"] }],
  ];
  if (!source) return t.skip("Set SCAFFOLD_SOURCE to compare with Scaffold's own implementation");
  for (const [id, sets] of holders) {
    const python = spawnSync(process.platform === "win32" ? "python" : "python3", ["-c",
      "import sys,json; sys.path.insert(0, sys.argv[1]); from ticket_pipeline.lib import evidence; " +
      "r=json.loads(sys.argv[2]); print(evidence.binding({'requirements': {r['id']: r['sets']}}, r['id']))",
      path.join(source, "src"), JSON.stringify({ id, sets })], { encoding: "utf8" });
    assert.equal(python.status, 0, python.stderr);
    assert.equal(requirementBinding(id, sets), python.stdout.trim());
  }
});

test("roles come from Scaffold's contributor and verifier sets, so a childless root owns every requirement", () => {
  assert.deepEqual(taskRoles({ roles: [], contributors: ["F"], verifiers: ["F"] }, "F"), ["contribute", "verify"]);
  assert.deepEqual(taskRoles({ roles: [], contributors: ["a"], verifiers: ["b"] }, "F"), []);
  assert.deepEqual(taskRoles({ roles: ["verify"], contributors: ["a"], verifiers: ["b"] }, "b"), ["verify"]);
  assert.deepEqual(taskRoles({ roles: ["verify", "contribute"] }, "x"), ["contribute", "verify"]);
});

test("required requirements need an explicit verified assessment by their stable id", () => {
  const c = context();
  const required = requiredRequirements(c);
  assert.deepEqual(required.map((r) => r.id), ["requirement:SA-1.AC1"]);
  assert.deepEqual(deferredRequirements(c).map((r) => r.id), ["requirement:SA-1.AC2"]);
  const open = (assessments) => unverifiedRequirements(required, { obligation_assessments: assessments }).map((r) => r.assessed);
  assert.deepEqual(open([assess("requirement:SA-1.AC1", "verified")]), []);
  assert.deepEqual(open([]), ["not assessed"]);
  // The bare ticket id, a positional id or a sibling id never closes it.
  assert.deepEqual(open([assess("SA-1.AC1", "verified"), assess("feature_criterion_0", "verified")]), ["not assessed"]);
  assert.deepEqual(open([assess("requirement:SA-1.AC1", "not_applicable")]), ["not_applicable"]);
  assert.deepEqual(open([assess("requirement:SA-1.AC1", "unresolved")]), ["unresolved"]);
  assert.deepEqual(open([{ obligation_id: "requirement:SA-1.AC1", disposition: "verified", evidence: " " }]),
    ["verified without evidence"]);
});

test("a requirement assigned to another task is neither required nor satisfied by this one", () => {
  const c = context();
  const required = requiredRequirements(c);
  const deferred = deferredRequirements(c);
  assert.deepEqual(deferred.map((r) => [r.id, r.roles]), [["requirement:SA-1.AC2", []]]);
  // Not required: a review that assesses only this task's requirement passes the per-id gate, and one that
  // assesses only the deferred requirement does not.
  assert.deepEqual(unverifiedRequirements(required, { obligation_assessments: [assess("requirement:SA-1.AC1", "verified")] }), []);
  assert.deepEqual(unverifiedRequirements(required, { obligation_assessments: [assess("requirement:SA-1.AC2", "verified")] })
    .map((r) => [r.id, r.assessed]), [["requirement:SA-1.AC1", "not assessed"]]);
  // Not satisfied: the deferred requirement is outside the required set, so even a verified assessment of it
  // never becomes evidence for this task (see the finalization test below, which plans associations only for
  // SA-1.AC1), and Scaffold keeps it outstanding until its own holder records evidence.
  assert.ok(!required.some((r) => r.requirement === "SA-1.AC2"));
});

test("with several requirements, one bad assessment is enough to block, and it is the one named", () => {
  const items = ["A", "B", "C"].map((id) => ({ id: "requirement:" + id, requirement: id }));
  const good = items.map((i) => assess(i.id, "verified"));
  assert.deepEqual(unverifiedRequirements(items, { obligation_assessments: good }), []);
  for (const [bad, shown] of [
    [good.filter((a) => a.obligation_id !== "requirement:B"), "not assessed"],
    [good.map((a) => a.obligation_id === "requirement:B" ? { ...a, obligation_id: "requirement:b" } : a), "not assessed"],
    [good.map((a) => a.obligation_id === "requirement:B" ? { ...a, disposition: "unresolved" } : a), "unresolved"],
    [good.map((a) => a.obligation_id === "requirement:B" ? { ...a, evidence: "" } : a), "verified without evidence"],
  ])
    assert.deepEqual(unverifiedRequirements(items, { obligation_assessments: bad }).map((r) => [r.id, r.assessed]),
      [["requirement:B", shown]]);
});

test("the rendered context names the required and deferred requirement ids and the assessment rule", () => {
  const rendered = renderContext(context());
  const json = JSON.parse(rendered.split("\n").find((l) => l.startsWith('{"design":')));
  assert.deepEqual(json.requirements, [{ id: "requirement:SA-1.AC1", text: "Recorded", roles: ["contribute", "verify"] }]);
  assert.deepEqual(json.deferredRequirements, ["requirement:SA-1.AC2"]);
  assert.match(rendered, /Assess EACH requirement id in obligation_assessments with disposition `verified`/);
  assert.match(rendered, /`not_applicable` cannot waive required work/);
  assert.match(rendered, /assigned to other tasks: they are context only/);
});

test("dynamic obligations can never reuse or shadow a canonical requirement or original contract item", () => {
  const c = context();
  for (const id of ["requirement:SA-1.AC1", "requirement:NEW", c.contractItems[0].id])
    assert.throws(() => updateContext(c, [{ kind: "add_obligation", id, text: "Extra duty", reason: "Found" }], check),
      /collides with a canonical requirement/);
  for (const id of ["finding-abc", "check-abc", "amendment-abc"])
    assert.throws(() => updateContext(c, [{ kind: "add_obligation", id, text: "Extra duty", reason: "Found" }], check),
      /reserved namespace/);
  const added = updateContext(c, [{ kind: "add_obligation", text: "Extra duty", reason: "Found" }], check);
  assert.match(added.context.obligations[0].id, /^obligation-/);
  // An amendment that names a canonical requirement is refused even if it was approved earlier.
  const reference = "sha256:" + "b".repeat(64);
  const approved = new Map([[reference, { reference, ids: ["requirement:SA-1.AC1"], replacement: "Weaker", original: [] }]]);
  assert.throws(() => updateContext(c, [{ kind: "apply_amendment", reference, reason: "Narrow" }], check, true, approved),
    /Canonical feature requirements cannot be amended/);
  // An amendment's generated id can never land on an obligation that already uses it.
  const criterion = c.contractItems.find((i) => i.id.startsWith("issue_criterion_"));
  const lawful = new Map([[reference, { reference, ids: [criterion.id], replacement: "Narrower", original: [criterion] }]]);
  const taken = structuredClone(c);
  taken.obligations.push({ id: "amendment-" + hash(reference).slice(0, 24), text: "Squatter", status: "open", source: "discovery" });
  assert.throws(() => updateContext(taken, [{ kind: "apply_amendment", reference, reason: "Narrow" }], check, true, lawful),
    /Duplicate obligation identity: amendment-/);
  assert.equal(updateContext(c, [{ kind: "apply_amendment", reference, reason: "Narrow" }], check, true, lawful)
    .context.obligations.at(-1).text, "Narrower");
});

test("a persisted context takes Scaffold's current requirements and retains the change", () => {
  const c = context();
  assert.equal(refreshRequirementItems(c, scoped), c, "unchanged mapping leaves the context alone");
  const redesigned = [{ ...scoped[0], verifiers: ["T", "V"] }, { ...scoped[1], roles: ["verify"], verifiers: ["T", "U"] },
    { id: "SA-1.AC3", text: "New", roles: ["contribute"], contributors: ["T"], verifiers: ["V"] }];
  const next = refreshRequirementItems(c, redesigned);
  assert.deepEqual(requirementItems(next).map((i) => [i.id, i.roles, i.binding]),
    redesigned.map((r) => ["requirement:" + r.id, r.roles, requirementBinding(r.id, r)]));
  // Other items, the original text, obligations and earlier updates are untouched; the change is recorded.
  assert.deepEqual(next.contractItems.filter((i) => !i.requirement), c.contractItems.filter((i) => !i.requirement));
  assert.equal(next.original, c.original);
  assert.deepEqual(next.updates.map((u) => u.kind), ["revise_requirements"]);
  assert.deepEqual(c.updates, [], "the persisted context itself is not mutated");
});

test("finalization refuses evidence when Scaffold's mapping no longer matches what the review assessed", async (t) => {
  const repository = await mkdtemp(path.join(tmpdir(), "pi-requirement-evidence-"));
  t.after(() => rm(repository, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q", repository]);
  const c = context();
  const record = {
    task: { featureId: "F", taskId: "T", designRef: "sha256:" + "c".repeat(64) },
    attempt: 1,
    after: { tree: "d".repeat(40) },
    args: { deliveryContext: c },
    result: { conductor: { review: { review_id: "r", status: "APPROVED",
      obligation_assessments: [assess("requirement:SA-1.AC1", "verified")] } } },
  };
  const scaffoldFeature = { id: "F", workflow: { instance_id: "i" },
    tasks: { T: { designs: [{ reference: "sha256:" + "e".repeat(64) }] } } };
  const summary = { id: "F", design_ref: "sha256:" + "c".repeat(64), phase: "implement", task_revision: 1, state_digest: "a".repeat(64),
    counts: {}, baseline: "a".repeat(40), branch: "feature/x", coverage: { problems: [] }, requirements: {} };
  const respond = (requirements) => async () => ({ code: 0, stderr: "", stdout: JSON.stringify({ schema_version: 3, summary, context: {
    schema: "scaffold.issue-context/v1", feature: summary, ancestors: [], prerequisites: [], children: [], requirements,
    issue: { id: "T", objective: "o", acceptance_criteria: ["Issue works"], dependencies: [], constraints: [], status: "in_progress" },
  } }) });
  const plan = (requirements) => plannedRequirementEvidence(repository, scaffoldFeature, record, "sha256:" + "f".repeat(64),
    { scaffoldOptions: { invokeScaffold: respond(requirements) } });

  const current = [
    { id: "SA-1.AC1", text: "Recorded", roles: ["contribute", "verify"], contributors: ["T"], verifiers: ["T"] },
    { id: "SA-1.AC2", text: "Displayed elsewhere", roles: [], contributors: ["U"], verifiers: ["U"] },
  ];
  const planned = await plan(current);
  assert.deepEqual(planned.map((p) => [p.association.requirement, p.association.role, p.association.basis]),
    [["SA-1.AC1", "contribute", "independent-review"], ["SA-1.AC1", "verify", "independent-review"]]);
  assert.equal(planned[0].association.binding, requirementBinding("SA-1.AC1", { contributors: ["T"], verifiers: ["T"] }));
  assert.equal(planned[0].artifact.review.obligation_id, requirementObligationId("SA-1.AC1"));
  // Lost a role, gained a requirement, the text changed, or ANOTHER task became a holder while this task's
  // roles stayed the same: the reviewed scope (including its binding) is not the current one.
  for (const changed of [
    [{ ...current[0], verifiers: ["U"] }, current[1]],
    [current[0], { ...current[1], contributors: ["T"] }],
    [{ ...current[0], text: "Recorded, reworded" }, current[1]],
    [{ ...current[0], contributors: ["T", "V"] }, current[1]],
    [{ ...current[0], verifiers: ["T", "V"] }, current[1]],
  ])
    await assert.rejects(plan(changed), /REQUIREMENT_SCOPE_CHANGED/);
  // A review that did not verify the requirement never becomes evidence.
  record.result.conductor.review.obligation_assessments = [assess("requirement:SA-1.AC1", "not_applicable")];
  await assert.rejects(plan(current), /requirement:SA-1\.AC1 \[not_applicable\]/);
});

test("re-binding refuses every association that no longer applies, and says why", async () => {
  const R = "sha256:" + "1".repeat(64), D = "sha256:" + "2".repeat(64), TREE = "3".repeat(40);
  const holders = { contributors: ["T"], verifiers: ["T", "U"] };
  const base = () => ({
    feature: {
      id: "F", design_ref: "sha256:" + "4".repeat(64), workflow: { instance_id: "i" },
      tasks: { T: { id: "T", status: "completed", history: [{ evidence: { reference: R } }], designs: [{ reference: D }], checkpoint: { tree: TREE } } },
      evidence: ["contribute", "verify"].map((role) => ({ task_id: "T", requirement: "R1", role, receipt: R, tree: TREE, design: D,
        binding: requirementBinding("R1", { contributors: ["T"], verifiers: ["T"] }), basis: "independent-review", reference: "sha256:" + "5".repeat(64) })),
    },
    view: { requirements: [{ id: "R1", contributors: holders.contributors.map((id) => ({ id })), verifiers: holders.verifiers.map((id) => ({ id })) }] },
    record: {
      args: { deliveryContext: { contractItems: [{ id: "requirement:R1", requirement: "R1", text: "x", roles: ["contribute", "verify"] }] } },
      result: { conductor: { review: { review_id: "r", obligation_assessments: [assess("requirement:R1", "verified")] } } },
    },
  });
  const plan = async (change = () => {}, authenticate) => {
    const c = base();
    change(c);
    return planRebinding("/repo", c.feature, c.view, authenticate ?? (async () => c.record));
  };
  const reasons = (outcome) => [outcome.plan.length, [...new Set(outcome.skipped.map((s) => s.reason))]];

  const ok = await plan();
  assert.deepEqual(ok.plan.map((p) => [p.entry.role, p.binding]), ["contribute", "verify"].map((r) => [r, requirementBinding("R1", holders)]));
  assert.deepEqual(ok.skipped, []);
  // Already current, or never the completing attempt: nothing to do and nothing to report.
  assert.deepEqual(reasons(await plan((c) => { for (const e of c.feature.evidence) e.binding = requirementBinding("R1", holders); })), [0, []]);
  assert.deepEqual(reasons(await plan((c) => { c.feature.tasks.T.history = [{ evidence: { reference: "sha256:" + "6".repeat(64) } }]; })), [0, []]);
  // Each safety check, on its own, refuses with its reason.
  assert.deepEqual(reasons(await plan((c) => { c.feature.tasks.T.designs.push({ reference: "sha256:" + "7".repeat(64) }); })),
    [0, ["the task's design changed"]]);
  const lost = await plan((c) => { c.view.requirements[0].verifiers = [{ id: "U" }]; });
  assert.deepEqual(lost.skipped.map((s) => [s.role, s.reason]), [["verify", "the task no longer holds this role"]]);
  assert.deepEqual(lost.plan.map((p) => p.entry.role), ["contribute"]);
  assert.deepEqual(reasons(await plan((c) => { c.feature.tasks.T.checkpoint.tree = "8".repeat(40); })),
    [0, ["the checkpoint tree was rewritten after this association"]]);
  const forged = await plan(undefined, async () => { throw new Error("Task/design identity mismatch"); });
  assert.deepEqual(reasons(forged), [0, ["the completing receipt no longer authenticates: Task/design identity mismatch"]]);
  assert.deepEqual(reasons(await plan((c) => { c.record.result.conductor.review.obligation_assessments = [assess("requirement:R1", "not_applicable")]; })),
    [0, ["the retained review did not verify this requirement in this role"]]);
  const narrower = await plan((c) => { c.record.args.deliveryContext.contractItems[0].roles = ["contribute"]; });
  assert.deepEqual(narrower.skipped.map((s) => [s.role, s.reason]), [["verify", "the retained review did not verify this requirement in this role"]]);
});
