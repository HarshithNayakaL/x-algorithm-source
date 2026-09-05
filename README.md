# x-algorithm-boost

A Claude skill for X (Twitter) strategy and writing, built from the **actual
open-source For You algorithm** — [xai-org/x-algorithm](https://github.com/xai-org/x-algorithm),
August 2026 snapshot. Ranking weights, filter rules and thresholds are read out
of the Rust and Scala source, not from blog posts about it.

Three command-line drivers plus an agent playbook. No dependencies.

---

## Install

Unzip into your Claude skills directory. The archive's root entry is the skill
folder, so it lands in the right place directly.

```bash
unzip x-algorithm-boost.zip -d ~/.claude/skills/
```

PowerShell:

```bash
Expand-Archive x-algorithm-boost.zip -DestinationPath "$env:USERPROFILE\.claude\skills\"
```

For one project only, use `<project>/.claude/skills/` instead. Claude discovers
nested skill directories automatically.

Verify:

```bash
node ~/.claude/skills/x-algorithm-boost/score.mjs --text "hello world"
```

**Requires** Node 18+. Verified on Node 24.20, Windows and Git Bash. Zero npm
dependencies — nothing to install.

---

## What's in it

| File | What it does |
|---|---|
| `x-algorithm-boost/SKILL.md` | The agent playbook. Claude loads this automatically when a request matches. |
| `x-algorithm-boost/account.mjs` | Audits an **account** — surfaces, credibility, stage, binding constraint |
| `x-algorithm-boost/feedclone.mjs` | Reproduces a **feed** on another account from a follow list |
| `x-algorithm-boost/score.mjs` | Audits, rewrites and A/B-scores a **post** |
| `x-algorithm-boost/README.md` | Same guide as this file, packaged alongside the skill |

You don't have to run anything by hand — ask Claude and it drives them. The CLI
is there when you want it.

---

## Quickstart

Run these from the repo root, or `cd x-algorithm-boost` first and drop the
directory prefix.

### Audit an account

Start here for anything bigger than a single post. A zero-follower account has
different physics, and no rewrite fixes a closed distribution surface.

```bash
node x-algorithm-boost/account.mjs --followers 0 --account-age-days 2 --posts-per-day 3 --reply-share 0.5
```

```bash
node x-algorithm-boost/account.mjs --followers 12000 --verified --actor brand --posts-per-day 2
```

Prints: which distribution surfaces are open, where credibility mass comes from,
cold-start budget, cadence efficiency, the binding constraint for your stage, and
actor-specific traps.

`--actor brand|product|jobseeker|creator|growth|community` ·
`--followers N` · `--unique-favers N` · `--verified` · `--account-age-days N` ·
`--posts-per-day N` · `--reply-share 0..1`

### Score a post

```bash
node x-algorithm-boost/score.mjs --text "your draft here" --followers 800
```

A/B two drafts, optimizing for conversions rather than reach:

```bash
node x-algorithm-boost/score.mjs --goal convert --text "draft A" --text "draft B"
```

Prints: hard gates (drops), cold-start eligibility, per-head score contribution,
a funnel readout, and candidate edits each re-scored and ranked.

`--goal reach|follow|convert` · `--media photo|video|none` · `--link` · `--quote` ·
`--reply` · `--retweet` · `--thread` · `--oon` · `--mutual` · `--followers N` ·
`--age-hours N` · `--same-author-rank N`

**Read the gate report before the score.** A drop is a drop — no score rescues a
post the filter stack removed.

### Clone a feed onto a new account

Export the follow list from an account you control, as `handle,topic,followers`:

```
handle,topic,followers
@simonw,ai,180000
@swyx,ai,90000
@b0rk,systems,140000
@mitchellh,systems,95000
```

Give every topic **at least two** accounts — a cluster with one follow doesn't
register at all, and the tool will mark it `DEAD`. `topic` and `followers` are
optional, but the plan is much better with them.

```bash
node x-algorithm-boost/feedclone.mjs --list follows.csv --per-day 15
```

Prints: what transfers and what doesn't, which topics will actually register,
which accounts shape the embedding most, a phased follow order, and how to seed
the part following can't reproduce.

It reads a local file. It does not sign in to anything or fetch anyone's data.

---

## A few things the code actually says

Most of what circulates about this algorithm is wrong in specific ways. A sample:

- **Weights scale predicted probabilities, not engagement counts.** "One report
  cancels 468 likes" is false, and `param.rs` says so in a comment. Report's
  baseline probability is >1000× lower than a like's; the weight compensates for
  rarity.
- **A copy-link share is worth 20.0 and a like is worth 0.5.** Likes are close to
  noise. Replies are 5.0 — and **20.0** from a mutual follow.
- **Replies and reposts are dropped outright** for viewers who don't follow you.
  For a new account they aren't low-reach, they're *zero*-reach.
- **Your 4th post in 48h is worth 0.34 of your first** — author diversity decays
  at `0.5^k` with a 0.25 floor. Volume is self-defeating.
- **Under 100 followers you have no SimClusters embedding**, so one of the two
  out-of-network retrieval sources cannot surface you at all.
- **You don't choose what you're known for.** Your cluster embedding is built
  from the interests of the people who fav and follow you — which is why
  giveaways and follower campaigns corrupt a brand's targeting.
- **`profile_click` has weight 0.0.** The click that gets you hired or gets you a
  customer earns you nothing. Conversion is *spent* reach, never earned reach.
- **Engagement pods don't work.** Credibility mass flows from the *engager* and
  is split across everyone they engage. Near-zero accounts have none to route.

---

## What's verified vs what isn't

Being clear about this is the point of the skill.

**Verbatim from the source** — all action weights, filter rules and drop
conditions, cold-start eligibility, author-diversity math, OON discount,
credibility formula and teleport split, SimClusters thresholds. Every constant is
commented with the file it came from.

**Heuristic** — `score.mjs` needs per-action probabilities to exercise the
weights. The real ones come from the Phoenix transformer and are personalized per
viewer; the repo ships the training code, not a trained model. The stand-ins are
clearly marked, and every run prints the caveat. **Trust the ordering of levers
and the gate report; the absolute score is arbitrary units.**

**Not in the repo at all, and not guessed at** — creator payouts and revenue
share, follow rate limits, the who-to-follow recommendation service, and the
`KnownFor` cluster taxonomy itself. The skill refuses to invent numbers for these.

**Weights are runtime feature switches**, and the repo ships defaults. Production
values are A/B tested per user — `docs/BIDIRECTIONAL_BOOST_CHANGE.md` shows the
mutual-follow reply boost moving 0 → 20 → 15 in two weeks. Treat every number as
a snapshot, not a constant.

---

## Refreshing against upstream

```bash
git clone --depth 1 https://github.com/xai-org/x-algorithm.git
```

If the numbers start looking stale, re-check these against the constants at the
top of each driver:

- `home-mixer/params/param.rs` — action weights, feature switches
- `home-mixer/params/config.rs` — `MAX_POST_AGE`, offsets, result sizes
- `home-mixer/scorers/ranking_scorer.rs` — score composition
- `home-mixer/scorers/author_cold_start.rs` — cold-start eligibility
- `user-cred-v2/` — credibility PageRank
- `simclusters/simclusters_v2/scalding/InterestedInFromKnownFor.scala` — targeting

---

## Notes

The upstream algorithm is published by X under its own license; this skill
contains no upstream code, only constants read from it and cited in comments.

Nothing here automates posting, logs into an account, or touches data that isn't
yours. It reads local files and prints analysis.

---

## Author

Harshith Nayaka L ([@harshithnayakal](https://github.com/harshithnayakal))

## License

MIT — see [LICENSE](./LICENSE).
