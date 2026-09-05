#!/usr/bin/env node
// x-algorithm-boost :: account-level driver.
//
// score.mjs answers "is this post good?". This answers "why is this ACCOUNT
// not getting distribution, and what is the binding constraint right now?"
//
// Grounded in:
//   thunder/                      in-network source (needs followers)
//   home-mixer/sources/           phoenix retrieval + simclusters (OON)
//   home-mixer/scorers/author_cold_start.rs
//   home-mixer/filters/new_user_min_engagement_filter.rs
//   home-mixer/scorers/ranking_scorer.rs  (author diversity)
//   user-cred-v2/UserCredV2.scala, UserCredV2App.scala, UserCredV2Config.scala
//
// Usage:
//   node account.mjs --followers 0 --account-age-days 2 --posts-per-day 3
//   node account.mjs --followers 4200 --verified --reply-share 0.6 --median-engagement 14

// --- FACTS: user-cred-v2 ---------------------------------------------------
const CRED_SLOPE = 7.07;          // UserCredV2.ScoreSlope
const CRED_INTERCEPT = 165.2;     // UserCredV2.ScoreIntercept
const VIT_THRESHOLD = 55.0;       // UserCredV2Config vit_threshold
const JUMP_PROBABILITY = 0.2;     // teleport probability (damping 0.8)
const ENGAGEMENT_TELEPORT_BETA = 0.5;
const ENGAGEMENT_WINDOW_DAYS = 7;
const MAX_ITERATIONS = 50;
// mass is normalized to sum to ~1 across the network (gate_mass_min 0.99 /
// gate_mass_max 1.005 in UserCredV2Config), so "mass" is a share of the whole.

// --- FACTS: home-mixer -----------------------------------------------------
// --- FACTS: simclusters producer embeddings --------------------------------
// simclusters_v2/scalding/embedding/ProducerEmbeddingsFromInterestedIn.scala
const MIN_FOLLOWERS_FOR_PRODUCER = 100;  // minNumFollowersForProducer
const MIN_FAVERS_FOR_PRODUCER = 100;     // minNumFaversForProducer
const TOP_K_CLUSTERS = 60;               // topKClustersToKeep

const COLD_START_FOLLOWER_CAP = 1000;
const COLD_START_IMPRESSION_THRESHOLD = 1000;
const COLD_START_MAX_POST_AGE_HOURS = 24;
const COLD_START_SLOT_MIN = 15, COLD_START_SLOT_MAX = 16;
const RESULT_SIZE = 35;
const AUTHOR_DIVERSITY_DECAY = 0.5;
const AUTHOR_DIVERSITY_FLOOR = 0.25;
const OON_WEIGHT_FACTOR = 0.75;
const MAX_POST_AGE_HOURS = 48;

const credScore = (mass) =>
  mass <= 0 ? 0 : Math.min(100, Math.max(0, CRED_INTERCEPT + CRED_SLOPE * Math.log(mass)));
const massForScore = (s) => Math.exp((s - CRED_INTERCEPT) / CRED_SLOPE);
const diversityMult = (k) =>
  (1 - AUTHOR_DIVERSITY_FLOOR) * Math.pow(AUTHOR_DIVERSITY_DECAY, k) + AUTHOR_DIVERSITY_FLOOR;

function parseArgs(argv) {
  const o = {
    followers: 0, following: 0, verified: false, accountAgeDays: 1,
    postsPerDay: 1, replyShare: 0.0, medianEngagement: 0, networkAccounts: 600e6,
    uniqueFavers: 0, actor: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const next = () => argv[++i];
    switch (argv[i]) {
      case "--followers": o.followers = +next(); break;
      case "--following": o.following = +next(); break;
      case "--account-age-days": o.accountAgeDays = +next(); break;
      case "--posts-per-day": o.postsPerDay = +next(); break;
      case "--reply-share": o.replyShare = +next(); break;
      case "--median-engagement": o.medianEngagement = +next(); break;
      case "--network-accounts": o.networkAccounts = +next(); break;
      case "--unique-favers": o.uniqueFavers = +next(); break;
      case "--actor": o.actor = next(); break;
      case "--verified": o.verified = true; break;
      default:
        if (argv[i].startsWith("--")) { console.error(`unknown flag ${argv[i]}`); process.exit(2); }
    }
  }
  return o;
}

const o = parseArgs(process.argv.slice(2));
const H = (t) => console.log(`\n${t}\n${"-".repeat(t.length)}`);

