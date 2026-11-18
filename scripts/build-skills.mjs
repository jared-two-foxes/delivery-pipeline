#!/usr/bin/env node
// Renders the single skill source (skills/) into one variant per host.
//
//   node scripts/build-skills.mjs               write every variant
//   node scripts/build-skills.mjs --host pi     write one host's variant (npm runs this on install)
//   node scripts/build-skills.mjs --check       exit 1 if a committed variant differs from its source
//
// skills/ is the only hand-edited copy and holds template tokens, so no host loads it directly.
// Claude Code's variant (claude/skills/) is committed because a marketplace install is a plain git
// clone with no build step. Pi's (agent/skills/) is gitignored and built by `npm install`.
//
// Source syntax, in any .md file under skills/:
//   {{skill:NAME}}                     how the host invokes skill NAME
//   {{tool:NAME}}                      how the host names delivery tool NAME
//   {{agent}}                          the host's agent name (Pi, Claude)
//   {{pi:text}} / {{claude:text}}      inline text kept only for that host
//   {{#pi}} ... {{/pi}}                kept only in the Pi variant   (markers on their own lines)
//   {{#claude}} ... {{/claude}}        kept only in the Claude Code variant
// Other files are copied unchanged. An unknown token or host block is an error, never passed through.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const root = fileURLToPath(new URL("../", import.meta.url));
export const sourceDir = path.join(root, "skills");

/** Output directory and naming rules for each host. */
export const HOSTS = {
  pi: {
    outDir: "agent/skills",
    committed: false,
    skill: (name) => `/skill:${name}`,
    tool: (name) => name,
    agent: "Pi",
  },
  claude: {
    outDir: "claude/skills",
    committed: true,
    skill: (name) => `/delivery-pipeline:${name}`,
    // Claude Code names plugin MCP tools mcp__plugin_<plugin>_<server>__<tool>.
    tool: (name) => `mcp__plugin_delivery-pipeline_pidelivery__${name}`,
    agent: "Claude",
  },
};

export function render(text, hostName, file = "<text>") {
  const host = HOSTS[hostName];
  if (!host) throw new Error(`unknown host ${hostName}`);
  const hostBlocks = /^[ \t]*\{\{#(\w+)\}\}[ \t]*\n([\s\S]*?)^[ \t]*\{\{\/\1\}\}[ \t]*\n?/gm;
  let out = text.replace(hostBlocks, (_, name, body) => {
    if (!["pi", "claude"].includes(name)) throw new Error(`${file}: unknown host block {{#${name}}}`);
    return name === hostName ? body : "";
  });
  out = out.replace(/\{\{(pi|claude):([^}]*)\}\}/g, (_, name, body) => (name === hostName ? body : ""));
  out = out.replace(/\{\{agent\}\}/g, host.agent);
  out = out.replace(/\{\{(skill|tool):([\w-]+)\}\}/g, (_, kind, name) => host[kind](name));
  const left = out.match(/\{\{[#/]?\w*:?[^}]*\}\}/);
  if (left) throw new Error(`${file}: unresolved token ${left[0]}`);
  return out;
}

function* walk(dir, base = dir) {
  for (const entry of readdirSync(dir).sort()) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full, base);
    else yield path.relative(base, full).split(path.sep).join("/");
  }
}

/** Map of relative path -> Buffer for one host. */
export function build(hostName) {
  const files = new Map();
  for (const rel of walk(sourceDir)) {
    const data = readFileSync(path.join(sourceDir, rel));
    files.set(rel, rel.endsWith(".md") ? Buffer.from(render(data.toString("utf8"), hostName, rel), "utf8") : data);
  }
  return files;
}

/** Differences between a host's rendered variant and what is on disk. */
export function diff(hostName) {
  const wanted = build(hostName);
  const dir = path.join(root, HOSTS[hostName].outDir);
  const problems = [];
  for (const [rel, data] of wanted) {
    const file = path.join(dir, rel);
    if (!existsSync(file)) problems.push(`missing ${HOSTS[hostName].outDir}/${rel}`);
    else if (!readFileSync(file).equals(data)) problems.push(`differs ${HOSTS[hostName].outDir}/${rel}`);
  }
  if (existsSync(dir)) {
    for (const rel of walk(dir)) if (!wanted.has(rel)) problems.push(`stale ${HOSTS[hostName].outDir}/${rel}`);
  }
  return problems;
}

export function write(hostName) {
  const dir = path.join(root, HOSTS[hostName].outDir);
  // Render and validate everything first, so a bad source edit throws before the old variant is touched.
  const files = build(hostName);
  rmSync(dir, { recursive: true, force: true });
  for (const [rel, data] of files) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), data);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const hostFlag = process.argv.indexOf("--host");
  const selected = hostFlag === -1 ? Object.keys(HOSTS) : [process.argv[hostFlag + 1]];
  if (process.argv.includes("--check")) {
    const problems = selected.filter((name) => HOSTS[name]?.committed).flatMap(diff);
    if (problems.length) {
      process.stderr.write(`${problems.join("\n")}\nSkill variants are out of date. Run: node scripts/build-skills.mjs\n`);
      process.exit(1);
    }
  } else {
    for (const hostName of selected) write(hostName);
  }
}
