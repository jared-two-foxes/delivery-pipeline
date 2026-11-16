---
name: feature-questions
description: >
  Manual, read-only. Given an implemented (or partly implemented) Scaffold feature,
  list the questions its implementation would be expected to answer: contracts,
  preconditions, postconditions, invariants and edge cases. It asks; it never
  answers, judges or fixes. Run only when the user asks for it.
disable-model-invocation: true
---

# Feature questions

Use this skill **only when the user explicitly invokes it**. `{{skill:feature-delivery}}`,
`{{skill:implement-task}}` and every other workflow must never call it, and finishing a
feature does not trigger it.

## Purpose

Produce a list of questions about the feature's current implementation that a careful
reviewer would want answered: what it promises, what it assumes, what it guarantees and
where it is most likely to break. The user then investigates the code by hand, or uses
individual questions as the start of later prompts.

This is **not** a review and **not** a gate. It does not decide whether the feature is
correct, and nothing it produces is evidence of anything.

## Hard limits

- **Ask, never answer.** Do not answer a question, hint at the answer, say whether the
  code handles a case, say whether a test exists, or rate severity or risk. If you can
  see the answer in the code, either ask the question in a form that does not reveal it
  or drop it.
- **Read-only.** Use `{{tool:scaffold_tasks}}` only with read operations (`summary`,
  `list`, a scoped `issue` query) and Git only to read (`diff`, `log`, `show`,
  `rev-parse`, `ls-files`) plus file reads and searches. Never call
  `{{tool:execute_and_review}}`, `{{tool:run_feature_checks}}`, `{{tool:validate_feature}}`,
  `{{tool:review_changes}}`, any approval, checkpoint or recovery tool, and never
  change source, Scaffold state, Git state or evidence.
- **No new work.** Do not start, create, reorder or complete issues, and do not suggest
  that a question blocks completion.
- **Keep the worktree clean.** The delivery gates need a clean worktree. Present the
  result in the conversation. Write a file only if the user names a path, and warn
  them if that path is inside the repository and not ignored.

## Inputs

1. The feature id. `{{tool:scaffold_tasks}}` requires a `feature_id` for every
   operation, even `summary`, so it cannot list features for you. Use an id that is
   unambiguous from the conversation (the user named it, or this session just worked
   on exactly one feature). Otherwise **ask the user for the feature id before
   querying Scaffold**; do not guess one.
2. Scaffold state from `{{tool:scaffold_tasks}}` `list` and scoped `issue` queries: the
   approved direction (`context`), the feature `acceptance_criteria` and `constraints`,
   and for each issue its criteria, designs and contracts, delivery obligations and any
   amendments. Treat these as the *stated intent*.
3. The implementation: the diff from the feature's original baseline to current `HEAD`,
   then the code around each changed symbol (callers, callees, data types, error paths)
   so that questions are about the real code, not the diff hunk alone.

State at the top of the output the feature id, baseline, `HEAD`, and how many issues are
completed out of the total, so a partly implemented feature is not mistaken for a
finished one.

## What to ask about

Look for these in the implementation and in the gap between it and the stated intent:

- **Contracts**: inputs accepted and rejected, outputs and their shapes, error types and
  messages, what callers may rely on, public names and formats, compatibility with
  existing callers and persisted data.
- **Preconditions**: what must already be true before an entry point runs (state,
  ordering, authorization, resources, configuration, types and ranges) and what happens
  to callers that do not meet it.
- **Postconditions**: what must be true afterwards on success, on failure and on partial
  failure (state written, resources released, events emitted, files left behind).
- **Invariants**: properties that must hold across operations, across issues, or across
  module boundaries, and where each is established and where it could be broken.
- **Edge cases**: empty, missing, duplicate, boundary, oversized, malformed, concurrent,
  repeated (idempotency), reordered, interrupted, and time- or locale-dependent inputs.
- **Seams between issues**: places where two issues' pieces meet and neither issue's own
  contract obviously covers the combination.
- **Intent gaps**: an acceptance criterion, constraint or obligation with no obvious
  corresponding code, or code with no obvious corresponding criterion.

Prefer fewer, sharper questions. Aim for roughly 15 to 40, most important first within
each group. Do not pad with generic questions that apply to any code (for example
"what if the input is null?" without a specific parameter that can be null).

## Grounding rule

Every question must be anchored to something specific, or it is dropped:

- a changed file and symbol or line range (`path:symbol` or `path:start-end`), and
- the source of the concern: a feature criterion, constraint, issue id, obligation id,
  or "no stated intent" for an implementation detail nobody specified.

## Output format

Use stable ids so the user can refer to them (`Q1`, `Q2`, ...), numbered once across the
whole list. Group by the headings above, omitting empty groups.

```
# Questions for feature <id>
Baseline <sha> .. HEAD <sha> · issues completed <n>/<total> · generated <date>
These are questions only. Nothing here is an answer, a finding or a verdict.

## Contracts
**Q1** <the question, one or two sentences>
- Where: `path/to/file:symbol`
- Source: <criterion, constraint, issue or obligation id, or "no stated intent">
- Look at: <the specific thing to read or run to find the answer, not the answer>
```

End with one short line telling the user they can ask you to investigate any question
by id, or to turn a selection into a prompt. Do not investigate anything unprompted.
