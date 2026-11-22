---
name: from-design
description: >
  Manual step after init-feature has presented a feature design: the user's invocation approves
  that design, then the issue graph is designed and finished. Invoke with a feature ID.
disable-model-invocation: true
---

# Continue a feature from its approved design

The user invoking `/from-design <featureId>` **is** the direction approval. Never run this skill
on your own initiative or because the user said "looks good" in chat; they must invoke it.

1. `scaffold_tasks summary` for the feature. It must exist, be in the Design phase and have a
   `design_ref`. If it is missing, already past Design, or not the feature the user named, stop
   and report. Never call `init` here.
2. Call native `approve_feature_direction` with `featureId` and the stored `design_ref` as
   `designRef`. An existing matching approval is reused. On refusal, stop and report the reason.
3. Follow `init-feature` §2 (design the issue graph downward) through `design-finish`, then §3
   (stop at the prepared-feature boundary). Do not implement, call `execute_and_review`, or
   start an issue.
4. Report the feature ID, approved direction reference and issue counts. The user continues
   with `feature-delivery`.
