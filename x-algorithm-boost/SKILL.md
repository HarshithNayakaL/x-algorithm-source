---
name: x-algorithm-boost
description: Anything involving X (Twitter) strategy or writing, grounded in the real open-source For You algorithm. Audits any account - brand page, product or startup, personal brand, creator, community, job seeker, agency, brand-new zero-follower profile - for its binding constraint, and writes, rewrites and A/B-scores posts for reach, followers, or click-throughs. Use when starting or growing an X presence, drafting a tweet/post/thread/bio, planning content or posting cadence, marketing a product or launch, driving traffic or signups, monetizing a following, getting found by recruiters or clients, asking why a post or account flopped, or checking shadowban/spam-label risk. Covers retrieval, SimClusters targeting, ranking weights, filter drops, visibility filtering, account credibility/PageRank, cold-start injection, author diversity, and the reach-versus-conversion trade.
---

# X algorithm boost

## Three drivers. Pick by altitude.

- **`account.mjs`** — audits the **account**: which distribution surfaces are
  open, where credibility mass comes from, what stage you're at, what the
  binding constraint is. Start here for a fresh profile, a stalled account, a
  strategy question, or any "why is nothing working" ask.
- **`feedclone.mjs`** — reproduces a **feed** on another account. Turns a follow
  list into an ordered bootstrap plan using the real `InterestedIn` thresholds.
  Use for a new//second account, a niche or brand account that should see a
  specific industry's content, or migrating after a rebuild.
- **`score.mjs`** — audits **one post**. Use once the account-level constraint
  is understood, or when the ask really is just "make this tweet better."

Running `score.mjs` on a zero-follower account is malpractice: the post isn't
the problem, the closed in-network surface is.

Everything here is derived from **xai-org/x-algorithm** (the open-sourced For You
feed code, Aug 2026 snapshot) — the actual `home-mixer` Rust service, its
`params/param.rs` weights, its filter stack, and the `botmaker-rules` that apply
spam labels. Not from blog posts about the algorithm.

The driver is `score.mjs` in this directory. It reimplements
`ranking_scorer.rs::compute_weighted_parts` / `offset_score`, the author-diversity
multiplier, the OON discount, the cold-start eligibility test, and the drop
filters, then runs a draft through them.

## The system, from above

Four independent subsystems. Most bad advice comes from confusing them.

| Subsystem | Code | Decides | Fails as |
|---|---|---|---|
| **Retrieval** | `thunder/`, `phoenix/`, `simclusters/` | whether your post is a *candidate* at all | invisible; no impressions to explain |
| **Ranking** | `home-mixer/scorers/` | the *order* of candidates | low reach despite good content |
| **Visibility** | `visibility-filtering/` + label producers | whether it may be *shown* | sudden cliff, "shadowban" |
| **Credibility** | `user-cred-v2/` | your account's *trust mass* | slow strangulation, more labels |

Ranking is the only one most people talk about, and it's the third gate in line.
Retrieval and visibility are both binary — you're in or you're out — and they run
before and after ranking respectively.

**Credibility is the one nobody knows about.** `UserCredV2` is PageRank over the
follow graph, `score = 165.2 + 7.07·ln(mass)`, clamped to [0,100]. The teleport —
where mass is *injected* — is split 50/50 (`UserCredV2App.scala:174`):

- **50% uniform over premium accounts only** — blue/gray/gold verified, verified
  orgs and affiliates, excluding near-zero-state users. Unverified accounts are
  not in the seed set at all.
- **50% engagement-weighted over a rolling 7-day window**, where each engager's
  own mass is *divided* across everyone they engaged with.

Consequences that follow directly:

- **Who engages you beats how many.** One engagement from a high-mass account
  that engages selectively routes more mass than hundreds from near-zero accounts
  — which is also why engagement pods don't work.
- **Engagement-derived mass is rent, not equity.** 7-day window; stop earning it
  and it decays out.
- **The curve is logarithmic** — every +7.07 points costs a ×2.72 in mass. You
  buy credibility multiplicatively.
- **High PageRank buys label immunity.** `IsHighPageRankUser` guards exempt
  high-cred accounts from several spam-label bots outright. Large accounts really
  are policed more loosely, and it's in the source.

## Targeting: you do not choose what you're known for

