import assert from "node:assert/strict";
import { test } from "node:test";
import { HOSTS, diff, render } from "../scripts/build-skills.mjs";

test("committed skill variants match skills-src for every host", () => {
  for (const host of Object.keys(HOSTS)) assert.deepEqual(diff(host), [], `${host} variant is out of date; run node scripts/build-skills.mjs`);
});

test("render substitutes tokens and keeps only the matching host block", () => {
  const text = "Use {{skill:design}} and {{tool:execute_and_review}}.\n{{#pi}}\nPi only.\n{{/pi}}\nEnd.\n";
  assert.equal(render(text, "pi"), "Use /skill:design and execute_and_review.\nPi only.\nEnd.\n");
});

test("render rejects unknown host blocks and unresolved tokens", () => {
  assert.throws(() => render("{{#vscode}}\nx\n{{/vscode}}\n", "pi"), /unknown host block/);
  assert.throws(() => render("{{bogus}}", "pi"), /unresolved token/);
});
