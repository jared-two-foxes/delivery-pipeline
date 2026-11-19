# Caller-selected task verification

`execute_and_review` takes an ordered `checks` list defining the verification
commands for an issue. Every check must be read-only: Review accepts check
evidence for one source snapshot, so a check that modifies the working tree
(`cargo fmt` instead of `cargo fmt --check`, a format-then-verify chain such as
`cargo fmt && cargo fmt --check`, a linter with `--fix`) stops the run
with `CHECK_MODIFIED_SOURCE`, naming the check. Its changes are kept in the working
tree and the attempt is retained, so the correction is to swap its command for the read-only
form with a `repair_check` context update and continue with `previousAttempt`. If a stage stops before it can retain its own
receipt (`STAGE_RECEIPT_MISSING`), the message carries that stage's own error.
For example (Cargo filters are illustrative; choose
actual crate and test names for the project):

```json
{
  "checks": [
    { "name": "compile", "command": ["cargo", "check", "--all-targets"] },
    { "name": "invoice unit tests", "command": ["cargo", "test", "--lib", "invoices::"] },
    { "name": "client unit tests", "command": ["cargo", "test", "--lib", "clients::"] }
  ]
}
```

On the first attempt, supply `checks` alongside `input`, `requirements`,
`baseRef`, task/review settings and the required native
`checkpoint: {defaultBranch, protectedBranches}` metadata.

Continuations may omit `checks` to inherit the retained verification plan.
Explicitly supplied plans remain subject to the existing correction and
verification-repair rules.  No build or test commands are added automatically.

The list required 1-64 checks with unique nonblank names, no surrounding
whitespace and at most 256 characters per name.  Each check contains `name`,
an executable/argv `command` array, and an optional executable/argv
`successCondition` array.  Commands run sequentially from the repository root
through Conductor.  Per-check timeout options are not supported.

A first attempt may not use a bare full-suite check. `lib/verification/check-scope.mjs`
recognizes a plain `cargo test` / `cargo nextest run`, `npm|pnpm|yarn|bun test`, `pytest`
(also `python -m pytest`), `go test ./...`, `dotnet test`, `node --test`, `vitest`, `jest`,
`mocha` and `ava` with nothing narrowing the run, and returns `BROAD_CHECK_UNJUSTIFIED`
before any source operation. A test name, path, package, `--test`/`--lib`, `-k`/`-m`,
`--filter` or similar selector makes a check targeted. When the whole suite is genuinely
required, name the check and say why:

```json
{ "broadCheckJustifications": [
  { "check": "integration", "reason": "The runner cannot select the affected tests individually" }
] }
```

Each reason must be 20-2000 characters and name an existing check (`BROAD_CHECK_JUSTIFICATION_INVALID`
otherwise). The reasons are retained with the receipt's `args`. Continuations and
resumed issues with a retained plan inherit that plan and are not re-checked, so work
in flight is never stranded. This is a guardrail against accidental cost, not a
security boundary: shell-wrapped commands such as `sh -c "cargo test"` are not
inspected, and anything that could be a selector is treated as targeted so that
ambiguity never blocks a legitimate check. It is not applied when the design graph is
finished, because designs are free text owned by Scaffold; the first attempt is where a
structured plan first exists. The final `validate_feature` plan is full-project by design.

Choose verification during task design and include the commands and their scope
within the approved feature direction. Use focused tests for task changes and broader regression
checks for the final `validate_feature` gate. Inspect output to confirm relevant
tests actually ran; an exit code of zero can also mean the filter selected no tests.
The existing overall workflow deadline and independent review budgets still apply.

Task receipts retain the exact caller inputs and translated request. Corrections
must preserve the normalized ordered names and commands, including test filters;
changing verification scope requires reconciliation within the approved direction rather than
weakening the existing attempt. The pre-review source/index snapshot is captured
after the **last** requested command succeeds, even if that check is not a test.
All requested check results must appear in order, exactly once, and satisfy
their configured success rules.  Without a successCondition, command exit code
zero is required.  WHen a successCondition is supplied, its sucessful evaluation
is required.  An APPROVED independent review is also required before task evidence can justify a
checkpoint.  `validate_feature` keeps its existing full-project verification interface.

After updating, copy the entire extension directory (including `verification.mjs`)
and restart Pi. Upgrade the installed Conductor binary for the v2 command API.
This version requires Conductor with `success_condition` support (PR #8 or later).

Run `node --test tests/delivery/verification.test.mjs tests/conductor/conductor.test.mjs tests/workflow/task-workflow.test.mjs tests/delivery/checkpoint.test.mjs`.
