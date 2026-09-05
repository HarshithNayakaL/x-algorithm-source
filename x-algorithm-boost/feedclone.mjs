#!/usr/bin/env node
// x-algorithm-boost :: feed replication planner.
//
// A For You feed is a FUNCTION of inputs, so it can be reconstructed -- but only
// the inputs that are actually inputs. This turns a source account's follow list
// into an ordered bootstrap plan for a new account, using the real thresholds
// from the SimClusters InterestedIn job.
//
// Grounded in:
//   simclusters_v2/scalding/InterestedInFromKnownFor.scala
//       socialProofThreshold = 2      maxClustersPerUser = 50
//       InterestedIn is built from the KnownFor of accounts you FOLLOW,
//       scored by followScore / favScore / logFavScore, each also kept in a
//       *ProducerNormalized* form (per-producer normalization, so a mega
//       account's single follow carries less shaping weight than a niche one).
//   home-mixer/params/param.rs   MaxSeqLengthScoring/Retrieval = 1024
//   home-mixer/scorers/ranking_scorer.rs   NEW_USER_MIN_FOLLOWING = 5
//   home-mixer/query_hydrators/  the user action sequence is the model's
//       main input, and it is NOT part of the follow graph.
//
// SCOPE: operates on a follow list YOU supply for an account YOU control.
// It reads a local file. It does not sign in to anything, touch anyone's
// account, or fetch private data.
//
// Usage:
//   node feedclone.mjs --list follows.csv
//   node feedclone.mjs --list follows.csv --target-topics "ai,rust,design" --per-day 20
//
// follows.csv -- one account per line, comma separated, header optional:
//   handle,topic,followers
//   @simonw,ai,180000
//   @b0rk,systems,140000
// `topic` and `followers` are optional but the plan gets much better with them.

import { readFileSync } from "node:fs";

// --- FACTS -----------------------------------------------------------------
const SOCIAL_PROOF_THRESHOLD = 2;   // InterestedInFromKnownFor.scala:67
const MAX_CLUSTERS_PER_USER = 50;   // InterestedInFromKnownFor.scala:68
const NEW_USER_MIN_FOLLOWING = 5;   // params/config.rs
const MAX_SEQ_LENGTH = 1024;        // MaxSeqLengthScoring / MaxSeqLengthRetrieval
const MIN_FOLLOWERS_FOR_PRODUCER = 100;
const KNOWN_FOR_SNAPSHOT_DAYS = 30; // dateRange.extend(Days(30)) on the KnownFor read
const TOP_K_CLUSTERS = 60;

function parseArgs(argv) {
  const o = { list: null, targetTopics: [], perDay: 20, showAll: false };
  for (let i = 0; i < argv.length; i++) {
    const next = () => argv[++i];
    switch (argv[i]) {
      case "--list": o.list = next(); break;
      case "--target-topics": o.targetTopics = next().split(",").map((s) => s.trim()).filter(Boolean); break;
      case "--per-day": o.perDay = +next(); break;
      case "--show-all": o.showAll = true; break;
      default:
        if (argv[i].startsWith("--")) { console.error(`unknown flag ${argv[i]}`); process.exit(2); }
    }
  }
  return o;
}

const o = parseArgs(process.argv.slice(2));
if (!o.list) {
  console.error(`usage: node feedclone.mjs --list follows.csv [--target-topics "ai,rust"] [--per-day 20]

follows.csv: one account per line -- handle[,topic][,followers]
Export the follow list from the account whose feed you want to reproduce
(it is public data on your own account) and save it as a file.`);
  process.exit(2);
}

// --- parse -----------------------------------------------------------------
const raw = readFileSync(o.list, "utf8").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
const rows = [];
for (const line of raw) {
  const parts = line.split(",").map((s) => s.trim());
  if (/^@?handle$/i.test(parts[0])) continue; // header
  const [handle, topic, followers] = parts;
  if (!handle) continue;
  rows.push({
    handle: handle.startsWith("@") ? handle : "@" + handle,
    topic: (topic || "untagged").toLowerCase(),
    followers: followers ? +followers : null,
  });
}
if (!rows.length) { console.error("no accounts parsed from " + o.list); process.exit(1); }

