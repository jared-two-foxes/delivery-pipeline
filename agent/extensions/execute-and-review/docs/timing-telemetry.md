# Timing telemetry

Delivery records where time goes so speed changes can be justified and verified.
Telemetry is additive and non-authoritative: it is never part of the request,
workflow, result, check or review data that authenticators compare, and it does
not change the digest of any command receipt handed to independent Review.
Receipts written before this existed remain valid and report no timings.

- Each stage wrapper (`command-stage.mjs`) writes `<index>.timing.json` beside its
  receipt with the stage's start time, total `duration_ms` and its parts:
  `snapshot_ms`, `handoff_ms`, `process_ms`, `snapshot_after_ms`, plus `reused`.
  A failure to write it never changes the stage outcome.
- A sealed task receipt gains a top-level `timings` field: per-stage timings,
  `execution_ms`, `checks_ms`, `review_ms`, `seal_prep_ms`, the raw event count
  of the review ledger (`review_ledger_events`) and the attempt number.
- A `validate_feature` receipt gains `timings` with each check's duration,
  `review_ms`, `total_ms` and how often (`precondition_checks`) and how long
  (`precondition_ms`) full preconditions were derived, counting the initial and
  post-authorization derivations as well as the re-checks, up to the last one before
  retention. Failed and interrupted runs keep the timings gathered so far.
- `execute_and_review` reports `telemetry` in the tool `details`: call wall time
  and the Scaffold CLI calls and time it spent. Only Scaffold invocations are
  counted (not the Git repository probe). Scaffold is called from two processes,
  Pi and the commit command Conductor launches, so the figure is their total
  with each part shown; `complete: false` means the commit process's share is
  unknown, as when finalization was blocked. The model-facing text is unchanged.
- `inspect_conductor_evidence` returns `timingSummary`. To list every receipt in a
  checkout: `node agent/extensions/execute-and-review/timing-summary.mjs [repo]`.


Not yet available: review model turns and tool calls. `review-cli` does not expose
them in its JSON result and its ledger vocabulary is not interpreted here, so only
the raw ledger event count is kept. Exposing them needs a `review-cli` change.