console.log("=".repeat(72));
console.log(`ACCOUNT AUDIT  ${o.followers} followers · ${o.accountAgeDays}d old · ` +
  `${o.verified ? "premium/verified" : "not verified"} · ${o.postsPerDay} post(s)/day`);
console.log("=".repeat(72));

// ---------------------------------------------------------------------------
H("1. DISTRIBUTION SURFACES — which doors are even open");
const inNetworkOpen = o.followers > 0;
console.log(`  IN-NETWORK  (thunder/)              ${inNetworkOpen ? "OPEN" : "CLOSED"}`);
console.log(`    Thunder serves your posts only to accounts that follow you.`);
if (!inNetworkOpen)
  console.log(`    You have 0 followers, so this surface delivers literally nothing.\n` +
              `    100% of your distribution must come from out-of-network retrieval,\n` +
              `    which means every OON drop rule applies to 100% of your reach.`);
else
  console.log(`    Reaches up to ${o.followers} viewers, ranked, no 0.75x discount on originals.`);

const simclustersOpen =
  o.followers > MIN_FOLLOWERS_FOR_PRODUCER || o.uniqueFavers > MIN_FAVERS_FOR_PRODUCER;
console.log(`\n  OON / phoenix retrieval             OPEN (always)`);
console.log(`    The one surface that is never closed. For a new account it is the`);
console.log(`    only way anyone finds you.`);
console.log(`\n  OON / simclusters                  ${simclustersOpen ? "OPEN" : "CLOSED"}`);
console.log(`    A producer SimClusters embedding requires > ${MIN_FOLLOWERS_FOR_PRODUCER} followers OR`);
console.log(`    > ${MIN_FAVERS_FOR_PRODUCER} unique favers (ProducerEmbeddingsFromInterestedIn.scala:473).`);
if (!simclustersOpen)
  console.log(`    You have ${o.followers} followers / ${o.uniqueFavers} favers -- you have NO cluster\n` +
              `    identity, so SimClusters retrieval cannot surface you to anyone.`);
else
  console.log(`    You have an embedding over your top ${TOP_K_CLUSTERS} clusters.`);
console.log(`\n    Your embedding is built from the InterestedIn vectors of the people who`);
console.log(`    fav and follow you -- NOT from what you write. You are "known for"`);
console.log(`    whatever your audience is interested in. Off-topic followers drift your`);
console.log(`    targeting and SimClusters starts showing you to the wrong people.`);
console.log(`\n  OON carries a x${OON_WEIGHT_FACTOR} score discount, and these apply to it and NOT to`);
console.log(`  in-network: OONRetweetReplyFilter, OONNsfwSimclustersFilter, plus`);
console.log(`  every OON label drop rule. (NewUserMinEngagementFilter also targets`);
console.log(`  OON but defaults to DISABLED -- param.rs:835.)`);

if (o.replyShare > 0) {
  const wasted = Math.round(o.replyShare * 100);
  console.log(`\n  ${wasted}% of your output is replies/reposts. For out-of-network viewers`);
  console.log(`  that share is DROPPED OUTRIGHT (oon_retweet_reply_filter.rs).`);
  console.log(inNetworkOpen
    ? `  It reaches only your ${o.followers} followers, and takes the ${OON_WEIGHT_FACTOR}x discount even there.`
    : `  With 0 followers that ${wasted}% reaches nobody at all. Not low-reach -- zero-reach.`);
}

// ---------------------------------------------------------------------------
H("2. CREDIBILITY (user-cred-v2) — where trust mass comes from");
console.log(`  UserCredV2 is PageRank over the follow graph:`);
console.log(`    score = ${CRED_INTERCEPT} + ${CRED_SLOPE} x ln(mass),  clamped [0,100]`);
console.log(`    teleport ${JUMP_PROBABILITY} · beta ${ENGAGEMENT_TELEPORT_BETA} · ${MAX_ITERATIONS} iterations · mass sums to 1 network-wide`);
console.log(`\n  The teleport (the mass source) is split ${1 - ENGAGEMENT_TELEPORT_BETA}/${ENGAGEMENT_TELEPORT_BETA}:`);
console.log(`    ${(1 - ENGAGEMENT_TELEPORT_BETA) * 100}% uniform over accounts that are NOT near-zero AND ARE premium`);
console.log(`        (UserCredV2App.scala:174 -- blue/gray/gold verified, verified org, affiliate)`);
console.log(`    ${ENGAGEMENT_TELEPORT_BETA * 100}% engagement-weighted over a ${ENGAGEMENT_WINDOW_DAYS}-day window, where each`);
console.log(`        engager's own mass is SPLIT across everyone they engaged with`);