const H = (t) => console.log(`\n${t}\n${"-".repeat(t.length)}`);
console.log("=".repeat(72));
console.log(`FEED REPLICATION PLAN  ${rows.length} source follows`);
console.log("=".repeat(72));

// --- what actually determines a feed ---------------------------------------
H("1. WHAT TRANSFERS, AND WHAT DOES NOT");
console.log(`  A For You feed is produced from four viewer inputs. Only some of them`);
console.log(`  are things you can copy:\n`);
console.log(`  TRANSFERABLE by following:`);
console.log(`    - InterestedIn embedding. Built from the KnownFor clusters of the`);
console.log(`      accounts you follow. This is the retrieval targeting, and it is`);
console.log(`      the part a follow list genuinely reproduces.`);
console.log(`    - Followed topics, and the in-network (Thunder) pool itself.\n`);
console.log(`  NOT TRANSFERABLE:`);
console.log(`    - The user action sequence: your last ~${MAX_SEQ_LENGTH} engagements`);
console.log(`      (MaxSeqLengthScoring/Retrieval). This is the MAIN input to the`);
console.log(`      Phoenix model and it is behavioural, not graph-based. No amount of`);
console.log(`      following reproduces it -- it has to be earned by actually reading`);
console.log(`      and engaging. Expect the clone to feel right in TOPIC immediately`);
console.log(`      and right in TASTE only after the sequence fills.`);
console.log(`    - Blocks, mutes, muted keywords, and served/seen history.\n`);
console.log(`  So: following clones the WHAT. Engaging clones the WHICH.`);

// --- cluster analysis ------------------------------------------------------
H("2. SOCIAL PROOF -- why single follows do nothing");
// An account at or below the producer threshold has no KnownFor embedding of
// its own, so following it inherits nothing and it cannot supply social proof.
for (const r of rows)
  r.noKnownFor = r.followers != null && r.followers <= MIN_FOLLOWERS_FOR_PRODUCER;

const byTopic = new Map();
for (const r of rows) {
  if (!byTopic.has(r.topic)) byTopic.set(r.topic, []);
  byTopic.get(r.topic).push(r);
}
// n counts only accounts that can actually supply social proof
const topics = [...byTopic.entries()]
  .map(([topic, accts]) => ({
    topic, accts,
    n: accts.filter((a) => !a.noKnownFor).length,
    dead: accts.filter((a) => a.noKnownFor).length,
  }))
  .sort((a, b) => b.n - a.n);

console.log(`  InterestedInFromKnownFor runs with socialProofThreshold = ${SOCIAL_PROOF_THRESHOLD}.`);
console.log(`  A cluster only enters your InterestedIn if at least ${SOCIAL_PROOF_THRESHOLD} accounts you`);
console.log(`  follow are KnownFor it. One follow registers NOTHING.\n`);
console.log(`  maxClustersPerUser = ${MAX_CLUSTERS_PER_USER}: you can hold at most ${MAX_CLUSTERS_PER_USER} clusters, so`);
console.log(`  following broadly does not add interests, it evicts them.\n`);

