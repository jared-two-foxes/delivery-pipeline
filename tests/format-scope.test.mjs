import test from 'node:test';
import assert from 'node:assert/strict';
import { formatScope } from '../agent/lib/host/format-scope.mjs';

test('approval scope renders as readable text, not escaped JSON', () => {
  const out = formatScope({
    featureId: 'F1', designRef: 'sha256:' + 'a'.repeat(64), direction: '# Design\n\nLine "q"',
    acceptanceCriteria: ['one', 'two'], constraints: [], scopeDigest: 'b'.repeat(64),
  });
  assert.doesNotMatch(out, /\\n|\\"|[{}]/);
  assert.match(out, /^Feature: F1$/m);
  assert.match(out, /Design reference: sha256:a{12}…/);
  assert.match(out, /^ {2}# Design$/m);
  assert.match(out, /^ {2}- one$/m);
  assert.match(out, /Constraints:\n {2}\(none\)/);
  assert.doesNotMatch(out, /bbbb/);
});

import { createExecuteAndReviewTools } from '../agent/extensions/execute-and-review/tools.mjs';
import { validateRequest } from '../agent/lib/scaffold/contracts.mjs';
const Type = new Proxy({}, { get: (_t, kind) => (...args) => ({ kind, args }) });

test('feature direction gate is a short Yes/No bound to the presented design', async () => {
  const tool = createExecuteAndReviewTools(Type).find((t) => t.name === 'approve_feature_direction');
  assert.ok('designRef' in tool.parameters.args[0]);
  assert.match(tool.description, /design-revise/);
});

test('design-revise recomputes the design reference from the revised context', () => {
  const { payload } = validateRequest({ operation: 'design-revise', feature_id: 'F1', payload: { context: 'v2 design' } });
  assert.match(payload.design_ref, /^sha256:[a-f0-9]{64}$/);
  assert.throws(() => validateRequest({ operation: 'design-revise', feature_id: 'F1', payload: { context: ' ' } }));
});

test('only design/instance references are abbreviated; amendment text is verbatim', () => {
  const sha = 'a'.repeat(64);
  const other = 'a'.repeat(63) + 'b';
  const out = (replacement) => formatScope({ designRef: 'sha256:' + sha, replacement, original: [{ id: 'C1', text: sha }] });
  assert.match(out(sha), /Design reference: sha256:a{12}…/);
  assert.ok(out(sha).includes('Replacement: ' + sha));
  assert.notEqual(out(sha), out(other), 'distinct replacements must not look identical');
  assert.ok(out(sha).includes('Text: ' + sha));
});

test('design-revise carries revised requirements and validates them', () => {
  const ok = validateRequest({ operation: 'design-revise', feature_id: 'F1', payload: {
    context: 'v2', objective: 'New', acceptance_criteria: ['Only this'], constraints: [] } }).payload;
  assert.equal(ok.objective, 'New');
  assert.deepEqual(ok.acceptance_criteria, ['Only this']);
  assert.match(ok.design_ref, /^sha256:/);
  for (const bad of [{ acceptance_criteria: [] }, { objective: ' ' }, { constraints: [1] }, { extra: 1 }])
    assert.throws(() => validateRequest({ operation: 'design-revise', feature_id: 'F1', payload: { context: 'v2', ...bad } }));
});
