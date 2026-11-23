# Requirement traceability

Scaffold owns feature requirements: their stable ids, their text, which tasks contribute to or
verify each one, and the evidence associations that say a task did. The delivery pipeline keeps
no second copy. It carries Scaffold's ids through execution and review, authenticates the external
results, and records evidence in Scaffold only from what it has authenticated.

## Identity

A canonical requirement is named `requirement:<id>` everywhere in the pipeline, where `<id>` is
Scaffold's own id (`SA-1.AC1`, `R1`). It is never a list position and never a digest of the text,
so it is the same in every task, attempt, review, receipt and evidence record.

Other review items keep their own prefixes and can never collide with a requirement:

| Item | Id | Source |
|---|---|---|
| Canonical requirement | `requirement:<id>` | Scaffold (`issue` query) |
| Feature objective / constraint | `feature_objective-…`, `feature_constraint_<n>-…` | feature definition |
| Task-local criterion / constraint | `issue_criterion_<task>_<n>-…`, `issue_constraint_<task>_<n>-…` | the task's contract |
| Review finding / failed check | `finding-…`, `check-…` | retained attempts |
| Discovery / amendment | `obligation-…` or a chosen id, `amendment-…` | `contextUpdates` |

`add_obligation` is refused for an id that starts with `requirement:` or equals an original
contract item. `approve_delivery_amendment` and `apply_amendment` refuse a canonical requirement:
changing one is a material scope change made through the feature design and its approval.

## Task scope and roles

`execute_and_review` reads the task's requirements from Scaffold's `issue` query. A task's roles
come from Scaffold's contributor and verifier sets, the same sets Scaffold checks evidence against.
A childless root therefore contributes to and verifies every requirement, and a decomposed root sees
the requirements with no role.

The rendered review context lists:

- `requirements`: the ids this task contributes to or verifies, with its roles. The reviewer must
  assess each with `obligation_assessments` `{obligation_id: "requirement:<id>", disposition:
  "verified", evidence}`.
- `deferredRequirements`: ids visible to this task but assigned to other tasks. They are context only.
  This task neither satisfies nor waives them.

## Task gate

A PASSED attempt also needs an explicit `verified` assessment with evidence for every required
requirement in the same review. This applies even when the task changed nothing. `not_applicable`,
`unresolved`, a missing assessment, a bare or wrong id, or `verified` without evidence all block, and
the result names each id and what the review said. If a requirement really belongs to another task,
fix the mapping through the issue design. The reviewer cannot waive it.

Requirement assessments are not carried between attempts. The evidence cites the completing attempt,
so that attempt's own review must verify the requirement. Dynamic finding and check obligations keep
their existing rules, including deferring a `not_applicable` one to final validation.

## Evidence at completion

Before Scaffold `complete`, finalization records one `evidence-record` per requirement and role:

- `receipt` and `tree` are the authenticated completing attempt's.
- `design` is the task's approved design record.
- `binding` is Scaffold's digest of the requirement's current contributors and verifiers.
- `basis` is `independent-review`. The task gate admits only an APPROVED review that verified the
  requirement, so checks alone are never recorded as independent verification.
- `reference` is a retained `pi.requirement-evidence/v1` artifact holding the requirement, role, tree,
  binding and the reviewer's assessment.

Finalization re-reads the scope first. If Scaffold's current required set (ids, text and roles) is not
the one the review assessed, it refuses with `REQUIREMENT_SCOPE_CHANGED` and records nothing. The
artifact content is deterministic, so a retried finalization replays identical associations, which
Scaffold accepts without duplicating them.

## History rewrites

A rebase changes checkpoint trees, which makes recorded evidence stale. Once `rewrite_feature_history`
has recorded the rewrite, it carries each applicable association onto its task's new checkpoint tree
with `evidence-equivalence`. Each one cites a `pi.requirement-evidence-equivalence/v1` artifact that
names the retained verification of the rebased result (fresh full-project checks and an independent
review). Repeating the reconciliation finishes an interrupted carry-over and adds nothing new. If the
carry-over fails after the rewrite is recorded, the result says so
(`REQUIREMENT_EVIDENCE_CARRY_INCOMPLETE`) and does not claim nothing changed.

## Changed coverage bindings

Adding a corrective task as another contributor or verifier changes that requirement's binding, and
Scaffold marks all of its earlier associations stale. At the start of `validate_feature` and
`run_feature_checks`, each stale association is re-recorded under the current binding only when all of
these hold:

- the task is still completed with the same receipt, design and checkpoint tree;
- it still holds the role;
- the receipt re-authenticates, and its independent review verified that requirement in that role.

Each re-recorded association cites a `pi.requirement-evidence-rebinding/v1` artifact naming the
previous association. The result's `requirementEvidence` lists what was re-bound and what was skipped
and why. Anything skipped stays stale and blocks.

## Final validation

Both final gates read Scaffold's `requirements` view before running any project check. Every
requirement must be `satisfied`. Coverage problems, `missing`, `unresolved` and `stale` block with
`REQUIREMENT_EVIDENCE_INCOMPLETE`, naming each requirement and each outstanding task and role.

`validate_feature` also gives the final reviewer every canonical requirement on a
`Requirement obligations:` line, with its id, text, coverage status, whether verification was
independent, and the evidence references. The review covers the whole approved range from the
original baseline. A PASSED result needs a `verified` assessment with evidence for every
`requirement:<id>`, and retained results are re-authenticated against the same rule.

`run_feature_checks` stays checks-only. Its PASSED result is `checked`, never `verified`, and user
acceptance remains a separate state.

## Current limitations

- Scaffold does not return the per-requirement binding digest. The pipeline computes it from the
  contributor and verifier sets with the same canonical JSON (tested against Scaffold's own function).
- Scaffold's `evidence-equivalence` annotates only the first association for a task, requirement, role
  and receipt. So an association whose binding changes after its checkpoint was rewritten is not
  re-bound: it is reported as skipped ("the checkpoint tree was rewritten after this association"),
  stays stale and blocks. Re-run the affected task.
