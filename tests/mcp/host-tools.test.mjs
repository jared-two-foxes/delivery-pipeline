import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { defineTool, toolResult, withFailureReporting } from "../../src/lib/host/tool.mjs";
import { MCP_SERVER_NAME, deliveryMcpServerConfig, deliveryServer } from "../../src/lib/host/pi.mjs";
import { missingDependencies } from "../../src/lib/host/dependencies.mjs";
import { createCheckpointTools } from "../../src/tools/checkpoint/tools.mjs";
import { createFeatureValidationTools } from "../../src/tools/feature-validation/tools.mjs";
import { createScaffoldTools } from "../../src/tools/scaffold/tools.mjs";
import { createReviewTool } from "../../src/tools/review/tool.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "src");

// Minimal TypeBox-shaped builder: enough to prove definitions only need an injected `Type`.
const Type = new Proxy({}, {
  get: (_t, kind) => (...args) => ({ kind, args }),
});

test("toolResult defaults isError from ok and keeps details", () => {
  const ok = toolResult({ ok: true, n: 1 });
  assert.equal(ok.isError, false);
  assert.deepEqual(JSON.parse(ok.content[0].text), { ok: true, n: 1 });
  assert.equal(ok.details.n, 1);
  assert.equal(toolResult({ ok: false }).isError, true);
  assert.equal(toolResult({ status: "BLOCKED" }, { isError: true }).isError, true);
  assert.equal(toolResult({ ok: true }, { text: { shown: 1 } }).content[0].text, JSON.stringify({ shown: 1 }, null, 2));
});

test("defineTool rejects an incomplete definition at definition time", () => {
  assert.throws(() => defineTool({ name: "x" }), /description/);
  assert.throws(() => defineTool({ name: "x", description: "d", parameters: {}, execute: 1 }), /execute must be a function/);
  const tool = { name: "x", description: "d", parameters: {}, execute() {} };
  assert.equal(defineTool(tool), tool);
});

test("withFailureReporting gives a neutral tool the shared failure envelope", async () => {
  const boom = withFailureReporting(defineTool({
    name: "validate_feature", description: "d", parameters: {},
    async execute() { throw new Error("kaboom"); },
  }));
  const out = await boom.execute({}, { cwd: "/nonexistent-no-ledger" });
  assert.equal(out.isError, true);
  const shown = JSON.parse(out.content[0].text);
  assert.equal(shown.failure.owner, "bug");
  assert.match(shown.message, /kaboom/);

  const blocked = withFailureReporting(defineTool({
    name: "checkpoint_verified_task", description: "d", parameters: {},
    async execute() { return toolResult({ ok: false, reason: "CHECKPOINT_BLOCKED", message: "m" }); },
  }));
  const out2 = await blocked.execute({}, { cwd: "/nonexistent-no-ledger" });
  assert.equal(JSON.parse(out2.content[0].text).failure.code, "CHECKPOINT_BLOCKED");
});

test("converted tool factories expose the same tool names", () => {
  const names = (tools) => tools.map((t) => t.name);
  assert.deepEqual(names(createCheckpointTools(Type)), ["checkpoint_verified_task"]);
  assert.deepEqual(names(createFeatureValidationTools(Type)), ["validate_feature", "run_feature_checks", "accept_feature", "inspect_feature_validation"]);
  assert.deepEqual(names(createScaffoldTools(Type)), ["scaffold_tasks"]);
  assert.deepEqual(names([createReviewTool(Type)]), ["review_changes"]);
});

// The point of the layer: nothing the next host (an MCP server) would load may depend on Pi.
async function sources(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { if (entry.name !== "node_modules") out.push(...await sources(full)); }
    else if (/\.mjs$/.test(entry.name)) out.push(full);
  }
  return out;
}

test("no host-neutral module imports a host SDK or touches the UI", async () => {
  const files = [...await sources(path.join(root, "lib")), ...await sources(path.join(root, "tools"))];
  assert.ok(files.length > 50);
  const offenders = [];
  for (const file of files) {
    const text = await readFile(file, "utf8");
    if (/@earendil-works|@mariozechner|pi-coding-agent|@modelcontextprotocol|ExtensionAPI|\bctx\.ui\b|registerTool\(/.test(text)
      && path.relative(root, file) !== path.join("lib", "host", "pi.mjs")) offenders.push(path.relative(root, file));
  }
  // lib/host/pi.mjs is the one allowed Pi seam. Nothing else under lib/ or any *.mjs workflow may reach the host.
  assert.deepEqual(offenders, []);
});

test("the tool inventory is stable across hosts", async () => {
  const { createExecuteAndReviewTools } = await import("../../src/tools/execute-and-review/tools.mjs");
  const { createExecutionRecoveryTools } = await import("../../src/tools/execution-recovery/tools.mjs");
  const all = [
    ...createExecuteAndReviewTools(Type), ...createExecutionRecoveryTools(Type), ...createCheckpointTools(Type),
    ...createFeatureValidationTools(Type), ...createScaffoldTools(Type), createReviewTool(Type),
  ];
  assert.deepEqual(all.map((t) => t.name).sort(), [
    "accept_feature", "adopt_foreign_commits", "approve_delivery_amendment", "approve_feature_direction", "checkpoint_verified_task",
    "abandon_inflight_attempt", "execute_and_review", "inspect_conductor_evidence", "inspect_feature_drift", "inspect_feature_validation",
    "inspect_issue_attempt", "inspect_issue_handoff", "prepare_issue_handoff", "reconcile_external_changes", "review_changes",
    "resume_issue", "rewrite_feature_history", "run_feature_checks", "scaffold_tasks", "suspend_issue", "validate_feature",
  ].sort());
  assert.equal(new Set(all.map((t) => t.name)).size, all.length, "tool names are unique");
  for (const tool of all) {
    assert.ok(tool.label && tool.description.length > 40, `${tool.name} documents itself`);
    assert.equal(typeof tool.execute, "function");
  }
});

// ---- Transport: MCP is the only path for non-interactive tools; an unstartable server is reported, not replaced.
function fakeServer(t, { installed, startSource = "" }) {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-transport-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ dependencies: { "@scope/pkg": "1", plain: "1" } }));
  writeFileSync(path.join(dir, "start.mjs"), startSource);
  if (installed) for (const name of ["@scope/pkg", "plain"]) {
    mkdirSync(path.join(dir, "node_modules", ...name.split("/")), { recursive: true });
    writeFileSync(path.join(dir, "node_modules", ...name.split("/"), "package.json"), "{}");
  }
  return path.join(dir, "start.mjs");
}