const avgMass = 1 / o.networkAccounts;
console.log(`\n  Calibration (at ${(o.networkAccounts / 1e6).toFixed(0)}M accounts, mass normalized to 1):`);
for (const mult of [1, 10, 100, 1000, 10000]) {
  const s = credScore(avgMass * mult);
  console.log(`    ${String(mult).padStart(5)}x average mass  ->  cred score ${s.toFixed(1)}` +
    (s >= VIT_THRESHOLD ? "   >= VIT threshold (55)" : ""));
}
console.log(`\n  Because the curve is logarithmic, every +${CRED_SLOPE} points costs a x${Math.E.toFixed(2)}`);
console.log(`  multiplication of mass. Credibility is bought multiplicatively, not linearly.`);

console.log(`\n  What this means for you:`);
if (!o.verified) {
  console.log(`    - NOT verified: you are excluded from the uniform teleport seed set.`);
  console.log(`      ${(1 - ENGAGEMENT_TELEPORT_BETA) * 100}% of all mass injection in the network skips you entirely.`);
  console.log(`      Your only inbound mass is the engagement teleport + follow edges.`);
} else {
  console.log(`    - Verified: you ARE in the uniform teleport seed set, receiving a share`);
  console.log(`      of ${(1 - ENGAGEMENT_TELEPORT_BETA) * 100}% of network mass injection every run, before any follower exists.`);
}
console.log(`    - WHO follows/engages you dominates HOW MANY. Mass flows from the`);
console.log(`      engager and is divided across their targets, so one engagement from a`);
console.log(`      high-mass account that engages selectively outweighs hundreds from`);
console.log(`      near-zero accounts.`);
console.log(`    - The engagement teleport uses a rolling ${ENGAGEMENT_WINDOW_DAYS}-day window. Mass earned`);
console.log(`      this way decays out if you stop earning it. It is rent, not equity.`);
console.log(`    - High-PageRank accounts are explicitly EXEMPTED from several spam-label`);
console.log(`      bots (IsHighPageRankUser guards in botmaker-rules/*.bot). Credibility`);
console.log(`      literally buys label immunity that a fresh account does not have.`);

// ---------------------------------------------------------------------------
H("3. COLD START — your only free distribution");
const csEligible = o.followers <= COLD_START_FOLLOWER_CAP;
if (csEligible) {
  const originals = o.postsPerDay * (1 - o.replyShare);
  console.log(`  ELIGIBLE (${o.followers} <= ${COLD_START_FOLLOWER_CAP} follower cap).`);
  console.log(`  Qualifying posts are force-injected at slot ${COLD_START_SLOT_MIN}-${COLD_START_SLOT_MAX} of ${RESULT_SIZE}, ignoring score.`);
  console.log(`  Requirements: ORIGINAL (no reply, no repost), < ${COLD_START_IMPRESSION_THRESHOLD} impressions,`);
  console.log(`  < ${COLD_START_MAX_POST_AGE_HOURS}h old.`);
  console.log(`\n  You publish ~${originals.toFixed(1)} qualifying original(s)/day out of ${o.postsPerDay} post(s).`);
  if (o.replyShare > 0.3)
    console.log(`  You are forfeiting ${Math.round(o.replyShare * 100)}% of your cold-start budget on replies/reposts,\n  which can never qualify.`);
  console.log(`\n  This expires permanently at ${COLD_START_FOLLOWER_CAP} followers. Spend it.`);
} else {
  console.log(`  EXPIRED. ${o.followers} followers is over the ${COLD_START_FOLLOWER_CAP} cap.`);
  console.log(`  From here every impression is earned through ranking. There is no more`);
  console.log(`  free injection.`);
}

// ---------------------------------------------------------------------------
H("4. CADENCE — author diversity makes volume self-defeating");
console.log(`  multiplier = (1 - ${AUTHOR_DIVERSITY_FLOOR}) x ${AUTHOR_DIVERSITY_DECAY}^k + ${AUTHOR_DIVERSITY_FLOOR}`);
console.log(`  where k = how many of your HIGHER-scoring posts are already in that`);
console.log(`  viewer's candidate pool (48h window).\n`);
let cumulative = 0;
for (let k = 0; k < Math.max(4, Math.min(8, Math.ceil(o.postsPerDay * 2))); k++) {
  cumulative += diversityMult(k);
  console.log(`    post ${k + 1}:  x${diversityMult(k).toFixed(4)}   cumulative reach ${cumulative.toFixed(3)} "posts worth"`);
}
const n = Math.max(1, Math.round(o.postsPerDay * 2)); // 48h window
let cum = 0; for (let k = 0; k < n; k++) cum += diversityMult(k);
console.log(`\n  At ${o.postsPerDay}/day you put ~${n} posts in a ${MAX_POST_AGE_HOURS}h window, buying ${cum.toFixed(2)} posts`);
console.log(`  worth of reach -- ${((cum / n) * 100).toFixed(0)}% efficiency. Each additional post is worth`);
console.log(`  strictly less than the one before, and never less than the ${AUTHOR_DIVERSITY_FLOOR} floor.`);

