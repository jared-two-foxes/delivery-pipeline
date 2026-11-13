import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const read = p => readFileSync(path.join(root, p), 'utf8');

test('feature initialization owns the single direction approval and design-finish', () => {
  const init = read('agent/skills/init-feature/SKILL.md');
  const delivery = read('agent/skills/feature-delivery/SKILL.md');
  const system = read('delivery-rules.md');
  for (const phrase of ['linear_get_ticket', 'scaffold_tasks', 'approve_feature_direction',
    'design-record', 'design-finish', 'summary', 'existing', 'baseline', 'branch']) {
    assert.ok(init.includes(phrase), phrase);
  }
  assert.match(init, /do not ask the\s+user to approve individual issue designs/);
  assert.match(init, /across sessions|session changes/);
  assert.match(init, /never.*execute_and_review|never.*calls.*execute_and_review/is);
  assert.match(delivery, /\/skill:init-feature/);
  assert.match(delivery, /execute_and_review/);
  assert.match(delivery, /design-finish/);
  assert.match(system, /Only native `execute_and_review`/);
});


test('Pi workflow guidance retains implementation gates without blanket publishing bans', () => {
  for (const name of [
    'delivery-rules.md',
    'agent/skills/feature-delivery/SKILL.md',
    'agent/skills/implement-task/SKILL.md',
  ]) {
    const text = read(name).replace(/\s+/g, ' ');
    assert.match(text, /Git\/GitHub publishing|Git and GitHub publishing/, name);
    assert.match(text, /active (?:implementation )?(?:verification\/correction loop|correction epoch)/, name);
    assert.match(text, /[Nn]ever merge PRs/, name);
    assert.match(text, /source edits/, name);
    assert.doesNotMatch(text, /do not commit or push|run build\/test commands, or commit|Feature branches may be created, committed to, pushed, rebased, and deleted freely|bash is for read-only inspection only|Bash access is for read-only discovery only/, name);
  }
});

