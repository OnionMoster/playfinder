# PlayFinder formal study freeze record

Recorded by member E on 29 July 2026 after the group accepted the final
profile-domain and platform behavior.

## Frozen identities

- A data release: v1.0.
- B evaluation release: unchanged local `final_eval`, created
  `2026-07-27T09:05:16.442657+00:00`.
- Split cutoff: `1641340800`.
- Candidate rows: 20,435.
- Candidate SHA-256:
  `01b6bae167febed5b2012c3d8a348d0a3463d3460c9892e58b661653106246ed`.
- Seen cohort: 5,119; true-new cohort: 229.
- Seen exclusion: every training-period reviewed/interacted item regardless of
  label. This is not ownership data.
- Conditions: A = Popularity, B = BPR, C = Hybrid.

## Frozen profile policy

- Policy: `top-5-enumerated-v2`.
- Profiles/model users: 46, with no reused model user.
- Jaccard threshold: 0.5.
- Selectable domain: 558 evidence-backed combinations.
- Every selected profile taste has training-positive evidence.
- Every one-taste and two-taste prefix has at least one legal completion.
- Unsupported triples:
  - Roguelike + Cozy + Open World
  - Cozy + Survival + Turn-Based
- The six symmetric disabled-third mappings are stored in the formal manifest
  and `third-taste-availability.csv`.

## Frozen common platform policy

The same rule applies after Popularity, BPR, and Hybrid rankings:

1. A game matches a platform only when that platform appears explicitly in A's
   source metadata.
2. Missing platform metadata remains unknown and is never inferred.
3. An unknown-platform game is excluded whenever a platform filter is active.
4. If strict budget/platform/genre/tag filters leave fewer than six games, the
   interface shows the honest short list.
5. No catalogue fallback, rank padding, filter relaxation, or invented
   metadata is allowed.

Missing-platform recommendations and short-list states are formal warnings,
not errors.

## Formal build result

- Formal input: `study-data/incoming/final/`.
- Validator: 0 errors, 22 warnings, all sections executed.
- Supported coverage: 558/558 at Jaccard at least 0.5.
- Ranking rows: 4,600 for each condition.
- Candidate and seen leakage failures: 0.
- Generated standalone: `PLAYFINDER.html`.
- Browser QA: desktop and 390×844 mobile viewports, no visible fixture or
  provisional banner, no console warnings/errors, and onboarding interaction
  verified.

The formal HTML was used after an excluded pilot. The subsequent formal sample
contains 20 complete participants and 60 participant-condition rounds. Raw
participant exports remain outside Git; only aggregate results, statistical
tests, figures, and the executed notebook are submission candidates. The
frozen rankings and serving rules above were not changed after collection.
