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
} from "../../src/lib/verification/requirements.mjs";
import { deliveryContractItems, renderContext, updateContext } from "../../src/lib/delivery-state/delivery-context.mjs";
import { plannedRequirementEvidence } from "../../src/tools/checkpoint/requirement-evidence.mjs";

const feature = { objective: "Objective", constraints: [] };
const issue = { acceptance_criteria: ["Issue works"], constraints: [] };
const scoped = [
  { id: "SA-1.AC1", text: "Recorded", roles: ["contribute", "verify"] },
  { id: "SA-1.AC2", text: "Displayed elsewhere", roles: [] },
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
  // A requirement assigned to another task is context only: it is not required here, and not satisfied here.
  assert.deepEqual(unverifiedRequirements(deferredRequirements(c).filter((r) => r.roles.length), {}), []);
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
  const added = updateContext(c, [{ kind: "add_obligation", text: "Extra duty", reason: "Found" }], check);
  assert.match(added.context.obligations[0].id, /^obligation-/);
  // An amendment that names a canonical requirement is refused even if it was approved earlier.
  const reference = "sha256:" + "b".repeat(64);
  const approved = new Map([[reference, { reference, ids: ["requirement:SA-1.AC1"], replacement: "Weaker", original: [] }]]);
  assert.throws(() => updateContext(c, [{ kind: "apply_amendment", reference, reason: "Narrow" }], check, true, approved),
    /Canonical feature requirements cannot be amended/);
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
  // Lost a role, gained a requirement, or the text changed: the reviewed scope is not the current one.
  for (const changed of [
    [{ ...current[0], verifiers: ["U"] }, current[1]],
    [current[0], { ...current[1], contributors: ["T"] }],
    [{ ...current[0], text: "Recorded, reworded" }, current[1]],
  ])
    await assert.rejects(plan(changed), /REQUIREMENT_SCOPE_CHANGED/);
  // A review that did not verify the requirement never becomes evidence.
  record.result.conductor.review.obligation_assessments = [assess("requirement:SA-1.AC1", "not_applicable")];
  await assert.rejects(plan(current), /requirement:SA-1\.AC1 \[not_applicable\]/);
});
