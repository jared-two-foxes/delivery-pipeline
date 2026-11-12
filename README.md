# delivery-pipeline

A feature delivery pipeline for coding agents. An LLM orchestrator researches a ticket, gets **one** direction
approval, then delivers each issue through tools that apply exact operations, run checks, get an independent
review and make verified Git checkpoints. [Scaffold](https://github.com/jared-two-foxes/scaffold) keeps the
task graph and an append-only ledger. A guard stops the agent editing source directly while a delivery is active.

It runs in three hosts from one set of tool definitions:

| Host | How | Read |
|---|---|---|
| **Pi** | Install as a Pi package | below |
| **Claude Code** | Plugin: MCP server + `PreToolUse` guard | [`claude/README.md`](claude/README.md) |
| **Any MCP host** (e.g. VS Code) | stdio MCP server | [`mcp/README.md`](mcp/README.md) |

How it fits together, and what is and is not enforced: [`ARCHITECTURE.md`](ARCHITECTURE.md).
The workflow: [`workflow-overview.md`](workflow-overview.md).

## Install in Pi

```sh
pi install git:github.com/jared-two-foxes/delivery-pipeline
```

Pi clones the repository and installs its dependencies. The package provides the delivery extensions, the
skills (`/skill:init-feature`, `/skill:feature-delivery`, `/skill:implement-task`, `/skill:design`, ...) and the
`delivery-prompt` extension, which adds the orchestrator rules (`delivery-rules.md`) to Pi's system prompt.
They are added as an extra section, so they combine with Pi's default prompt and with your own
`SYSTEM.md` / `APPEND_SYSTEM.md` rather than replacing them. Your personal policy (for example Git and GitHub
publishing rules and communication style) belongs in your own `APPEND_SYSTEM.md`.

External tools must be on `PATH`: `scaffold`, `conductor` (v2), `executor` and `review-cli`
(or set `CONDUCTOR_BIN`, `EXECUTOR_BIN`, `REVIEW_CLI_BIN`).

The delivery guard is active only in repositories that have `.scaffold/features/*`. `PI_DELIVERY_GUARD=off`
disables it; see [`agent/extensions/delivery-guard/README.md`](agent/extensions/delivery-guard/README.md).

## Develop

```sh
npm ci
npm test
```

Skills are written once in `skills-src/` and rendered per host: `agent/skills/` (Pi) and `skills/` (Claude Code).
Edit `skills-src/`, then run `node scripts/build-skills.mjs`; `npm test` fails if a committed variant is stale.

Tests that drive the real Scaffold CLI need it installed (CI checks out `jared-two-foxes/scaffold`; set
`SCAFFOLD_SOURCE` to a checkout). Without it those tests fail or skip; the rest run standalone.

## Licence

MIT; see [`LICENSE`](LICENSE).
