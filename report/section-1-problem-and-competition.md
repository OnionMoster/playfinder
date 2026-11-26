# Section 1 — Problem definition and competitive analysis

## Problem definition

PC game discovery is not only a ranking problem. A list can have high predicted
relevance while still being unusable because it contains games the user has
already reviewed, exceeds the user's budget, does not run on the selected
platform, or repeats near-identical genres and tags. PlayFinder therefore
separates model ranking from a shared serving layer: each model supplies a
Top-100 ranking over the same candidate set, while E applies the same
training-period reviewed-item exclusion, explicit hard filters, and
deterministic MMR diversity reranking.

The research question is whether this controlled interface exposes meaningful
differences between Popularity, BPR, and Hybrid recommendations in both offline
ranking metrics and user-perceived discovery quality. PlayFinder does not claim
that Hybrid or any other model is superior before the user study.

## Competitive landscape

### Steam Discovery Queue

Steam describes Discovery Queue as a personalized mix of new, top-selling, and
similar-to-played products. Users can wishlist, follow, purchase, or ignore an
item, and Steam filters products already purchased or marked uninteresting.
The queue is effective for low-effort serial exploration and supports immediate
feedback. Its limitation for this research is experimental control: the public
experience combines several discovery signals, presents items sequentially,
and does not expose a reproducible candidate set, split, model identity, or
common post-ranking policy.

Sources: [Steam Discovery Update](https://store.steampowered.com/about/newstore?l=english),
[Discovery Update 2.0](https://store.steampowered.com/about/newstore2016/).

### Steam Interactive Recommender

Steam's Interactive Recommender learns from playtime histories across millions
of users. It provides controls for popular versus niche, recent versus classic,
and tag filtering. Steam also states that the system cannot recommend a new
release before anybody has played it. This is the closest comparator to
PlayFinder's interactive personalization, but its learned representation,
candidate generation, and evaluation split are not exposed to the user. Its
controls tune the recommendation space; PlayFinder additionally treats budget
and platform as explicit model-independent hard constraints and compares three
fixed models under one serving contract.

Sources: [Steam Labs](https://store.steampowered.com/labs),
[Introducing the Interactive Recommender](https://store.steampowered.com/news/posts/?enddate=1584723646&feed=steam_blog).

### SteamDB

SteamDB is an independent database covering Steam products, including current
players, price history, regional information, and update history. It is strong
for evidence-driven lookup and market monitoring. SteamDB states that its data
is provided as-is and that it is not affiliated with Valve. Its primary job is
catalogue intelligence rather than a controlled, user-specific recommendation
experiment; the user must translate charts, price histories, and filters into
a discovery decision.

Sources: [SteamDB](https://steamdb.info/),
[SteamDB FAQ](https://steamdb.info/faq/).

### Steam 250

Steam 250 ranks games mainly from the number of Steam review votes and their
positive approval rate. It emphasizes transparent, open-source, review-based
global rankings and explicitly contrasts this with relying only on sales.
Its own explanation notes that the ranking algorithm is intentionally blind to
game content beyond vote count and approval. This transparency makes Steam 250
useful for finding broadly well-reviewed or hidden games, but the ranking is not
personalized to an individual's training history, platform, budget, or current
taste request.

Source: [About Steam 250](https://steam250.com/about).

### Epic Games Store

The inspected Epic Games Store browse surface supports search, genre/category
browsing, release and deal-oriented discovery, and platform-oriented
categories. Its store home also uses prominent editorial and campaign
carousels. These mechanisms are effective when the user already has a genre or
commercial context in mind. However, the reviewed public pages do not explain
a reproducible user-level ranking model or expose controls comparable to a
shared three-model experiment, so PlayFinder's contribution is not a larger
storefront but an auditable recommendation comparison with explicit
constraints.

Sources: [Epic Games Store Browse](https://store.epicgames.com/browse?lang=en-US),
[Epic Games Store](https://store.epicgames.com/?lang=en-US).

### itch.io

itch.io supports discovery across a highly diverse indie catalogue using tags,
platform, price, genre, input method, session length, popularity, rating, and
recency. itch.io has also documented an account-activity/tag recommendation
algorithm and a “Fresh games” module intended to prevent stale
recommendations. The trade-off is dependence on heterogeneous creator-supplied
metadata and discovery-index eligibility. PlayFinder addresses a narrower
Steam research setting where catalogue identity, candidate membership,
training cutoff, user mapping, and ranking contracts are explicitly validated.

Sources: [itch.io recommendations changelog](https://itch.io/blog/109774/itchio-changelog-library-recommendations-enhancements-improved-jam-browsing-more),
[itch.io browse filters](https://itch.io/games/tag-indie-games),
[itch.io discovery indexing](https://itch.io/docs/creators/getting-indexed.amp).

## What is distinct about PlayFinder

PlayFinder's contribution is the combination of:

1. one shared 20,435-item candidate set and one temporal split;
2. real seen-user profiles and fixed model-user mappings;
3. identical reviewed-item, budget, platform, and metadata rules above every
   model;
4. deterministic MMR reranking rather than unbounded catalogue fallback;
5. a blinded within-subject study with all six condition orders; and
6. a planned user-level link between held-out NDCG@10 and observed satisfaction.

This is a system and evaluation contribution, not evidence that PlayFinder
already outperforms commercial stores. That conclusion depends on the formal
participant results.