test('Pi executor guide uses the merged exact-text edit operation', () => {
  const pi = read('agent/skills/executor/SKILL.md');
  for (const [name, guide] of [['Pi', pi]]) {
    assert.ok(guide.includes('\"type\": \"edit_file\"'), name);
    assert.ok(guide.includes('\"oldText\"'), name);
    assert.ok(guide.includes('\"newText\"'), name);
    assert.ok(guide.includes('The `patch` operation has been removed'), name);
    assert.ok(!guide.includes('| `patch` |'), name);
    assert.ok(guide.includes('occur exactly once'), name);
  }
  assert.ok(read('agent/skills/implement-task/SKILL.md').includes('Use `edit_file` for in-place text changes'));
  assert.doesNotMatch(read('agent/skills/feature-delivery/SKILL.md'), /### Select checks for the current issue|#### Checkpoint recovery/);
  assert.ok(read('agent/skills/implement-task/SKILL.md').includes('removed `patch` variants'));
});


test('delegated issue designs remain explicit and final review remains mandatory', () => {
  const init = read('agent/skills/init-feature/SKILL.md');
  const delivery = read('agent/skills/feature-delivery/SKILL.md');
  for (const phrase of ['agent-authored', 'design-record', 'actual reference',
    'Never claim the user approved an individual issue', 'completed descendants']) assert.ok(init.includes(phrase), phrase);
  for (const phrase of ['Final feature review is mandatory', 'no per-issue attempt limit',
    'previousAttempt', 'completed descendants']) assert.ok(delivery.includes(phrase), phrase);
  assert.match(delivery, /material scope changes|material commitments|material departures|material changes/);
});

test('native checkpoints, recovery and validation reuse the same durable direction authority', () => {
  const native = read('agent/extensions/execute-and-review/tools.mjs');
  assert.equal((native.match(/host\.confirm\(/g) ?? []).length, 4, 'one routine direction confirmation, one explicit material-amendment confirmation, one explicit confirmation before force-closing an interrupted invocation, and one confirmation of the changed paths before recording outside working-tree changes');
  assert.match(native, /approveFeatureDirection/);
  assert.doesNotMatch(native, /registerRecoveryTools|name: "(?:validate_feature|checkpoint_verified_task)"/);
  const recovery = read('agent/extensions/execution-recovery/tools.mjs');
  const validation = read('agent/extensions/feature-validation/tools.mjs');
  const checkpoint = read('agent/extensions/checkpoint/tools.mjs');
  assert.match(checkpoint, /name: "checkpoint_verified_task"/);
  assert.doesNotMatch(recovery, /name: "checkpoint_verified_task"/);
  assert.match(validation, /name: "validate_feature"/);
  // Suspend/resume and validation ask the retained approval; the rewrite and foreign-commit tools read
  // Scaffold's recorded approval themselves (approved(feature)).
  assert.equal(((native + recovery + validation).match(/authorize: async \(\) =>\s*featureAuthorized/g) ?? []).length, 2);
  assert.match(read('agent/extensions/execute-and-review/delivery.mjs'), /requireFeatureAuthorization/);
  assert.match(read('agent/extensions/checkpoint/finalization.mjs'), /featureAuthorized/);
  const adapter = read('agent/extensions/execute-and-review/adapter.mjs');
  assert.match(adapter, /options.issueWorkflowOnly\)\s+await requireFeatureAuthorization/);
});

test('execution guides do not add a second approval after the overall direction', () => {
  for (const file of ['agent/skills/feature-delivery/SKILL.md', 'agent/skills/executor/SKILL.md', 'agent/skills/implement-task/SKILL.md']) {
    const text = read(file);
    assert.doesNotMatch(text, /After \*\*separate explicit execution approval|Explicitly ask the user whether to \*\*execute/);
    assert.match(text, /full operations on request/);
  }
});

test('standalone design contract is independent of delivery orchestration', () => {
  const design = read('agent/skills/design/SKILL.md');
  const delivery = read('agent/skills/feature-delivery/SKILL.md');
  assert.match(design, /name: design/);
  assert.match(design, /inputs, outputs|Inputs, outputs/i);
  assert.match(design, /verification strategy/);
  assert.doesNotMatch(design, /approve_feature_direction|execute_and_review|checkpoint_verified_task|validate_feature/);
  assert.match(delivery, /name: feature-delivery/);
  assert.match(read('agent/skills/init-feature/SKILL.md'), /\/skill:design/);
  assert.match(delivery, /\/skill:init-feature/);
  assert.match(delivery, /execute_and_review/);
  assert.match(read('delivery-rules.md'), /\/skill:feature-delivery/);
});

test('feature-delivery delegates exactly one task to implement-task without re-owning attempt internals', () => {
  const delivery = read('agent/skills/feature-delivery/SKILL.md');
  const task = read('agent/skills/implement-task/SKILL.md');
  const system = read('delivery-rules.md');
  assert.match(delivery, /\/skill:implement-task/);
  assert.match(delivery, /design-finish/);
  assert.match(delivery, /validate_feature/);
  assert.match(delivery, /discovery exit hatch/i);
  assert.doesNotMatch(delivery, /#### Checkpoint recovery|### Select checks for the current issue/);
  assert.match(task, /name: implement-task/);
  assert.match(task, /featureId/);
  assert.match(task, /taskId/);
  assert.match(task, /execute_and_review/);
  assert.match(task, /previousAttempt/);
  assert.match(task, /checkpoint_verified_task/);
  assert.match(task, /stage: COMMITTED/);
  assert.match(task, /missing prerequisites|NEEDS_DECOMPOSITION/i);
  assert.match(system, /\/skill:implement-task/);
  assert.match(read('agent/skills/conductor/SKILL.md'), /\/skill:implement-task/);
  assert.match(read('agent/extensions/execute-and-review/README.md'), /\/skill:implement-task/);
});

test('init-feature keeps agent-added constraints out of the ticket and shows them for approval', () => {
  const init = read('agent/skills/init-feature/SKILL.md').replace(/\s+/g, ' ');
  assert.match(init, /do not strengthen them/);
  assert.match(init, /Agent-added constraints \(not in the ticket\)/);
  assert.match(init, /If the user has not seen it, it is not an approved constraint/);
  assert.match(init, /approve_delivery_amendment/);
});

test('init-feature supports independent Linear preparation and safe reuse', () => {
  const init = read('agent/skills/init-feature/SKILL.md');
  const delivery = read('agent/skills/feature-delivery/SKILL.md');
  for (const phrase of ['Linear identifier', 'linear_get_ticket', 'origin:', 'init',
    'summary', 'design_ref', 'approval', 'design-finish',
    'original baseline', 'without implementing']) {
    assert.ok(init.includes(phrase), `init-feature missing: ${phrase}`);
  }
  assert.match(init, /Never call|Never.*call/i);
  assert.match(init, /never.*execute_and_review/is);
  assert.match(delivery, /prepared feature/);
  assert.match(delivery, /validate_feature/);
  assert.doesNotMatch(delivery, /### Feature planning and the single approval|## 2\. Design the issue graph downward/);
  assert.match(read('agent/skills/scaffold/SKILL.md'), /\/skill:init-feature/);
});
