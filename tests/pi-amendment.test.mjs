// Pre-execution contract amendments, without a Scaffold install: the Scaffold boundary is replaced by an
// in-memory artifact store. Needs --experimental-test-module-mocks (npm test passes it).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createHash } from "node:crypto";

const skip = !process.execArgv.includes("--experimental-test-module-mocks") &&
  "Requires --experimental-test-module-mocks";

test("a user can override a recorded constraint before the first attempt", { skip }, async (suite) => {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-amend-"));
  suite.after(() => rmSync(dir, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q", "-b", "main", dir]);
  writeFileSync(path.join(dir, "a.txt"), "a\n");
  for (const args of [["config", "user.name", "T"], ["config", "user.email", "t@example.invalid"], ["add", "."], ["commit", "-qm", "base"]])
    execFileSync("git", ["-C", dir, ...args]);

  const task = { featureId: "F", taskId: "T", designRef: "d" };
  const artifacts = new Map();
  let attempts = [];
  let delivery;
  let design = { summary: "Design A" };
  const feature = () => ({
    objective: "Ship it",
    acceptance_criteria: ["Works"],
    constraints: [],
    tasks: { T: { acceptance_criteria: ["Issue works"], constraints: ["Resolve SA-588 final validation first"], attempts, delivery, designs: [design] } },
  });
  suite.mock.module("../agent/lib/scaffold/client.mjs", {
    namedExports: {
      openFeatureIds: async () => ["F"],
      scaffoldCall: async (_repo, params) => {
        if (params.operation === "artifact-put") {
          const reference = "sha256:" + createHash("sha256").update(JSON.stringify(params.payload)).digest("hex");
          artifacts.set(reference, structuredClone(params.payload));
          return { reference };
        }
        if (params.operation === "artifact-get") return { artifact: artifacts.get(params.payload.reference) };
        if (params.operation === "list") return { feature: feature() };
        throw new Error("unexpected " + params.operation);
      },
    },
  });
  suite.mock.module("../agent/extensions/scaffold/adapter.mjs", {
    namedExports: { issueFeature: async () => feature(), scaffoldTasks: async () => ({ ok: true, data: { feature: feature() } }) },
  });
  suite.mock.module("../agent/extensions/scaffold/feature-authorization.mjs", {
    namedExports: { requireFeatureAuthorization: async () => true },
  });
  const { approveDeliveryAmendment, assertPreAttemptAmendmentApplies } = await import("../agent/extensions/execute-and-review/context-amendment.mjs");
  const { authenticateAmendment } = await import("../agent/lib/authorization/amendment.mjs");
  const { deliveryContractItems } = await import("../agent/lib/delivery-state/delivery-context.mjs");

  const items = deliveryContractItems(feature(), feature().tasks.T, task);
  const gate = items.find((i) => i.text.startsWith("Resolve SA-588"));
  assert.ok(gate, "the recorded constraint is a contract item");
  const request = { task, ids: [gate.id], replacement: "SA-588's merged PR and checks are sufficient", reason: "The gate was not in the ticket" };
  const context = { directory: dir };
  const yes = { confirm: async () => true };

  await suite.test("exactly one of previousAttempt or task is required", async () => {
    assert.match((await approveDeliveryAmendment({ ...request, task: undefined }, context, yes)).message, /exactly one of previousAttempt/);
    assert.match(
      (await approveDeliveryAmendment({ ...request, previousAttempt: "sha256:" + "0".repeat(64) }, context, yes)).message,
      /exactly one of previousAttempt/,
    );
  });

  await suite.test("unknown identities are rejected and the available ones listed", async () => {
    const result = await approveDeliveryAmendment({ ...request, ids: ["nope"] }, context, yes);
    assert.equal(result.ok, false);
    assert.match(result.message, /Unknown original.*available: .*Resolve SA-588/);
  });

  await suite.test("declining records nothing", async () => {
    const result = await approveDeliveryAmendment(request, context, { confirm: async () => false });
    assert.match(result.message, /requires user approval/);
    assert.equal(artifacts.size, 0);
  });

  let reference;
  await suite.test("approval shows the original text and retains authority without an attempt receipt", async () => {
    const shown = [];
    const result = await approveDeliveryAmendment(request, context, { confirm: async (scope) => (shown.push(scope), true) });
    assert.equal(result.ok, true, JSON.stringify(result));
    reference = result.reference;
    assert.equal(shown[0].previousAttempt, null);
    assert.deepEqual(shown[0].original, [gate]);
    const amendment = await authenticateAmendment(dir, reference, task);
    assert.deepEqual([amendment.ids, amendment.previousAttempt], [[gate.id], null]);
  });

  await suite.test("the authority is bound to its feature, design and issue", async () => {
    await assert.rejects(authenticateAmendment(dir, reference, { ...task, designRef: "other" }), /matching feature authority/);
    await assert.rejects(authenticateAmendment(dir, reference, { ...task, featureId: "G" }), /matching feature authority/);
    await assert.rejects(authenticateAmendment(dir, reference, { ...task, taskId: "U" }), /no retained originating/);
  });

  await suite.test("an interrupted or running first attempt (in-flight intent) is not 'before the first attempt'", async () => {
    delivery = { inflight: "sha256:" + "2".repeat(64), sequence: 0, revision: 3 };
    assert.match((await approveDeliveryAmendment(request, context, yes)).message, /started or is in flight/);
    delivery = { inflight: null, sequence: 1, revision: 4 };
    assert.match((await approveDeliveryAmendment(request, context, yes)).message, /started or is in flight/);
    delivery = undefined;
  });

  await suite.test("an attempt starting during the confirmation is caught by the re-check", async () => {
    const result = await approveDeliveryAmendment(request, context, {
      confirm: async () => ((delivery = { inflight: "sha256:" + "3".repeat(64), sequence: 0 }), true),
    });
    assert.match(result.message, /started or is in flight/);
    delivery = undefined;
  });

  await suite.test("applying: only the first attempt, and only under the design it was approved with", async () => {
    const amendment = await authenticateAmendment(dir, reference, task);
    assert.equal(typeof amendment.designDigest, "string");
    const issue = feature().tasks.T;
    assertPreAttemptAmendmentApplies(amendment, { issue, previous: undefined });
    assertPreAttemptAmendmentApplies(amendment, { issue, previous: { kind: "issue-zero-handoff" } });
    assert.throws(() => assertPreAttemptAmendmentApplies(amendment, { issue, previous: { kind: "task-attempt" } }),
      /only to the first attempt/);
    design = { summary: "Design B" };
    assert.throws(() => assertPreAttemptAmendmentApplies(amendment, { issue: feature().tasks.T, previous: undefined }),
      /design changed/);
    design = { summary: "Design A" };
  });

  await suite.test("once an attempt exists the pre-execution form is refused", async () => {
    attempts = [{ receipt: "sha256:" + "1".repeat(64), status: "NEEDS_DESIGN" }];
    artifacts.set(attempts[0].receipt, { schema: "pi.task-attempt/v1", repository: dir, task, attempt: 1 });
    const result = await approveDeliveryAmendment(request, context, yes);
    assert.equal(result.ok, false);
    assert.match(result.message, /already has attempts/);
  });
});
