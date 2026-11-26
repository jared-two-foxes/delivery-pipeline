#!/usr/bin/env bash
# Setup script for the "delivery-pipeline" Claude Code cloud environment.
# Paste into the environment's setup script field (or run as root on a fresh container).
# Runs only on fresh container builds, not on resume.
set -e
export PATH="$HOME/.cargo/bin:$PATH"
# Rust CLIs -> /usr/local/bin
cargo install --root /usr/local --force --git https://github.com/jared-two-foxes/conductor.git
cargo install --root /usr/local --force --git https://github.com/jared-two-foxes/review.git review-cli
cargo install --root /usr/local --force --git https://github.com/jared-two-foxes/executor.git
# Scaffold straight from GitHub
pip install "git+https://github.com/jared-two-foxes/scaffold.git"
# Repo dependencies for npm test, wherever the checkout is
for d in ./*/; do
  if [ -f "$d/mcp/start.mjs" ]; then (cd "$d" && npm ci); fi
done
# Claude Code plugin: skills, MCP server and edit guard
if claude plugin marketplace add jared-two-foxes/delivery-pipeline \
   && claude plugin install delivery-pipeline@delivery-pipeline; then
  # Pull latest main into the marketplace clone and plugin cache (non-fatal)
  claude plugin marketplace update delivery-pipeline || echo "WARNING: marketplace update failed" >&2
  claude plugin update delivery-pipeline@delivery-pipeline || echo "WARNING: plugin update failed" >&2
  P=$(claude plugin list --json | grep -o '"installPath": *"[^"]*"' | head -1 | sed 's/.*: *"//;s/"//')
  (cd "$P" && npm ci)
else
  echo "WARNING: delivery-pipeline plugin install failed" >&2
fi
# Local PostgreSQL 16 for SQLx tests (trust auth, localhost only). Non-fatal on failure.
PGBIN=/usr/lib/postgresql/16/bin
PGDATA=/var/lib/ordna-pg
start_pg() {
  [ -x "$PGBIN/initdb" ] || return 1
  id postgres >/dev/null 2>&1 || useradd -r -m postgres || return 1
  mkdir -p "$PGDATA" && chown postgres "$PGDATA" || return 1
  [ -f "$PGDATA/PG_VERSION" ] || su -s /bin/sh postgres -c "$PGBIN/initdb -D $PGDATA -A trust" || return 1
  su -s /bin/sh postgres -c "$PGBIN/pg_ctl -D $PGDATA -l /tmp/ordna-pg.log -w start" || return 1
}
start_pg || echo "WARNING: local postgres setup failed" >&2
# Setup scripts run only on fresh builds, not on resume. Also start Postgres at every session start.
cat > /usr/local/bin/ordna-pg-start <<'EOF'
#!/bin/sh
# Idempotent: start the environment's local Postgres if it is not accepting connections.
PGBIN=/usr/lib/postgresql/16/bin
PGDATA=/var/lib/ordna-pg
[ -f "$PGDATA/PG_VERSION" ] || exit 0
"$PGBIN/pg_isready" -q -h localhost && exit 0
su -s /bin/sh postgres -c "$PGBIN/pg_ctl -D $PGDATA -l /tmp/ordna-pg.log -w start" >/dev/null 2>&1
exit 0
EOF
chmod +x /usr/local/bin/ordna-pg-start
mkdir -p "$HOME/.claude"
python3 - <<'EOF' || echo "WARNING: SessionStart hook setup failed" >&2
import json, os
p = os.path.expanduser("~/.claude/settings.json")
s = json.load(open(p)) if os.path.exists(p) else {}
hooks = s.setdefault("hooks", {}).setdefault("SessionStart", [])
cmd = "/usr/local/bin/ordna-pg-start"
if not any(h.get("command") == cmd for g in hooks for h in g.get("hooks", [])):
    hooks.append({"hooks": [{"type": "command", "command": cmd}]})
json.dump(s, open(p, "w"), indent=2)
EOF
