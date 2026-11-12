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
