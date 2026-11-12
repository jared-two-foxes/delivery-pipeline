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
