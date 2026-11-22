# Delivery tools over MCP

`server.mjs` serves the 21 delivery tools (`scaffold_tasks`, `execute_and_review`,
`checkpoint_verified_task`, `validate_feature`, the recovery tools, `review_changes`, ...) to any MCP host.
Pi is served all of them. The approval tools show no dialog; the user approves in chat (see "Approvals").
It loads the host-neutral definitions in `src/tools/*/tools.mjs`; nothing is duplicated.
The adapter logic is `src/lib/host/mcp.mjs` (dependency-free and unit-tested); this directory only
wires in the MCP SDK, TypeBox and a JSON Schema validator.

Dependencies are an npm workspace of the repository root and are downloaded at setup:

```sh
npm ci                       # at the repository root
node mcp/start.mjs           # stdio; runs in the current directory, which must be the target repository
```

`start.mjs` is the entry point to give a host. If the dependencies are missing it prints the one-line fix on
stderr and exits 1, rather than failing with a module-resolution stack trace.

Claude Code: `claude mcp add delivery-pipeline -- node /absolute/path/to/mcp/start.mjs`, run from the repository
you are delivering in. VS Code: add the same command to `.vscode/mcp.json` (`"type": "stdio"`).
The external CLIs (`scaffold`, Conductor, Executor, Review) must be on `PATH`, as they are for Pi.

## Using it from Pi

Pi has a built-in MCP client, and MCP is the only way Pi gets the delivery tools. The `delivery-mcp` extension
registers this server for every session, so Pi runs the same tool code as other hosts. There is no native
fallback and no environment switch.

- **Startup check.** Before registering, the extension actually starts the server
  (`node start.mjs --check` loads the whole module graph and exits). A missing file, missing or partial
  dependencies (including ones the direct packages need), a Node too old for the SDK, or no `node` on `PATH`
  means the server is not registered and Pi shows an error that names the cause, with the fix where there is one
  (`npm ci`). The result is cached, so one Pi session spawns one check. `PI_DELIVERY_MCP_SERVER` points at
  `start.mjs` for non-standard layouts. **Not covered:** a server that starts fine and dies later in a session. Pi
  shows it as disconnected and reconnects on the next call.
- **Settings the extension applies.** `exposure: "direct"` (Pi's default `codemode` would hide the tools from
  the model), `timeout: 3600` (Pi's 60 s default would cut off a 30-minute workflow), and `cwd: "."` (resolved
  against Pi's session directory, i.e. the repository being delivered). The server also sends a progress
  heartbeat every 15 s to clients that ask for progress; Pi resets its timeout on progress.
- **Tool names differ.** MCP tools reach the model as `mcp__pidelivery__<tool>` (for example
  `mcp__pidelivery__execute_and_review`), while the approval tools keep their bare names. `delivery-rules.md`
  tells the model about the prefix; the skills still use bare names, as they do for Claude Code. Whether a
  model maps them reliably in a long real session has not been verified.

Verified against real Pi 1.5.2 without a model (extensions loaded explicitly, with the server's transport still
opt-in at that time): the server registers and connects; Pi's tool list becomes 14 `mcp__pidelivery__*` tools
plus the native approval tools; the server runs in the session directory. **Not verified:** an actual tool call
through Pi's MCP client (needs a model), and approvals and long runs in a live session.

## What the adapter does that Pi did implicitly

- **Validates arguments.** Pi checked them against the TypeBox schema before `execute`; the MCP SDK's server
  does not. The adapter validates every call (`ajv`) and refuses to be built without a validator.
- **Approvals are chat-based.** `approve_delivery_amendment`, `adopt_foreign_commits`, `accept_feature`,
  `abandon_inflight_attempt` (force/restore) and `reconcile_external_changes` show no dialog: MCP elicitation never
  appears on some clients (the mobile app), which stalled the whole pipeline. The agent presents the concrete change in
  chat and calls the tool after the user's explicit yes, the same model as `approve_feature_direction`. The tool
  descriptions say so; nothing in the host enforces it, and every approval is written to the Scaffold ledger. The generic
  `interactive`/`host.confirm`/elicitation plumbing remains for any future tool that needs a real dialog.

## What this does NOT give you yet

**The trust model.** Connecting this server only *offers* the delivery tools; on its own it does not stop an
agent using the host's own edit tools instead of `execute_and_review`. Prevention comes from a guard
(`../src/lib/guard/`) applied per host: Claude Code's plugin hook (`../docs/claude-code.md`) and Pi's
`delivery-guard` extension (`../pi/delivery-guard/README.md`). Before the Pi extension existed, Pi's
"never edit directly" rule was only text in `delivery-rules.md`, backed by the ledger's detection
(`checkpointHistory()` flags any commit that is not an authenticated checkpoint).

Also unverified: behaviour under a real Claude Code or VS Code session (the tests use the SDK's own
client).