// ---------------------------------------------------------------------------
H("5. BINDING CONSTRAINT — the one thing to fix now");
const stage = o.followers === 0 ? "cold" : o.followers <= COLD_START_FOLLOWER_CAP ? "coldstart"
  : o.followers <= 10000 ? "growth" : "established";
const advice = {
  cold: [
    "You have no in-network surface. Nothing you post reaches anyone by default.",
    "ONLY originals matter: replies and reposts are dropped OON, and OON is all you have.",
    "Cold start is your entire distribution engine -- originals, fresh, every day.",
    "Cross 100 followers (or 100 unique favers) to switch SimClusters on. Until",
    "  then you have no cluster identity and cannot be targeted to anyone.",
    "Get engagement from accounts that HAVE mass, not from volume. The engagement",
    "  teleport routes their mass to you within a 7-day window.",
    "If you are going to verify, the value is front-loaded: it puts you in the",
    "  uniform teleport seed set immediately, which is the only mass source that",
    "  does not require you to already have an audience.",
  ],
  coldstart: [
    `Cold start still works and dies at ${COLD_START_FOLLOWER_CAP} followers. It is a depreciating asset.`,
    "Every reply or repost you publish is a cold-start slot you chose not to use.",
    "Convert reach into MUTUAL follows: reply weight goes 5.0 -> 20.0 for mutuals,",
    "  the largest controllable multiplier in the system, and it is permanent.",
    "Your in-network surface is now real. Protect it -- a mute or block is -58.8/-31.2.",
  ],
  growth: [
    "Cold start is gone. Ranking is now the entire game.",
    "Mutual follows are the compounding asset: 4x on the reply head, forever.",
    "Author diversity is now your main self-inflicted wound -- space your posts.",
    "Optimize for copy-link shares (20.0) and replies (5.0). Likes (0.5) are noise.",
  ],
  established: [
    "You are past every structural gate. Only ranking and visibility filtering matter.",
    "Your risk profile inverts: the downside (mute -58.8, report -234, OON label",
    "  drops) now outweighs marginal upside. Protect the account, don't chase reach.",
    "High PageRank exempts you from several spam-label bots. Don't spend that on",
    "  template-recycled promo, which is what COPYPASTA_SPAM detects.",
  ],
}[stage];
console.log(`  Stage: ${stage.toUpperCase()}\n`);
// indented continuation lines keep their indent instead of getting a bullet
for (const line of advice)
  console.log(line.startsWith(" ") ? `    ${line.trim()}` : `  - ${line}`);