test("missingDependencies handles scoped packages and reports only what is absent", (t) => {
  const serverPath = fakeServer(t, { installed: false });
  assert.deepEqual(missingDependencies(path.dirname(serverPath)), ["@scope/pkg", "plain"]);
  const ok = fakeServer(t, { installed: true });
  assert.deepEqual(missingDependencies(path.dirname(ok)), []);
});

test("the delivery server is available only if it can actually start; there is no native fallback", (t) => {
  const ready = fakeServer(t, { installed: true });
  const bare = fakeServer(t, { installed: false });
  assert.deepEqual(deliveryServer({ env: {}, serverPath: ready }), { ok: true, serverPath: ready });

  const noDeps = deliveryServer({ env: {}, serverPath: bare });
  assert.equal(noDeps.ok, false);
  assert.match(noDeps.warning, /unavailable.*dependencies are not installed \(@scope\/pkg, plain\).*npm ci --prefix/);

  const missing = deliveryServer({ env: {}, serverPath: path.join(tmpdir(), "no-such-dir", "start.mjs") });
  assert.equal(missing.ok, false);
  assert.match(missing.warning, /does not exist.*PI_DELIVERY_MCP_SERVER/);

  const unreadable = fakeServer(t, { installed: true });
  rmSync(path.join(path.dirname(unreadable), "package.json"));
  assert.match(deliveryServer({ env: {}, serverPath: unreadable }).warning, /could not be checked/);
});

test("PI_DELIVERY_MCP_SERVER overrides where the server is looked for", (t) => {
  const ready = fakeServer(t, { installed: true });
  const server = deliveryServer({ env: { PI_DELIVERY_MCP_SERVER: ready } });
  assert.deepEqual([server.ok, server.serverPath], [true, ready]);
  // The default location is mcp/start.mjs beside src.
  assert.match(deliveryServer({ env: {} }).serverPath.replaceAll("\\", "/"), /\/mcp\/start\.mjs$/);
});

test("the Pi server entry sets direct exposure, a long timeout, session cwd", () => {
  const config = deliveryMcpServerConfig("/x/mcp/start.mjs");
  assert.deepEqual([config.command, config.args, config.cwd], ["node", ["/x/mcp/start.mjs"], "."]);
  assert.equal(config.exposure, "direct", "Pi's default (codemode) would hide the tools from the model");
  assert.ok(config.timeout >= 1800, "Pi's 60 s default would cut off a 30-minute workflow");
  assert.match(MCP_SERVER_NAME, /^[A-Za-z0-9_]+$/, "no hyphen: Pi rewrites it, so names would differ from other hosts");
});

test("dependencies hoisted into a parent node_modules (npm workspaces) count as installed", () => {
  const root = mkdtempSync(path.join(tmpdir(), "pi-hoist-"));
  try {
    mkdirSync(path.join(root, "mcp"), { recursive: true });
    writeFileSync(path.join(root, "mcp", "package.json"), JSON.stringify({ dependencies: { "@scope/pkg": "1", plain: "1" } }));
    assert.deepEqual(missingDependencies(path.join(root, "mcp")), ["@scope/pkg", "plain"]);
    mkdirSync(path.join(root, "node_modules", "@scope", "pkg"), { recursive: true });
    writeFileSync(path.join(root, "node_modules", "@scope", "pkg", "package.json"), "{}");
    assert.deepEqual(missingDependencies(path.join(root, "mcp")), ["plain"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a server whose direct dependencies exist but which cannot start is reported, not used", (t) => {
  // e.g. a partial `npm ci`: the packages named in package.json are present, one of THEIR dependencies is not.
  const broken = fakeServer(t, { installed: true, startSource: `throw new Error("Cannot find package 'zod' imported from sdk");` });
  const server = deliveryServer({ env: {}, serverPath: broken });
  assert.equal(server.ok, false);
  assert.match(server.warning, /could not start/);
  assert.match(server.warning, /Cannot find package 'zod'/, "the reason must reach the user");
  const nodeMissing = fakeServer(t, { installed: true });
  assert.equal(deliveryServer({ env: { PATH: "/nonexistent" }, serverPath: nodeMissing }).ok, false, "no `node` on PATH means Pi could not launch it either");
});

test("the startup check runs once per server per process", (t) => {
  const counter = path.join(tmpdir(), `pi-start-count-${process.pid}-${Date.now()}`);
  t.after(() => rmSync(counter, { force: true }));
  const server = fakeServer(t, { installed: true, startSource: `import { appendFileSync } from "node:fs"; appendFileSync(${JSON.stringify(counter)}, "x");` });
  for (let i = 0; i < 4; i++) assert.equal(deliveryServer({ env: {}, serverPath: server }).ok, true);
  assert.equal(readFileSync(counter, "utf8"), "x", "seven registrations in one Pi process must not spawn seven servers");
});
