# delivery-pipeline

A feature delivery pipeline for coding agents. An LLM orchestrator researches a ticket, gets **one** direction
approval, then delivers each issue through tools that apply exact operations, run checks, get an independent
review and make verified Git checkpoints. [Scaffold](https://github.com/jared-two-foxes/scaffold) keeps the
task graph and an append-only ledger. A guard stops the agent editing source directly while a delivery is active.

It runs across hosts from one set of tool definitions:

| Host | How | Read |
|---|---|---|
| **Pi** | Install as a Pi package | below |
| **Claude Code** | Plugin: MCP server + `PreToolUse` guard | [`docs/claude-code.md`](docs/claude-code.md) |
| **Codex Cloud** | Shared environment with Delivery MCP and skills | [Setup](#set-up-codex-cloud) |
| **Any MCP host** (e.g. VS Code) | stdio MCP server | [`mcp/README.md`](mcp/README.md) |

How it fits together, and what is and is not enforced: [`docs/architecture.md`](docs/architecture.md).
The workflow: [`docs/workflow-overview.md`](docs/workflow-overview.md).

## Install in Pi

```sh
pi install git:github.com/jared-two-foxes/delivery-pipeline
```

Pi clones the repository and installs its dependencies. The package provides the delivery extensions, the
skills (`/skill:init-feature`, `/skill:feature-delivery`, `/skill:implement-task`, `/skill:design`, ...) and the
`delivery-prompt` extension, which adds the orchestrator rules (`pi/delivery-prompt/delivery-rules.md`) to Pi's system prompt.
They are added as an extra section, so they combine with Pi's default prompt and with your own
`SYSTEM.md` / `APPEND_SYSTEM.md` rather than replacing them. Your personal policy (for example Git and GitHub
publishing rules and communication style) belongs in your own `APPEND_SYSTEM.md`.

External tools must be on `PATH`: `scaffold`, `conductor` (v2), `executor` and `review-cli`
(or set `CONDUCTOR_BIN`, `EXECUTOR_BIN`, `REVIEW_CLI_BIN`).

The delivery guard is active only in repositories that have `.scaffold/features/*`. `PI_DELIVERY_GUARD=off`
disables it; see [`pi/delivery-guard/README.md`](pi/delivery-guard/README.md).

## Set up Codex Cloud

Add this repository to the shared environment and run the setup script from its checkout as the task user.

```sh
bash scripts/cloud-env-setup.sh --codex
```

Setup requires Node.js, npm, Python with `venv`, Git, and a native build toolchain for Cargo. If Cargo is
missing, setup installs Rust via rustup. The environment needs access to the Git repositories and package
registries used during setup. The script registers the `delivery` stdio server and links the repository's
skills under `~/.agents/skills`. The registration uses the checkout's absolute path, so keep the checkout at
the same mount path in sessions using the published environment. The `PreToolUse` edit guard is part of
the Claude Code plugin.

The MCP server receives the installed tools on its `PATH`. Setup also links the executables into
`~/.local/bin` for new shell sessions, preserving existing commands at that location.
Configure the selected [review provider's credentials](skills/review/SKILL.md) separately in the shared
environment. For OpenAI, bind `OPENAI_API_KEY` and allow access to `api.openai.com`.

After publishing, check `command -v scaffold conductor executor review-cli` and `codex mcp get delivery`,
then try a Delivery MCP tool in a new session. When
PostgreSQL 16 is installed, setup starts a local instance for SQLx tests. To start it after a resume, run
`bash scripts/cloud-env-setup.sh --start-codex-postgres`.

## Install in other agents

```sh
npx skills@latest add jared-two-foxes/delivery-pipeline -a <agent>   # omit -a to choose
```

This copies only the skills (`skills/`). They call the delivery tools (`scaffold_tasks`, `execute_and_review`, ...),
which come from the Pi extensions or the MCP server in `mcp/` (see [`docs/claude-code.md`](docs/claude-code.md)), so the
agent must also have those configured. Update with `npx skills@latest update`.

## Develop

```sh
npm ci
npm test
```

### Layout

| Path | Contents |
|---|---|
| `src/lib/` | Host-neutral libraries: contracts, verification, evidence, Git, guard policy and the host adapters |
| `src/tools/` | The delivery tools: host-neutral definitions (`tools.mjs`) and the workflows behind them, shared by every host |
| `pi/` | Pi only: the `index.ts` that registers each tool area, plus the Pi-specific extensions (`delivery-guard`, `delivery-prompt`, `delivery-mcp`, `conductor`, `implement-next`, `plan`, `linear`) |
| `mcp/` | The MCP server that serves `src/tools/` to any MCP host, Pi included |
| `hooks/` | The Claude Code plugin's guard hook |
| `skills/` | The skills, shared by every host |
| `docs/` | Architecture and design documents |
| `tests/` | Tests, grouped by area |

Dependencies point one way: `src/lib` imports nothing from `src/tools` or `pi`, and `src/tools` imports nothing from `pi`.

### Editing skills

`skills/` is the only copy of the skills, and Claude Code, Pi and `npx skills add` all read it directly. There is no
generated output and no build step, so edit the files in `skills/` and commit them. To keep one text valid for every
host:

- Refer to another skill by name: ``the `implement-task` skill``. Do not write `/skill:implement-task` or
  `/delivery-pipeline:implement-task`.
- Refer to tools by bare name: `execute_and_review`. Do not write Claude Code's
  `mcp__plugin_delivery-pipeline_delivery__` prefix.
- Say "the agent", not "Pi" or "Claude".
- Put host-specific instructions in `pi/*/README.md` (Pi) or `docs/claude-code.md` (Claude Code), not in a
  skill.

(`docs/workflow-overview.md`, `pi/delivery-prompt/delivery-rules.md` and the extension READMEs are Pi documentation and may use `/skill:`.)

Claude Code resolves the bare names against the tool list it is shown, and a skill name to the plugin's
`delivery-pipeline:<skill>`. After changing how a skill refers to a skill or tool, check it in a live session with
`claude --plugin-dir /path/to/delivery-pipeline`.

Tests that drive the real Scaffold CLI need it installed (CI checks out `jared-two-foxes/scaffold`; set
`SCAFFOLD_SOURCE` to a checkout). Without it those tests fail or skip; the rest run standalone.

## Licence

MIT; see [`LICENSE`](LICENSE).