Out-of-network retrieval has two sources, and they have different entry
requirements. **SimClusters requires >100 followers *or* >100 unique favers**
(`ProducerEmbeddingsFromInterestedIn.scala:473`) before you get a producer
embedding at all. Below that threshold you have no cluster identity and
SimClusters cannot surface you to anyone — Phoenix retrieval is your only door.

Above it, your embedding is built from the **`InterestedIn` vectors of the
accounts that fav and follow you** — not from what you write. Kept as your top 60
clusters. Three consequences:

- **Your audience assigns your topic.** Attract off-topic followers and your
  embedding drifts, and SimClusters starts showing you to the wrong people.
- **Giveaways and follower-count campaigns are actively destructive** to a brand
  or product account. They import an audience whose interests define you.
- **"Be found by the right people" is a clustering problem, not a reach problem.**
  Engagement from 20 people in your field targets you better than 2,000 randoms.

## Cloning a feed — what is and isn't an input

A feed is a pure function of viewer inputs, so it *is* reproducible — but only
the parts that are actually inputs. The split is sharp:

**Transfers by following** — the `InterestedIn` embedding, built from the
`KnownFor` clusters of the accounts you follow, plus followed topics and the
in-network pool. Two thresholds govern it
(`InterestedInFromKnownFor.scala:67-68`):

- **`socialProofThreshold = 2`** — a cluster enters your `InterestedIn` only if
  **≥2 accounts you follow** are `KnownFor` it. A single follow registers
  *nothing*. Bootstrap breadth-first, not depth-first.
- **`maxClustersPerUser = 50`** — you hold at most 50 clusters. Following
  broadly doesn't add interests, it **evicts** them.

Also: an account under 100 followers has no producer embedding of its own, so
following it inherits no `KnownFor` and it cannot supply social proof. And the
scores are kept `ProducerNormalized`, so a niche follow shapes your embedding
more per-follow than a mega-account.

**Does not transfer** — the **user action sequence**, your last **1024**
engagements (`MaxSeqLengthScoring`/`Retrieval`). This is the Phoenix model's
main input, it's behavioural rather than graph-based, and no amount of following
reproduces it. Nor do blocks, mutes, muted keywords, or seen/served history.

> Following clones the *what*. Engaging clones the *which*. Expect a clone to be
> right on topic within days and right on taste only once the sequence fills.

The embedding jobs are batch and read `KnownFor` over a 30-day window, so
follows don't change retrieval within minutes. Don't call it failed on day one.

## Account lifecycle — the binding constraint moves

| Stage | Binding constraint | The one thing that matters |
|---|---|---|
| **0 followers** | In-network *closed* (Thunder has nobody), SimClusters *closed* | Phoenix retrieval + cold start are your only doors. Replies/reposts are **zero**-reach, not low-reach. |
| **<100** | No cluster identity yet | Cross 100 followers or 100 unique favers to switch SimClusters on. Until then targeting doesn't exist. |
| **100–1000** | Cold start live and expiring | Force-injection at slot 15–16, originals under 24h. Every reply spends a slot you can't get back. |
| **1k–10k** | Cold start gone; ranking is everything | Convert reach into **mutual** follows — 5.0 → 20.0 on the reply head, permanently. |
| **10k+** | Downside risk exceeds marginal upside | mute −58.8, report −234, OON label drops. Protect the asset. |

Run `account.mjs` to get this computed for a specific account rather than read
off the table.

## Actors — three axes, not ten playbooks

Every use case reduces to a point on three axes the mechanics already price:

- **Objective** — which head you ultimately convert on (`reach` / `follow` /
  `convert` / `found`).
- **Audience** — `broad` (a ranking problem) vs `targeted` (a SimClusters
  problem). These are different subsystems and different work.
- **Risk tolerance** — how much label exposure the account can absorb before the
  OON drop rules end its discovery.

| Actor | Objective | Audience | Risk | The trap it specifically falls into |
|---|---|---|---|---|
| `brand` | convert | targeted | none | Recycled campaign copy → `COPYPASTA_SPAM`; tracking redirects → `SPAM_HIGH_RECALL` |
| `product` | convert | targeted | low | Making every post a launch, spending reach it never earned |
| `jobseeker` | found | targeted | none | Chasing reach when it needs ~20 specific people; replying to famous accounts (OON-dropped) |
| `creator` | follow | broad | medium | Volume — 4th post in 48h is worth 0.34; threads competing with themselves |
| `growth` | reach | broad | medium | Every tactic that scales by repetition is a labeling target |
| `community` | follow | targeted | low | Believing replies recruit. They retain. Recruiting is originals only. |

