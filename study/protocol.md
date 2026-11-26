# PlayFinder within-subject study protocol

## Research question

How do Popularity, BPR, and Hybrid recommendations differ in perceived
relevance, discovery quality, satisfaction, and observable interaction for PC
players using the same profile, candidate set, exclusions, filters, and MMR?

## Participants

- Target: 15–20 adult PC players.
- Inclusion: plays PC games at least monthly and can read the study interface.
- Exclusion: participated in building PlayFinder or knows the condition/model
  mapping.
- Record only a study ID and broad gaming-experience band. Do not collect
  direct personal identifiers.

## Design

- Within-subject: every participant uses all three conditions.
- Blinded: participants see round numbers, not model names.
- Counterbalanced: participant number selects one of six orders.

| Participant number modulo 6 | Sequence |
|---:|---|
| 1 | A → B → C |
| 2 | A → C → B |
| 3 | B → A → C |
| 4 | B → C → A |
| 5 | C → A → B |
| 0 | C → B → A |

Assign IDs consecutively from `P01`. Do not choose IDs to give a participant a
preferred order.

## Questionnaire delivery

The ten Likert items and the two final open questions are answered **inside the
prototype**, not on paper and not in a spreadsheet. The moderator never types a
questionnaire answer, a participant ID, a round number or a condition letter
into a CSV.

- Finishing a round opens the ten items automatically. All ten must be answered
  before the round can advance, so a round cannot be skipped or left partial.
- Each submission is timestamped by the page at the moment the participant
  submits, immediately before that round's `round_completed`. Answers therefore
  cannot be back-filled after the session.
- `participant_id`, `round` and `condition` are written from study state, and
  `preferred_condition` is derived from the assigned sequence. The join keys are
  never hand-entered.
- Participants still see only the round ordinal. The condition letter appears in
  the exports, never on screen.

`questionnaire.md` remains the source of truth for the wording; the page renders
those exact items and a regression test fails if they drift apart.

## Moderator script

1. Explain that the study compares recommendation lists, not the participant.
2. Explain that interactions are stored locally and exported under a study ID.
3. Obtain consent before opening the prototype, and record the consent time in
   `participant-register.csv`.
4. Ask the participant to choose exactly three tastes and their real budget and
   playable platform(s).
5. Enter the assigned participant ID and begin the study.
6. For each round:
   - read Task 1 and Task 2;
   - do not recommend games or explain the hidden model;
   - when the participant is finished, ask them to press
     **ANSWER THE TEN QUESTIONS** and answer all ten themselves. Do not read the
     items aloud or suggest a value.
7. After Round 3 the two open questions appear automatically. Let the
   participant type their own answers and remind them not to include their name,
   email address or Steam username.
8. Export all four files, confirm the participant ID and three completed rounds,
   then start a new participant.

## Exports

Every participant produces four files, all named
`playfinder-<participant>-<session>`:

| File | Contents |
|---|---|
| `.json` | full event log |
| `.csv` | the same event log, 15 columns |
| `-likert.csv` | three rows, one per round, headers identical to `templates/likert-responses.csv` |
| `-open-responses.csv` | one row, headers identical to `templates/open-responses.csv` |

`study/analysis/analyze_study.py` reads the event CSV and the Likert CSV
directly, with no transformation. `EXPORT LIKERT CSV` shows how many of the
three rounds have been answered and stays disabled until at least one exists;
`EXPORT OPEN RESPONSES CSV` stays disabled until the two open questions are
submitted. Treat a count below `3/3` as an incomplete session.

Only `participant-register.csv` is still filled in by the moderator: study ID,
sequence, age band, gaming frequency, platforms, consent time, the `pilot` flag
and notes.

## Timing

- Introduction and consent: 2–3 minutes.
- Onboarding: 2 minutes.
- Each recommendation round and its ten questions: 4–6 minutes.
- Final open questions: 3 minutes.
- Expected total: 20–25 minutes.

Do not impose a strict browsing time limit. Dwell time is an outcome. The
moderator may remind a participant of the task after prolonged inactivity but
must record the intervention in study notes.

## Pilot gate

Run one pilot that is not included in the final sample. Confirm:

- the intended sequence is assigned;
- all three rounds use the same profile;
- cards, filters, details, wishlist, like/dislike, and Not Interested work;
- `round_started`, impressions, clicks, dwell, feedback, and
  `round_completed` are present;
- the ten items appear after each round, block progression until complete, and
  emit `round_survey_submitted`;
- the two open questions appear after Round 3 and emit
  `open_responses_submitted`;
- all four files export successfully and the Likert export reports `3/3`;
- each Likert `submitted_at` sits inside its own round, immediately before that
  round's `round_completed`;
- the Likert and open rows join to the event log on
  `participant_id + round + condition`.

## Ethics and data handling

- Participation is voluntary and may stop at any time.
- Do not ask participants to sign into Steam or disclose their library.
- The chosen taste/profile is an experimental match, not a claim about
  identity.
- Interactions in A's data represent reviewed/seen activity, not ownership.
- Store de-identified exports in a restricted team folder and report aggregate
  results. Remove accidental identifiers from open-text responses before
  submission.
