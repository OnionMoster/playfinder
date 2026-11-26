# Section 4.5 — User study

## Design

The study used a blinded within-subject design. Twenty adult PC players
completed Popularity, BPR, and Hybrid conditions while the
interface labels them only as three recommendation rounds. Participant IDs
cycle through all six possible condition orders.

Each round uses the same assigned real profile and the same participant
preferences. The participant completes two tasks: first identifying a game
they would genuinely consider, then applying real budget and platform
constraints to make a final accept/reject decision. After each round, the
participant answers ten 1–7 Likert items. Two open questions follow the final
round.

## Measures

Behavioural measures include impressions, game-card clicks, unique games
opened, detail dwell time, likes, dislikes, wishlist changes, Not Interested,
acceptance, rejection, and round completion. The primary subjective outcome is
Q10 overall satisfaction. The primary offline measure is user-level NDCG@10
from B's `seen_users_only`, `overall` evaluation scope.

## Analysis

Condition summaries report completion, satisfaction, relevance, discovery
quality, constraint fit, acceptance, rejection, games opened, and dwell time.
Continuous and ordinal outcomes use a Friedman within-subject omnibus test and
Holm-adjusted Wilcoxon signed-rank pairwise comparisons. Binary outcomes use
Cochran's Q and Holm-adjusted exact McNemar comparisons. Condition means have
10,000-replicate participant-bootstrap 95% intervals.

Online/offline association is evaluated using Spearman and Pearson correlation
with usable pair counts and participant-cluster bootstrap intervals.

Three observations per participant are not independent, which is why the
condition comparisons are paired. In the 60 matched online/offline rows, 58
NDCG@10 values are zero. Coefficients are therefore presented with zero rates,
sample sizes, and uncertainty rather than as a decisive validation of the
offline metric.

## Results

Twenty-one sessions were received; one session with an invalid participant ID
was excluded before analysis. The final sample contains 20 participants, 60
complete participant-condition rounds, and 600 valid Likert responses. Every
analysed participant completed A, B, and C once.

| Condition | Satisfaction | Relevance | Discovery | Constraint fit | Accept | Reject | Dwell (s) |
|---|---:|---:|---:|---:|---:|---:|---:|
| A — Popularity | 4.85 | 4.95 | 4.925 | 5.175 | 0.95 | 0.90 | 5.38 |
| B — BPR | **5.50** | **5.40** | **5.525** | **5.525** | 0.95 | 0.95 | 10.79 |
| C — Hybrid | 5.30 | 5.275 | 5.30 | 5.15 | **1.00** | **0.85** | **13.11** |

BPR is descriptively highest on the four subjective means, while Hybrid is
highest on dwell and acceptance and lowest on rejection. These differences are
not statistically decisive. For the primary Q10 outcome, Friedman
χ²(2)=0.098, p=.952. No Holm-adjusted pairwise comparison is significant. The
smallest unadjusted pairwise p-value is for Hybrid versus Popularity dwell time
(p=.019), but the Holm-adjusted value is .058.

For satisfaction versus offline NDCG@10, pooled Spearman ρ=−0.082 with a
participant-cluster bootstrap 95% CI [−0.194, 0.011]; Pearson r=−0.023 with 95%
CI [−0.116, 0.041]. Because 58/60 offline values are zero, this result is
reported as unable to estimate the offline–online relationship, not as evidence
of negative correlation.

The principal limitations are the modest sample, zero-inflated offline metric,
near-ceiling accept/reject outcomes, and shallow/variable detail-page
interaction. Aggregate evidence is stored in `study/results/`; raw exports and
the participant-condition table are excluded from submission.