const untagged = byTopic.get("untagged");
if (untagged && untagged.length === rows.length) {
  console.log(`  Your list has no topic column, so per-cluster analysis is unavailable.`);
  console.log(`  Re-export with a topic per account to get the real plan. Rough guide:`);
  console.log(`  group them yourself, and make sure every group has >= ${SOCIAL_PROOF_THRESHOLD} accounts.`);
} else {
  const viable = topics.filter((t) => t.topic !== "untagged" && t.n >= SOCIAL_PROOF_THRESHOLD);
  const orphan = topics.filter((t) => t.topic !== "untagged" && t.n < SOCIAL_PROOF_THRESHOLD);
  console.log(`  ${viable.length} topic(s) clear the threshold, ${orphan.length} do not.\n`);
  const note = (t) => t.dead ? `  (+${t.dead} under ${MIN_FOLLOWERS_FOR_PRODUCER} followers, no KnownFor -- not counted)` : "";
  for (const t of viable.slice(0, o.showAll ? 999 : 12))
    console.log(`    OK    ${t.topic.padEnd(22)} ${String(t.n).padStart(3)} accounts${note(t)}`);
  for (const t of orphan)
    console.log(`    DEAD  ${t.topic.padEnd(22)} ${String(t.n).padStart(3)} usable   -> add ${SOCIAL_PROOF_THRESHOLD - t.n} more${note(t)}`);
  if (viable.length > MAX_CLUSTERS_PER_USER)
    console.log(`\n  ${viable.length} topics exceeds the ${MAX_CLUSTERS_PER_USER}-cluster cap. The weakest will be evicted.`);
}

// --- niche weighting -------------------------------------------------------
H("3. WHICH ACCOUNTS SHAPE THE EMBEDDING MOST");
console.log(`  The InterestedIn scores are kept in ProducerNormalized form as well as`);
console.log(`  raw, i.e. each producer's outgoing influence is normalized. A follow of a`);
console.log(`  mega-account is diluted across its whole audience; a follow of a niche`);
console.log(`  account carries proportionally more shaping signal.\n`);
const withFollowers = rows.filter((r) => r.followers != null);
if (!withFollowers.length) {
  console.log(`  No follower counts in your list -- add a third column to rank these.`);
  console.log(`  Heuristic meanwhile: prefer the specific over the famous.`);
} else {
  const sorted = [...withFollowers].sort((a, b) => a.followers - b.followers);
  console.log(`  Highest shaping signal (smallest audiences) -- follow these FIRST:`);
  for (const r of sorted.slice(0, 10))
    console.log(`    ${r.handle.padEnd(24)} ${String(r.followers).padStart(9)}  ${r.topic}`);
  const mega = sorted.filter((r) => r.followers > 1e6);
  if (mega.length) {
    console.log(`\n  ${mega.length} account(s) over 1M followers. They cost a follow slot and`);
    console.log(`  contribute the least per follow. Add them last, or not at all.`);
  }
  const tooSmall = sorted.filter((r) => r.followers <= MIN_FOLLOWERS_FOR_PRODUCER);
  if (tooSmall.length) {
    console.log(`\n  ${tooSmall.length} account(s) at or under ${MIN_FOLLOWERS_FOR_PRODUCER} followers have NO producer`);
    console.log(`  embedding themselves, so they carry no KnownFor signal to inherit.`);
  }
}

// --- the plan --------------------------------------------------------------
H("4. BOOTSTRAP ORDER");
console.log(`  Phase 0 -- open the feed at all`);
console.log(`    Follow at least ${NEW_USER_MIN_FOLLOWING} accounts before judging anything. Below that the`);
console.log(`    account has effectively no in-network pool and the feed is meaningless.\n`);

const plan = [];
const viableTopics = topics.filter((t) => t.topic !== "untagged" && t.n >= SOCIAL_PROOF_THRESHOLD);
// smallest audience first among accounts that actually carry a KnownFor
const pick = (t, n) => {
  const s = t.accts
    .filter((a) => !a.noKnownFor)
    .sort((a, b) => (a.followers ?? Infinity) - (b.followers ?? Infinity));
  return s.slice(0, n);
};
// Phase 1: satisfy social proof for every viable topic, cheapest-shaping first.
for (const t of viableTopics) plan.push(...pick(t, SOCIAL_PROOF_THRESHOLD).map((a) => ({ ...a, phase: 1 })));
// Phase 2: deepen.
for (const t of viableTopics)
  plan.push(...t.accts
    .filter((a) => !a.noKnownFor && !plan.find((p) => p.handle === a.handle))
    .map((a) => ({ ...a, phase: 2 })));