`node account.mjs --actor brand` prints the objective, the reasoning, and the
actor-specific traps, then tells you which `--goal` to score posts with.

**Use the axes, not the labels.** A nonprofit, a musician, a local restaurant, a
newsletter — none are in that table, and none need to be. Place them on the three
axes and the mechanics give the answer. If someone doesn't fit, say which axes
they sit on and reason from the subsystem map.

## Run the drivers, then advise

Account level — always run this first when the ask is bigger than one post:

```bash
node "$HOME/.claude/skills/x-algorithm-boost/account.mjs" --followers 0 --account-age-days 2 --posts-per-day 3 --reply-share 0.5
```

```bash
node "$HOME/.claude/skills/x-algorithm-boost/account.mjs" --followers 24000 --verified --posts-per-day 1 --reply-share 0.3
```

```bash
node "$HOME/.claude/skills/x-algorithm-boost/account.mjs" --followers 45 --actor jobseeker --posts-per-day 1
```

Flags: `--followers N` `--unique-favers N` `--following N` `--verified`
`--account-age-days N` `--posts-per-day N` `--reply-share 0..1`
`--median-engagement N` `--network-accounts N` `--actor
brand|product|jobseeker|creator|growth|community`. It prints distribution
surfaces, the credibility model with a calibration table, cold-start budget,
cadence efficiency, the binding constraint for that stage, and actor-specific
traps.

Feed replication — needs a follow list the user exports from an account they
control (`handle,topic,followers` per line; topic and followers optional but the
plan is much better with them):

```bash
node "$HOME/.claude/skills/x-algorithm-boost/feedclone.mjs" --list follows.csv --per-day 15
```

Flags: `--list FILE` `--target-topics "a,b"` `--per-day N` `--show-all`. It reads
a local file only — it does not sign in anywhere or fetch anyone's data. If the
user wants the input built from their own live feed, offer to help assemble it;
never touch an account that isn't theirs.

Post level:

```bash
node "$HOME/.claude/skills/x-algorithm-boost/score.mjs" --text "your draft here"
```

On Windows PowerShell:

```bash
node "$env:USERPROFILE\.claude\skills\x-algorithm-boost\score.mjs" --text "your draft here"
```

A/B two drafts — it prints both breakdowns and a ranking:

```bash
node "$HOME/.claude/skills/x-algorithm-boost/score.mjs" --followers 800 --text "draft A" --text "draft B"
```

Model the real situation with flags:

```bash
node "$HOME/.claude/skills/x-algorithm-boost/score.mjs" --text "Great point, and the cache invalidation is the real cost." --reply --oon --age-hours 60 --followers 40000 --same-author-rank 2
```

**Set the goal.** Reach is the default, and it is the wrong objective for anyone
selling something:

```bash
node "$HOME/.claude/skills/x-algorithm-boost/score.mjs" --goal convert --followers 900 --text "draft A" --text "draft B"
```

`--goal reach` (ranking score) · `--goal follow` (reach × P(follow)) ·
`--goal convert` (reach × P(click-through)). The A/B ranking and the lever
ordering both change with the goal, because the optimum genuinely moves.

Flags: `--media photo|video|none` `--video-ms N` `--link` `--quote` `--reply`
`--retweet` `--thread` `--oon` (viewer does not follow you) `--mutual`
`--followers N` `--age-hours N` `--impressions N` `--same-author-rank N`
`--new-viewer` `--topic-feed` `--json-out`.

