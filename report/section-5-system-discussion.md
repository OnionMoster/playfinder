# Section 5 — System-level discussion

## What the current system establishes

The model-independent serving layer is operational and tested across
Popularity, BPR, and Hybrid. It guarantees a common candidate namespace,
training-period seen exclusion, hard filters, deterministic MMR, and stable
profile assignment. This makes user-facing differences more attributable to
ranking condition than to different post-processing code.

## Limits that affect interpretation

### Reviewed interactions are not ownership

A confirmed that interactions represent reviewed/seen activity only. The
system cannot claim that it removes every owned game. The correct claim is that
it removes games reviewed or interacted with during the training period.

### Missing metadata cannot be repaired by invention

Missing source genres and platforms remain missing. Genre filters match only
explicit genres; tags can support taste evidence and tag filters but do not
become fabricated genres.

### The supported taste domain is 558 combinations

Top-5 V2 supplies 46 evidence-backed profiles and reaches Jaccard at least 0.5
for 558 of 560 three-taste combinations. The two unsupported triples require
six deterministic third-choice disables. This is a conditional policy limit,
not a claim that the underlying training data has an unconditional 558/560
theoretical ceiling.

### Platform availability uses an honest-short-list policy

All three ranking files satisfy their shared candidate and seen-exclusion
contracts. Three recommended games have missing platform metadata, and sixteen
profile/condition/platform cases contain fewer than six games at Any Price.
The common policy never guesses compatibility: an item with missing platform
metadata is excluded when a platform filter is active. When strict filters
leave fewer than six games, the interface displays the honest short list and
does not append fallback items or relax the participant's constraints.

### Offline–online correlation is uninformative in this sample

The final 20-participant study has 58 zero NDCG@10 values among 60 matched
participant-condition rows. The satisfaction Spearman estimate is −0.082 with
a participant-cluster bootstrap 95% CI [−0.194, 0.011]. This cannot establish a
negative relationship or prove that satisfaction and NDCG are unrelated; the
metric has too little variation in the sampled profiles.

### Online outcomes show trade-offs, not one winner

BPR is descriptively highest on satisfaction, relevance, discovery and
constraint-fit means. Hybrid has the longest dwell, full acceptance, the lowest
rejection rate, and the strongest corrected cold-item result. However, the
primary satisfaction omnibus test is not significant and no Holm-adjusted
pairwise comparison is significant. The system proposal should therefore be
framed as a trade-off between subjective experience, engagement, coverage and
cold-item robustness, not as evidence that one model dominates every goal.

## Next system decisions

1. Preserve the frozen rankings actually shown to participants.
2. Report online/offline results with sample size, zero rate, uncertainty, and
   no causal language.
3. Treat the 20-person study as exploratory and plan a larger study with an
   offline measure that has useful per-user variation.
4. Evaluate a deployment policy that uses Hybrid/content signals for cold
   items while retaining BPR where collaborative history is reliable.
