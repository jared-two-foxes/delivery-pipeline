// Render an approval scope as readable plain text for a confirmation dialog.
// JSON.stringify escapes newlines and quotes, which turns a multi-page design into one unreadable wall.

const HIDDEN = new Set(["scopeDigest"]); // machine identity, shown once in short form instead
const LABELS = { featureId: "Feature", previousAttempt: "Previous attempt",  designRef: "Design reference", scopeDigest: "Scope digest", acceptanceCriteria: "Acceptance criteria", instanceId: "Instance" };

const label = (key) => LABELS[key] ?? key.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase());
const pad = (n) => "  ".repeat(n);
// Only these machine references are abbreviated. Everything else (an amendment's original and replacement
// text included) is shown verbatim, because abbreviating it could make different approvals look identical.
const SHORTENED = new Set(["designRef", "instanceId"]);
const short = (k, v) =>
  SHORTENED.has(k) && /^(sha256:)?[a-f0-9]{40,64}$/.test(v) ? v.slice(0, v.startsWith("sha256:") ? 19 : 12) + "…" : v;

function render(value, depth) {
  if (value === null || value === undefined) return [pad(depth) + "(none)"];
  if (typeof value === "string") return value.split("\n").map((l) => pad(depth) + l);
  if (typeof value !== "object") return [pad(depth) + String(value)];
  if (Array.isArray(value)) {
    if (!value.length) return [pad(depth) + "(none)"];
    return value.flatMap((item) => {
      const [first, ...rest] = render(item, depth + 1);
      return [pad(depth) + "- " + first.trimStart(), ...rest];
    });
  }
  return Object.entries(value).flatMap(([k, v]) => {
    if (HIDDEN.has(k)) return [];
    const scalar = typeof v !== "object" && v !== null && v !== undefined && !String(v).includes("\n");
    return scalar
      ? [pad(depth) + label(k) + ": " + short(k, String(v))]
      : [pad(depth) + label(k) + ":", ...render(v, depth + 1)];
  });
}

/** Human-readable text for an approval scope: no JSON escaping, real line breaks, headed sections. */
export function formatScope(scope) {
  return render(scope, 0).join("\n");
}