Output has four blocks: **GATES** (hard drops from the filter stack),
**COLD START** (whether the post qualifies for free slot injection), **SCORE
CONTRIBUTION** (each head's weight × probability), and **HIGHEST-LEVERAGE
EDITS** (each candidate edit re-scored and ranked by net gain).

**Read the gate report before the score.** A drop is a drop; no amount of score
rescues a post the filter stack removed.

## What the numbers actually are

`param.rs` weights multiply the *predicted probability* of an action for *that
specific viewer* — not raw engagement counts. The repo says so explicitly, and
adds that report's baseline probability is >1000× lower than a like's, which is
why its weight is large. So:

- "One report cancels 468 likes" is **false**.
- Mass block/report brigading mostly poisons your ranking *for accounts similar
  to the brigaders*, because scoring is personalized.
- You cannot manufacture reach by coordinating clicks in a group chat —
  navigating directly to a post is not a ranked impression.

The driver's action weights and filter gates are verbatim from the repo. Its
per-action *probabilities* are heuristic stand-ins for the Phoenix transformer.
Trust the **ordering** of levers and the gate report; the absolute score is
arbitrary units. Say this out loud when you report results.

## The weights (home-mixer/params/param.rs defaults)

| Head | Weight | What it means for a writer |
|---|---|---|
| `share_via_copy_link` | **+20.0** | Someone copies the link to paste elsewhere. Highest-value action in the model. |
| `reply` | **+5.0** | And `+15.0` more (→ 20.0) on **original** posts from a **mutual follow**. |
| `share_via_dm` | +5.0 | DM-worthy. |
| `quote` | +5.0 | |
| `follow_author` | +4.0 | |
| `share` | +2.0 | |
| `retweet` | +1.0 | A repost is worth 1/20th of a copy-link share. |
| `favorite` | +0.5 | Likes are nearly noise. |
| `click` | +0.4 | Post-detail click. |
| `open_link` | +0.2 | |
| `video_open` | +0.07 | |
| `dwell` | +0.05 | |
| `photo_expand` | +0.05 | |
| `post_unexplored` | +0.02 | Novelty, **in-network only** by default. |
| `cont_dwell_time` | +0.004 /s | |
| `profile_click`, `vqv`, `quoted_vqv` | **0.0** | Currently contribute nothing. Video-quality-view is switched off. |
| `not_dwelled` | −0.02 | Scroll-past. Tiny weight, but it fires on most impressions. |
| `block_author` | −31.2 | |
| `not_interested` | −43.2 | |
| `mute_author` | −58.8 | |
| `report` | −234.0 | |

Composition: `net = Σ positive − Σ negative`, then `offset_score` (+0.001 if
positive; compressed toward zero if negative), then `× author_diversity`, then
`× oon_factor`.

## Hard gates — these delete the post, they don't deboost it

| Gate | Source | Rule |
|---|---|---|
| Age | `MAX_POST_AGE = 48h` | Nothing older than 48 hours is a For You candidate. |
| OON replies/reposts | `oon_retweet_reply_filter.rs` | Replies and reposts are **dropped entirely** for anyone who doesn't follow you. |
| Orphan replies | same filter | A reply whose ancestors didn't hydrate is dropped. |
| Self-reply chain | `self_reply_chain_filter.rs` | Your reply survives only if the viewer follows the account you replied to — or the chain is entirely you (your own thread is fine). |
| Conversation dedup | `dedup_conversation_filter.rs` | **One post per conversation id survives.** Posts in the same thread compete; only the top scorer is served. |
| NSFW / spam labels | `visibility-filtering/rules/tweet_rules.rs` | `SPAM_HIGH_RECALL`, `DO_NOT_AMPLIFY`, `NSFW_*`, `MALICIOUS_URL`, `FOSNR_*` are OON drop rules. |

## Multipliers you control

**Author diversity** (`ranking_scorer.rs`, decay 0.5, floor 0.25):
`(1 − 0.25) × 0.5^k + 0.25` where `k` is how many of your *higher-scoring* posts
are already in that viewer's candidate pool.

| k | multiplier |
|---|---|
| 0 | 1.00 |
| 1 | 0.625 |
| 2 | 0.4375 |
| 3 | 0.344 |
| ∞ | 0.25 floor |

Your second post of the window is worth 62% of your first; your fourth is worth
34%. Posting more does not linearly buy more reach — it cannibalizes.

**Out-of-network factor** `0.75` — applied to every post from an account the
viewer doesn't follow, **and** to your in-network replies and reposts
(`EnableOonRescoreForInNetworkRepliesRetweets` is `true`). In a topic feed it's
`0.5`. For a brand-new viewer it's `0.00001` — effectively no discovery at all
until they follow ~5 accounts.

**Cold start** (`author_cold_start.rs`): an **original** post (not a reply, not a
repost) from an author with **≤1000 followers**, under **1000 impressions**, less
than **24h old**, gets force-injected at feed slot **15–16** of 35 regardless of
score. This is the largest free lever a small account has, and it is spent on
originals only.

## The playbook that falls out of this

1. **Optimize for the copy-link share and the reply, in that order.** One
   copy-link share is worth 40 likes of weight; one reply is worth 10. Write
   things people paste into a group chat and things people can't help answering.
   Likes are close to noise.
2. **End on a real question** — not "thoughts?", an actual specific one. It's the
   cheapest way to move the 5.0 reply head.
3. **Mutuals are 4× on replies.** Reply weight goes 5.0 → 20.0 for original posts
   from a mutual follow. Following back the people who engage is a mechanical
   ranking change, not a courtesy.
4. **Originals >> replies >> reposts.** Replies and reposts can't leave your
   follower graph at all, and take the 0.75× discount even inside it. Reposts are
   worth 1.0. If you have something to say about someone's post, **quote it**
   (5.0) rather than reposting it (1.0).
5. **One post per conversation survives.** Don't spray five replies into one
   thread; they compete and four die.
6. **Space your posts.** k=1 costs 37%, k=3 costs 66%. Quality over frequency is
   arithmetic here, not advice.
7. **Under 1000 followers: post originals, under 24h old, and let cold start
   work.** Every reply and repost you make is ineligible for it.
8. **Links cost more than they return.** `open_link` is 0.2 and `click` is 0.4,
   against reply 5.0 and copy-link 20.0 — and a link pulls people off the post,
   collapsing dwell and reply. Worse, a `LOW_QUALITY` verdict *anywhere in the
   URL redirect chain* stamps `SPAM_HIGH_RECALL` on the post, which is an OON
   drop. Shorteners inherit their destination's verdict. Put the link in a reply.
9. **Hashtags do nothing.** No scoring head consumes them. They only add
   not-interested risk. Delete them.
10. **Don't reuse templates.** `BBQDuplicateTextProd.bot` clusters near-duplicate
    text offline (unigram and CJK-character jobs) and stamps `COPYPASTA_SPAM`.
    Recycling your own hook across posts is the exact detection target.
11. **Never write "RT if", "like and retweet", "tag a friend", "follow for
    more".** It's engagement bait, it reads low-trust, and it lives in the same
    neighborhood as the spam labels.
12. **Video: keep it ≥10s if you use it, but don't expect much.** `VqvWeight` is
    `0.0` and `MinVideoDurationMs` is 10000 — the video-quality-view head is
    switched off entirely right now. `video_open` is 0.07. Video earns its place
    through **dwell**, not through any video-specific head.
13. **48-hour clock.** Nothing older is a candidate. A post that hasn't moved in
    two days is finished; repost the idea as a fresh original instead.

## Reach is not money. Where they diverge, and why.

**What this repo does not contain:** any creator payout, ads-revenue-share, or
subscription-earnings logic. If someone asks how payouts are computed, say you
don't have the source and don't invent a formula. What *is* here is the
distribution layer — which is the input to every monetization path.

The code makes one uncomfortable thing explicit: **the two actions that convert
are the two worst-paid heads in the model.**

| Action | Weight | Role in your funnel |
|---|---|---|
| `profile_click` | **0.0** | Predicted and logged to Kafka — contributes *nothing* to ranking. |
| `open_link` | **0.2** | The click that earns you money is worth 1% of a copy-link share. |
| `follow_author` | **+4.0** | The one funnel step the algorithm actually pays for. |

So a click is **spent** reach, not earned reach. Every conversion-driving element
you add makes the post rank worse for the next viewer. That is a real trade with
a real exchange rate, and `--goal` is there to price it rather than pretend it
away.

**The consequences, in order of how much money they move:**

1. **Build the follow, monetize the follower.** `follow_author` is 4.0 — the
   algorithm subsidizes audience growth and taxes direct selling. The funnel that
   compounds is reach → follow → convert later, not reach → click → convert now.
   A follow keeps paying on every future post; a click pays once.
2. **Paywalled posts have zero acquisition surface.** `IneligibleSubscriptionFilter`
   drops subscriber-only posts for every viewer not *already* subscribed. Your
   paid content cannot recruit — structurally, not as a matter of degree. Free
   posts are the entire top of funnel. Never put the hook behind the paywall.
3. **Link in a reply, not in the post.** You keep the reach (no dwell/reply
   collapse, no `SPAM_HIGH_RECALL` exposure from the URL redirect chain) and the
   people who want the link still get it. When you *do* need the link in-post —
   a launch, a deadline — run `--goal convert` and accept the reach cost knowingly.
4. **Under 1000 followers, cold start is your entire ad budget.** Free injection at
   slot 15–16, originals only, under 24h, under 1000 impressions. A new business
   account that spends its posts on replies and reposts forfeits the only free
   distribution X gives it.
5. **Mutuals are a business asset.** 5.0 → 20.0 on replies is the largest
   controllable multiplier in the system. Following back engaged accounts is a
   mechanical change to your distribution, not networking etiquette.
6. **Spam labels are revenue events, not slaps on the wrist.** `SPAM_HIGH_RECALL`
   and `COPYPASTA_SPAM` are *out-of-network drop* rules — they don't dampen you,
   they remove you from discovery entirely. Recycled templates and shortener
   links are the two fastest ways for a promotional account to lose its funnel.

**Report the trade, don't hide it.** When a conversion-optimal draft costs reach,
give the user both numbers and let them choose. That is the difference between
this skill and generic growth advice.

## Workflow when someone asks you to write or fix a post

0. **Establish altitude first.** If you don't know the follower count and the
   goal, you cannot answer. For anything broader than one draft, run
   `account.mjs` before `score.mjs` — the binding constraint at 0 followers is
   not a wording problem and no rewrite will fix it.
1. **Ask what the post is for** if it isn't obvious — reach, followers, or
   clicks. It changes the answer, and guessing wastes the run.
2. Draft 2–3 genuinely different versions — not one version with words shuffled.
3. Run them through `score.mjs` with realistic `--followers`, `--goal`, and
   network flags.
4. Fix every `[DROP]`, then every `[WARN]`, then work down the lever list.
5. Report: the gate findings, the top 2–3 levers with their deltas, the
   reach-vs-conversion trade if they conflict, and the rewritten post. Say that
   the priors are heuristic.
6. If the ask is cadence or strategy rather than a single post, answer from the
   author-diversity table, the cold-start rules, and the funnel section above.

Never claim a specific reach or revenue number will follow. The gates are
certain, the weights are real, the ordering is defensible; the magnitudes are
not yours to promise.

## Gotchas

- **`offset_score` flattens the negative branch.** Any post with `net < 0` is
  compressed into a band near 0.001, so `final` deltas between two bad drafts are
  meaningless. That's why the driver ranks levers on `net`, not `final`.
- **`positive_sum` excludes the continuous heads.** `cont_dwell_time` and
  `cont_click_dwell_time` are in the score but not in the normalizer
  (`ranking_scorer.rs:105`). Faithfully reproduced; looks like a bug, isn't ours.
- **The bidirectional boost only applies to originals.** `bidirectional_boost_eligible`
  requires `in_reply_to_tweet_id.is_none() && retweeted_tweet_id.is_none()`. A
  mutual's *reply* gets no boost.
- **`post_unexplored` is in-network only** by default
  (`PostUnexploredWeightInNetworkOnly = true`), so the novelty bonus does nothing
  for discovery.
- **High-PageRank and gray-verified accounts are skipped** by several spam-label
  bots (`IsHighPageRankUser`, `IsUserGrayVerified` guards in the `.bot` rules).
  Large accounts genuinely are labeled less aggressively.
- **Weights are runtime feature switches**, defaults in the repo. Real production
  values are A/B'd per user (see `docs/BIDIRECTIONAL_BOOST_CHANGE.md`, where the
  reply boost moved 0 → 20 → 15 in two weeks). Treat exact numbers as a snapshot.
- Node 24 works; no dependencies, no install step.

## Refresh the source

```bash
git clone --depth 1 https://github.com/xai-org/x-algorithm.git
```

Re-check `home-mixer/params/param.rs`, `home-mixer/params/config.rs`, and
`home-mixer/scorers/ranking_scorer.rs` against the constants at the top of
`score.mjs` if the weights in this file start looking stale.
