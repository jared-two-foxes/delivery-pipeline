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

test("the Claude Code variant uses plugin names and has no Pi invocation syntax", async () => {
  const { build } = await import("../scripts/build-skills.mjs");
  for (const [rel, data] of build("claude")) {
    const text = data.toString("utf8");
    assert.doesNotMatch(text, /\/skill:/, `${rel} still uses Pi skill syntax`);
    assert.doesNotMatch(text, /(?<![\w_-])(execute_and_review|scaffold_tasks|approve_feature_direction)(?!\w)/.source.length ? /(?<!pidelivery__)\b(execute_and_review|scaffold_tasks|approve_feature_direction)\b/ : /x/, `${rel} has a bare tool name`);
  }
});

test("a rejected source leaves the existing variant intact", async () => {
  const { writeFileSync, existsSync, rmSync } = await import("node:fs");
  const path = await import("node:path");
  const { write, HOSTS, sourceDir } = await import("../scripts/build-skills.mjs");
  // write() resolves both directories from the repository root, so exercise the ordering through a failing render.
  const dir = new URL("../" + HOSTS.pi.outDir + "/", import.meta.url);
  assert.ok(existsSync(dir), "Pi variant exists");
  const bad = path.join(sourceDir, "zz-bad-test.md");
  writeFileSync(bad, "{{bogus}}\n");
  try {
    assert.throws(() => write("pi"), /unresolved token/);
    assert.ok(existsSync(new URL("design/SKILL.md", dir)), "existing variant was not deleted");
  } finally {
    rmSync(bad, { force: true });
  }
});
