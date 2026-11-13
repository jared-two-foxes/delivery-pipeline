import test from "node:test";
import assert from "node:assert/strict";
import { renderContext } from "../agent/lib/delivery-state/delivery-context.mjs";
import { reconcileExternalChanges, changedPaths } from "../agent/extensions/execute-and-review/reconcile-attempt.mjs";

const task = { featureId: "F", taskId: "T", designRef: "sha256:" + "a".repeat(64) };
const PREV = "sha256:" + "1".repeat(64);
const sha = (c) => c.repeat(40);
const after = { head: sha("b"), tree: sha("c"), digest: "old", clean: false, bookkeepingVisible: false };
const now = { ...after, tree: sha("d"), digest: "new" };

function setup({ kind, baseRef = after.head, journal = { head: PREV, revision: 3 }, status = "NEEDS_DESIGN", snap = now, approve = true, paths } = {}) {
  const calls = { retained: [], attempts: [], events: [], confirms: [] };
  const previous = { kind, attempt: 8, args: { task, baseRef, deliveryContext: { schema: "pi.delivery-context/v1", original: "o", design: { reference: "d", summary: "s", verification: "v", approval: "a" }, obligations: [], updates: [], contractItems: [] }, requirements: "handoff recovery text", input: "ops", previousAttempt: "p" }, after, result: { status } };
  const deps = {
    git: () => "/repo\n",
    requireFeatureAuthorization: async () => {},
    issueFeature: async () => ({ workflow: { instance_id: "i" }, tasks: { T: { delivery: journal } } }),
    authenticateAttemptChain: async () => ({ record: previous, records: [previous] }),
    assertLatestAttempt: async () => {},
    snapshot: async () => snap,
    changedPaths: () => paths ?? { total: 1, paths: ["D\t.scaffold.zip"] },
    confirm: async (s) => (calls.confirms.push(s), approve),
    retainEvidence: async (_r, rec) => (calls.retained.push(rec), "sha256:" + "2".repeat(64)),
    retainAttempt: async (_r, rec) => (calls.attempts.push(rec), "sha256:" + "3".repeat(64)),
    deliveryEvent: async (_r, _t, j, ev) => (calls.events.push(ev), { ...j, head: ev.reference ?? j.head }),
  };
  return { calls, run: (extra = {}) => reconcileExternalChanges({ task, previousAttempt: PREV, reason: "user removed archive", ...extra }, { directory: "/repo" }, { deps }) };
}

test("records an authenticated receipt that chains from the previous after-snapshot to the current tree", async () => {
  const { calls, run } = setup();
  const r = await run();
  assert.equal(r.reason, "EXTERNAL_CHANGES_RECONCILED");
  assert.equal(r.evidence.reference, "sha256:" + "3".repeat(64));
  const rec = calls.attempts[0];
  assert.equal(rec.attempt, 9);
  assert.deepEqual(rec.before, after, "starts where the previous receipt ended (chain rule)");
  assert.deepEqual(rec.after, now, "ends at the current tree");
  assert.equal(rec.args.previousAttempt, PREV);
  assert.equal(rec.args.baseRef, after.head);
  assert.notEqual(rec.args.requirements, "handoff recovery text", "requirements are re-rendered from the context so validContextContinuation holds");
  assert.equal(rec.args.requirements, renderContext(rec.args.deliveryContext));
  assert.equal("input" in rec.args, false, "no operations are inherited");
  assert.equal(rec.result.status, "BLOCKED");
  assert.notEqual(rec.result.status, "PASSED");
  assert.deepEqual(rec.result.external.changes.paths, ["D\t.scaffold.zip"]);
  const started = calls.retained[0];
  assert.deepEqual(started.before, after, "an abandoned reconciliation must still chain from the previous receipt");
  assert.deepEqual(started.after, now);
  assert.deepEqual(calls.events.map((e) => e.kind), ["begun", "finished"]);
  assert.equal(calls.events[0].sequence, 9);
  assert.equal(calls.events[0].previous, PREV);
  assert.match(calls.confirms[0].message, /\.scaffold\.zip/);
});

test("nothing is written without confirmation", async () => {
  const s = setup({ approve: false });
  assert.equal((await s.run()).reason, "CANCELLED");
  assert.equal(s.calls.retained.length + s.calls.attempts.length + s.calls.events.length, 0);
});

test("refuses unsafe or pointless reconciliations", async () => {
  assert.equal((await setup({ snap: after }).run()).reason, "NOTHING_TO_RECONCILE");
  assert.equal((await setup({ snap: { ...now, head: sha("e") } }).run()).reason, "HEAD_CHANGED");
  assert.equal((await setup({ snap: { ...now, bookkeepingVisible: true } }).run()).reason, "SCAFFOLD_REVIEW_SCOPE");
  assert.equal((await setup({ status: "PASSED" }).run()).reason, "CONTINUATION_RECEIPT_INAPPLICABLE");
  assert.equal((await setup({ kind: "issue-zero-handoff" }).run()).reason, "UNSUPPORTED_ZERO_ATTEMPT");
  assert.equal((await setup({ baseRef: sha("f") }).run()).reason, "HEAD_CHANGED", "a HEAD_CHANGED receipt ends away from its baseline");
  assert.equal((await setup({ journal: { head: PREV, inflight: "x" } }).run()).reason, "INVOCATION_RECOVERY_REQUIRED");
  assert.equal((await setup({ journal: { head: "sha256:" + "9".repeat(64) } }).run()).reason, "CONTINUATION_RECEIPT_STALE");
  assert.equal((await setup({ journal: null }).run()).reason, "NOT_STARTED");
  assert.equal((await setup().run({ reason: " " })).reason, "INVALID_ARGUMENTS");
});

test("a tree that moves during confirmation is rejected", async () => {
  const s = setup();
  let n = 0;
  const base = s.run;
  const snaps = [now, { ...now, digest: "moved" }];
  const r = await reconcileExternalChanges({ task, previousAttempt: PREV, reason: "x" }, { directory: "/repo" }, {
    deps: {
      git: () => "/repo", requireFeatureAuthorization: async () => {},
      issueFeature: async () => ({ tasks: { T: { delivery: { head: PREV } } } }),
      authenticateAttemptChain: async () => ({ record: { attempt: 8, args: { task, baseRef: after.head }, after, result: { status: "BLOCKED" } } }),
      assertLatestAttempt: async () => {}, snapshot: async () => snaps[Math.min(n++, 1)],
      changedPaths: () => null, confirm: async () => true,
    },
  });
  assert.equal(r.reason, "REPOSITORY_CHANGED");
  void base;
});

test("changedPaths lists differing paths and tolerates unreadable trees", () => {
  assert.deepEqual(changedPaths("/r", "a", "b", () => "D\tx\nA\ty\n"), { total: 2, paths: ["D\tx", "A\ty"] });
  assert.equal(changedPaths("/r", "a", "b", () => { throw new Error("bad object"); }), null);
});