// ---------------------------------------------------------------------------
// ACTORS. Not personas -- each is a point on three axes the mechanics already
// price: OBJECTIVE (which head you convert on), AUDIENCE (broad reach vs being
// found by specific people, i.e. ranking vs SimClusters targeting), and RISK
// (how much label exposure the account can absorb).
// ---------------------------------------------------------------------------
const ACTORS = {
  brand: {
    objective: "convert", audience: "targeted", risk: "none",
    why: "A brand page converts, but cannot absorb a label. One SPAM_HIGH_RECALL removes the account from out-of-network discovery entirely.",
    do: [
      "Never post the same campaign copy twice -- COPYPASTA_SPAM clusters near-duplicate text and brands are the biggest repeat offenders.",
      "Never use a link shortener or a tracking redirect: a LOW_QUALITY verdict ANYWHERE in the redirect chain labels the post. Link direct or link in a reply.",
      "Your SimClusters embedding comes from who favs you. Follower-count campaigns and giveaways import off-topic audiences and corrupt your targeting permanently.",
      "Verification puts you in the uniform teleport seed set -- for a brand this is the cheapest credibility mass available.",
    ],
  },
  product: {
    objective: "convert", audience: "targeted", risk: "low",
    why: "Indie/product accounts need clicks, which the model does not pay for. Reach must be earned on other heads and then spent.",
    do: [
      "Build-in-public posts earn on reply (5.0) and copy-link share (20.0); launch posts spend it on open_link (0.2). Alternate deliberately -- do not make every post a launch.",
      "Put the link in the first reply. You keep the reach and the buyers still find it.",
      "Under 1000 followers, cold start is your entire ad budget and it only pays on ORIGINALS.",
      "Your first 100 followers/favers are a hard gate: below that SimClusters has no embedding for you and cannot target your buyers at all.",
    ],
  },
  jobseeker: {
    objective: "found", audience: "targeted", risk: "none",
    why: "You do not need reach. You need a small number of specific people to find you, which is a SimClusters and profile problem, not a ranking problem.",
    do: [
      "Being found is cluster membership, not volume. Get favs/follows from people IN your target field -- your embedding is built from THEIR interests, so their engagement is what places you in the right cluster.",
      "100 followers or 100 unique favers is the threshold for having a cluster identity at all. Below it, targeted discovery is off.",
      "profile_click has weight 0.0 -- the algorithm will never reward the click that gets you hired. Reach is bought with substance and spent on the profile visit.",
      "Post original work, not commentary on other people's. OON replies are dropped, so replying to famous accounts in your field reaches nobody new.",
      "Who-to-follow recommendations are an external service, not in this repo. Do not claim to optimize them.",
    ],
  },
  creator: {
    objective: "follow", audience: "broad", risk: "medium",
    why: "Audience compounding is the only objective the algorithm actually subsidizes: follow_author is +4.0.",
    do: [
      "Optimize for the follow, not the like. Likes are 0.5; a follow pays on every future post.",
      "Mutual follows move the reply head 5.0 -> 20.0. Following back your engaged readers is a mechanical distribution upgrade.",
      "Author diversity punishes volume: your 4th post in 48h is worth 0.34 of your first. Post less, better.",
      "Threads: only ONE post per conversation survives dedup. A 10-post thread competes with itself.",
    ],
  },
  growth: {
    objective: "reach", audience: "broad", risk: "medium",
    why: "Growth marketing optimizes reach, which is the only objective the ranking model directly maximizes -- and the easiest to buy with tactics that get you labeled.",
    do: [
      "Every tactic that scales by repetition is a labeling target. COPYPASTA_SPAM exists specifically to cluster templated text.",
      "Engagement pods do not work: the engagement teleport routes the ENGAGER'S mass, split across their targets. Near-zero accounts have no mass to route.",
      "Mass block/report brigading is also weaker than believed -- scoring is personalized, so it mostly poisons you for accounts similar to the brigaders.",
      "The honest levers are the big weights: copy-link share 20.0, reply 5.0, quote 5.0. Everything else is rounding.",
    ],
  },
  community: {
    objective: "follow", audience: "targeted", risk: "low",
    why: "Communities live on replies, which are the most structurally penalized content type in the system.",
    do: [
      "Replies are dropped for out-of-network viewers, and self-reply-chain rules mean your reply only shows to people who follow the account you replied to.",
      "This means community engagement CANNOT recruit. It retains. Recruit with originals, retain with replies, and do not confuse the two.",
      "Mutual follows are the whole game here -- 4x on the reply head, and replies are what you do.",
    ],
  },
};

if (o.actor) {
  const a = ACTORS[o.actor];
  if (!a) {
    console.log(`\n  unknown --actor "${o.actor}". Options: ${Object.keys(ACTORS).join(", ")}`);
  } else {
    H(`6. ACTOR: ${o.actor.toUpperCase()}`);
    console.log(`  objective ${a.objective}  ·  audience ${a.audience}  ·  label risk tolerance ${a.risk}`);
    const wrap = (s, n) => s.match(new RegExp(`.{1,${n}}(\\s|$)`, "g")).map((x) => x.trim());
    console.log("");
    for (const w of wrap(a.why, 68)) console.log(`  ${w}`);
    console.log("");
    for (const d of a.do) {
      const wrapped = wrap(d, 68);
      console.log(`  - ${wrapped[0]}`);
      for (const w of wrapped.slice(1)) console.log(`    ${w}`);
    }
    console.log(`\n  Score posts with:  score.mjs --goal ${a.objective === "found" ? "follow" : a.objective}`);
  }
} else {
  H("6. ACTOR");
  console.log(`  Pass --actor to get objective-specific guidance.`);
  console.log(`  Options: ${Object.keys(ACTORS).join(", ")}`);
}

console.log(`\n${"=".repeat(72)}`);
console.log("Weights, gates and formulas above are verbatim from xai-org/x-algorithm.");
console.log("The calibration table assumes uniform mass across accounts, which real");
console.log("networks are not -- read it as an order of magnitude, not a target.");
console.log("=".repeat(72) + "\n");
