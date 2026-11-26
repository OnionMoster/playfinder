# PlayFinder user study

This directory contains E's reproducible study protocol and analysis handoff.
The experiment is a blinded, within-subject comparison of three recommendation
conditions:

- A — Popularity
- B — BPR
- C — Hybrid

Participants see only **Round 1**, **Round 2**, and **Round 3**. Model names and
condition letters are researcher-facing.

## Final sample

Twenty eligible adult PC players completed all three conditions. Participant
IDs `P01`–`P20` deterministically assigned the six possible condition orders.
Twenty-one sessions were received; one invalid-ID session was excluded before
analysis. The final analysis contains 60 complete participant-condition rows.

## Frozen collection procedure

The supported-domain and platform rules were frozen, the three-condition
package passed formal validation, and an excluded pilot completed the full flow
before the formal sample began.

## Files

- `protocol.md` — moderator procedure, consent, timing, counterbalancing.
- `tasks.md` — the two participant tasks.
- `questionnaire.md` — ten Likert items and two open questions. This is the
  source of truth for the wording; the prototype renders these exact items.
- `data-dictionary.md` — raw and derived study variables.
- `templates/` — column contracts. `likert-responses.csv` and
  `open-responses.csv` are the headers the prototype's own exports must match,
  not forms to fill in by hand. `participant-register.csv` is still filled in by
  the moderator.
- `analysis/` — offline-metric extraction and correlation analysis.

## Questionnaire and exports

Participants answer the ten Likert items and the two open questions **inside the
prototype**. The page administers the ten items when a round ends, blocks
progression until all ten are answered, timestamps each submission at the moment
it happens, and fills `participant_id`, `round` and `condition` from study
state. No questionnaire answer or join key is typed by a moderator.

Each participant produces four files named
`playfinder-<participant>-<session>`:

| File | Contents |
|---|---|
| `.json` | full event log |
| `.csv` | the same event log, 15 columns |
| `-likert.csv` | three rows, one per round |
| `-open-responses.csv` | one row |

Export all four immediately after each participant, check that the Likert export
reports `3/3`, and store them outside the submitted repository until
de-identification is complete. `analysis/analyze_study.py` consumes the event CSV
and the Likert CSV with no transformation.

Do not collect names, Steam usernames, email addresses, or other direct
identifiers. The open-text answers are the only free-text field in the study, so
check them for accidental identifiers before analysis.
