import { watch, lstatSync } from "node:fs";
import path from "node:path";
import { git } from "./tree.mjs";
const MAX_EVENTS = 200;
// Any notification on a tracked path (or one that names no path) still trips the monitor, because a
// write-then-revert is invisible to the Git fingerprint. The offending events are recorded so a trip
// can be told apart as a real edit, a touch/antivirus metadata event, or an unnamed overflow.
export function monitorTrackedInputs(repository) {
  const files = git(repository, ["ls-files", "-z"]).split("\0").filter(Boolean);
  const watchers = [];
  const events = [];
  let total = 0;
  let stage = { stage: null, command: null };
  // Baseline content identity is the index blob id, so no up-front hashing of the tree is needed.
  // `git hash-object --path` applies the same clean filters as `git status`, so an unchanged file
  // hashes to its index id even with CRLF conversion.
  const baseline = new Map();
  try {
    for (const entry of git(repository, ["ls-files", "-s", "-z"]).split("\0").filter(Boolean)) {
      const m = /^\d+ ([0-9a-f]+) \d\t(.*)$/s.exec(entry);
      if (m) baseline.set(m[2], m[1]);
    }
  } catch { /* diagnostics only */ }
  const observe = (rel) => {
    const out = { baseline_hash: baseline.get(rel) ?? null };
    try {
      const st = lstatSync(path.resolve(repository, rel));
      Object.assign(out, { size: st.size, mtime: st.mtime.toISOString(), ctime: st.ctime.toISOString(),
        atime: st.atime.toISOString() });
    } catch (error) { out.stat_error = error?.code ?? String(error?.message ?? error); }
    try { out.event_hash = git(repository, ["hash-object", "--path=" + rel, "--", rel]).trim(); }
    catch (error) { out.hash_error = error?.code ?? String(error?.message ?? error).slice(0, 120); }
    out.content_matches_baseline = out.event_hash != null && out.baseline_hash != null ? out.event_hash === out.baseline_hash : null;
    return out;
  };
  let blocking = 0;
  // A notification only blocks when it cannot be shown harmless: it names no path, the file's content
  // differs from the baseline, or the content could not be hashed (deleted, unreadable, untracked in index).
  // A named file whose content hashes to its baseline is a metadata-only event and is recorded as a warning.
  // Every event is classified; only the retained detail is capped.
  const record = (kind, dir, name) => {
    total++;
    const file = name ? path.relative(repository, path.resolve(dir, name.toString())) : null;
    const rel = file ? file.split(path.sep).join("/") : null;
    const observed = rel ? observe(rel) : {};
    const classification = rel && observed.content_matches_baseline === true ? "metadata-only" : "blocking";
    if (classification === "blocking") blocking++;
    if (events.length >= MAX_EVENTS) return;
    events.push({ kind, path: rel, dir: path.relative(repository, dir).split(path.sep).join("/") || ".",
      at: new Date().toISOString(), ...stage, ...observed, classification });
  };
  try {
    const tracked = new Set(files.map((f) => path.resolve(repository, f)));
    for (const dir of new Set(
      files.map((f) => path.dirname(path.resolve(repository, f))),
    )) {
      const watcher = watch(dir, (event, name) => {
        if (!name) record("unnamed:" + event, dir, null);
        else if (tracked.has(path.resolve(dir, name.toString()))) record(event, dir, name);
      });
      watcher.on("error", (error) => {
        record("watcher-error:" + (error?.code ?? error?.message ?? "unknown"), dir, null);
      });
      watchers.push(watcher);
    }
  } catch (error) {
    watchers.forEach((w) => w.close());
    throw error;
  }
  return {
    events: () => events.slice(),
    total: () => total,
    blocking: () => blocking,
    // Label subsequent notifications with the validation stage and active command.
    mark: (name, command = null) => { stage = { stage: name, command }; },
    // Structured, serialisable summary for failure receipts.
    diagnostics: () => ({ total, blocking, warnings: total - blocking, retained: events.length, events: events.slice() }),
    assert: () => {
      if (!blocking) return;
      const shown = events.filter((e) => e.classification === "blocking");
      const first = shown[0];
      const detail = shown.slice(0, 3).map((e) => `${e.kind} ${e.path ?? "<unnamed in " + e.dir + ">"} @${e.at}${e.content_matches_baseline === false ? " (content differs)" : e.path ? " (content not verifiable)" : ""}`).join("; ");
      throw new Error("Tracked implementation inputs changed during validation; reconcile" +
        ` (${blocking} blocking notification${blocking === 1 ? "" : "s"}${total > blocking ? `, ${total - blocking} metadata-only ignored` : ""}` +
        `${first ? `, first ${first.kind} ${first.path ?? "<unnamed>"}: ${detail}` : ""}${blocking > shown.length ? `; ${blocking - shown.length} more not recorded` : ""})`);
    },
    close: () => watchers.forEach((w) => w.close()),
  };
}