// Phase 3: everything untagged / orphaned.
for (const r of rows) if (!plan.find((p) => p.handle === r.handle)) plan.push({ ...r, phase: 3 });

const p1 = plan.filter((p) => p.phase === 1);
console.log(`  Phase 1 -- establish every cluster (${p1.length} follows)`);
console.log(`    ${SOCIAL_PROOF_THRESHOLD} accounts per topic, smallest-audience first. Until a topic has ${SOCIAL_PROOF_THRESHOLD},`);
console.log(`    it contributes nothing, so breadth-first beats depth-first here.`);
if (p1.length && !o.showAll) {
  for (const a of p1.slice(0, 10)) console.log(`      ${a.handle.padEnd(24)} ${a.topic}`);
  if (p1.length > 10) console.log(`      ... ${p1.length - 10} more (--show-all)`);
}
const p2 = plan.filter((p) => p.phase === 2), p3 = plan.filter((p) => p.phase === 3);
console.log(`\n  Phase 2 -- deepen each cluster (${p2.length} follows)`);
console.log(`    Now weight matters. More follows in a cluster = stronger interest.`);
console.log(`\n  Phase 3 -- untagged / orphan topics (${p3.length} follows)`);
console.log(`    These will not form clusters unless you get them to ${SOCIAL_PROOF_THRESHOLD}.`);

const days = Math.ceil(plan.length / Math.max(1, o.perDay));
console.log(`\n  At ${o.perDay} follows/day: ${days} day(s) for ${plan.length} follows.`);
console.log(`  NOTE: X enforces follow rate limits, and aggressive following is an`);
console.log(`  abuse signal. The specific limits are NOT in this repo -- do not treat`);
console.log(`  any number here as a safe ceiling. Spread it out.`);

H("5. SEEDING THE ACTION SEQUENCE");
console.log(`  The follow graph sets WHAT is retrieved. The action sequence -- your last`);
console.log(`  ~${MAX_SEQ_LENGTH} engagements -- sets WHICH of it ranks. It is the model's main`);
console.log(`  input and it starts empty on a new account.\n`);
console.log(`  To fill it in a way that matches the source account:`);
console.log(`    - Engage deliberately in the target clusters from day one. Every fav,`);
console.log(`      reply, share and dwell is a token in that ${MAX_SEQ_LENGTH}-event window.`);
console.log(`    - Dwell counts. Reading a post properly is signal even with no tap.`);
console.log(`    - Off-topic engagement is not neutral -- it occupies sequence slots and`);
console.log(`      pulls retrieval with it. A new account is maximally impressionable.`);
console.log(`    - Negative signals transfer nothing but are worth re-applying by hand:`);
console.log(`      re-block, re-mute, and re-add muted keywords from the source account.`);
console.log(`\n  KnownFor snapshots are read over a ${KNOWN_FOR_SNAPSHOT_DAYS}-day window and the embedding jobs`);
console.log(`  are batch, not realtime. Expect days, not minutes, for follows to show up`);
console.log(`  as changed retrieval. Do not conclude it failed on day one.`);

H("6. VERIFY THE CLONE");
console.log(`  Compare the two feeds on things you can actually observe:`);
console.log(`    - topic mix of the first 35 items (RESULT_SIZE is 35)`);
console.log(`    - share of in-network vs unfamiliar authors`);
console.log(`    - whether the same accounts recur`);
console.log(`  Divergence in TOPIC means the follow graph is still wrong -- check social`);
console.log(`  proof per cluster. Divergence in TASTE with the right topics means the`);
console.log(`  action sequence has not filled yet, which is time, not a fixable input.`);

console.log(`\n${"=".repeat(72)}`);
console.log(`Thresholds above are verbatim from xai-org/x-algorithm. Follow rate limits`);
console.log(`and the KnownFor cluster taxonomy itself are NOT in the repo -- anything`);
console.log(`about those is inference and is labelled as such.`);
console.log("=".repeat(72) + "\n");
