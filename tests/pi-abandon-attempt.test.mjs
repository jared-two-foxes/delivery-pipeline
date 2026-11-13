import test from "node:test";
import assert from "node:assert/strict";
import { abandonInflightAttempt } from "../agent/extensions/execute-and-review/abandon-attempt.mjs";

const task = { featureId: "F", taskId: "T", designRef: "sha256:" + "a".repeat(64) };
const REF = "sha256:" + "1".repeat(64);
function setup({ inflight = REF, terminal = [], ageMs = 3 * 3600e3, live = [], stage = "STARTED" } = {}) {
  const calls = { retained: [], events: [] };
  const deps = {
    git: () => "/repo\n",
    requireFeatureAuthorization: async () => {},
    issueFeature: async () => ({ workflow: { instance_id: "i" }, tasks: { T: { delivery: { inflight, revision: 4 } } } }),
    readEvidence: async () => ({ task, attempt: 4, args: { x: 1 }, before: { tree: "b" }, recordedAt: new Date(1e12).toISOString(), result: { stage } }),
    taskReceipts: async () => terminal,
    liveLocks: async () => live,
    now: () => 1e12 + ageMs,
    snapshot: async () => ({ tree: "after", head: "h", digest: "d" }),
    retainAttempt: async (_r, rec) => (calls.retained.push(rec), "sha256:" + "2".repeat(64)),
    deliveryEvent: async (_r, _t, j, ev) => (calls.events.push({ j, ev }), {}),
  };
  return { calls, run: (extra = {}) => abandonInflightAttempt({ task, reason: "connection lost", ...extra }, { directory: "/repo" }, { deps }) };
}

test("closes a dead invocation with an interrupted terminal receipt and releases the journal", async () => {
  const { calls, run } = setup();
  const r = await run();
  assert.equal(r.reason, "INVOCATION_ABANDONED");
  assert.equal(r.evidence.reference, "sha256:" + "2".repeat(64));
  const rec = calls.retained[0];
  assert.equal(rec.attempt, 4);
  assert.equal(rec.startedReference, REF);
  assert.equal(rec.after.tree, "after");
  assert.equal(rec.result.status, "BLOCKED");
  assert.notEqual(rec.result.status, "PASSED");
  assert.deepEqual(calls.events[0].ev, { kind: "finished", started: REF, reference: r.evidence.reference });
});

test("refuses while the invocation may still be running, unless forced", async () => {
  let s = setup({ ageMs: 60e3 });
  assert.equal((await s.run()).reason, "INVOCATION_MAY_BE_RUNNING");
  assert.equal(s.calls.retained.length, 0);
  assert.equal((await s.run({ force: true })).reason, "INVOCATION_ABANDONED");
  s = setup({ live: [{ pid: 42 }] });
  assert.equal((await s.run()).reason, "INVOCATION_MAY_BE_RUNNING");
});

test("defers to an existing terminal receipt and rejects non-start evidence", async () => {
  const t = setup({ terminal: [{ reference: "sha256:" + "3".repeat(64), record: { startedReference: REF } }] });
  assert.equal((await t.run()).reason, "TERMINAL_RECEIPT_EXISTS");
  assert.equal((await setup({ inflight: null }).run()).reason, "NOTHING_IN_FLIGHT");
  assert.equal((await setup({ stage: "EVIDENCE" }).run()).reason, "EVIDENCE_RECOVERY_REQUIRED");
});
