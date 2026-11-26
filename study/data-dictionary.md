# Study data dictionary

## Join keys

| Field | Meaning |
|---|---|
| `participant_id` | De-identified ID such as `P01` |
| `sequence` | One of `ABC`, `ACB`, `BAC`, `BCA`, `CAB`, `CBA` |
| `round` | Participant-visible order, 1–3 |
| `condition` | Researcher-only A/B/C |
| `profile_id` | Assigned real study profile |
| `model_user_id` | Offline evaluation user linked to the profile |

## Raw behavioural outcomes

- `game_card_clicked`
- `game_detail_opened` and `dwell_time` (with `dwell_started`)
- `impression` (deduplicated per participant|condition|round|game|batch)
- `like`
- `dislike`
- `wishlist_added` and `wishlist_removed`
- `not_interested`
- `show_more_clicked`
- `filter_changed`
- `round_started` and `round_completed`

Keep raw counts and timestamps. Do not replace the raw events with derived
binary outcomes.

## Questionnaire events (in-page, added 30 July 2026)

The ten Likert items and the two open questions are answered inside the
prototype, which emits:

- `round_survey_opened` — participant pressed ANSWER THE TEN QUESTIONS;
- `round_survey_dismissed` — participant returned to browsing without
  submitting;
- `round_survey_submitted` — all ten answers stored; the event carries
  `q1_relevance` … `q10_satisfaction` and `surveySubmittedAt`, recorded at the
  moment of submission and immediately before that round's `round_completed`;
- `open_responses_opened` and `open_responses_submitted` — the two final open
  questions after Round 3;
- `likert_csv_exported` and `open_responses_csv_exported` — questionnaire
  export actions, alongside the existing `json_exported` and `csv_exported`.

## Derived online outcomes

| Outcome | Definition |
|---|---|
| `accepted_any` | at least one `like` or `wishlist_added` in the round |
| `rejected_any` | at least one `dislike` or `not_interested` in the round |
| `unique_games_opened` | distinct games with `game_detail_opened` |
| `total_dwell_seconds` | sum of valid `dwell_time` milliseconds / 1000 |
| `wishlist_count` | distinct games whose final state is wishlisted |
| `satisfaction` | Q10 |
| `perceived_relevance` | mean of Q1 and Q2 when both are present |
| `discovery_quality` | mean of Q3 and Q4 when both are present |
| `constraint_fit` | mean of Q6 and Q7 when both are present |

## Offline outcome

Primary offline comparison: user-level `ndcg_at_k` at `k=10` for
`scenario=seen_users_only` and `scope=overall`, joined by
`model_user_id + model/condition`.

Offline NDCG is computed from held-out interactions and does not measure the
same construct as subjective satisfaction. Correlation is descriptive, not
causal, and with 15–20 participants will be statistically uncertain.

## Missing data

- Preserve unanswered survey items as missing, not zero.
- Exclude a participant-condition pair from a specific correlation only when
  either that online value or its offline NDCG is missing.
- Report the number of usable pairs for every correlation.
- Do not silently replace incomplete event exports.
