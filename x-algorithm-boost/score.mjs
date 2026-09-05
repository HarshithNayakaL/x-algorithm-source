#!/usr/bin/env node
// x-algorithm-boost driver.
//
// Reimplements the scoring math from xai-org/x-algorithm home-mixer
// (ranking_scorer.rs + params/param.rs + params/config.rs + filters/*)
// and runs a draft post through it.
//
// TWO KINDS OF NUMBERS LIVE HERE, AND THEY ARE NOT THE SAME:
//   WEIGHTS / GATES  -- copied verbatim from the open-source repo. Facts.
//   PRIORS           -- per-impression action probabilities. HEURISTIC.
//                       The real ones come from the Phoenix transformer,
//                       personalized per viewer. Ours are a stand-in so the
//                       weight ratios can be exercised. Treat the RANKING of
//                       levers as signal; treat the absolute score as arbitrary.
//
// Usage:
//   node score.mjs --text "draft" [flags]
//   node score.mjs --text "A" --text "B"        # A/B two drafts
//
// Flags (repeat per --text in order, or set once to apply to all):
//   --media photo|video|none   --video-ms 12000   --link
//   --quote  --reply  --retweet  --thread
//   --oon               treat viewer as NOT following you (default: both shown)
//   --mutual            author is a mutual follow of the viewer
//   --followers 800     author follower count (cold-start eligibility)
//   --age-hours 3       post age at scoring time
//   --impressions 200   impressions so far (cold-start eligibility)
//   --same-author-rank 0  how many higher-scoring posts of yours are in the pool
//   --json-out          machine-readable output

// ---------------------------------------------------------------------------
// FACTS: home-mixer/params/param.rs  (defaults, Aug 2026 snapshot)
// ---------------------------------------------------------------------------
const W = {
  favorite: 0.5,
  reply: 5.0,
  retweet: 1.0,
  photo_expand: 0.05,
  video_open: 0.07,
  click: 0.4,
  open_link: 0.2,
  profile_click: 0.0,
  vqv: 0.0,
  share: 2.0,
  share_via_dm: 5.0,
  share_via_copy_link: 20.0,
  dwell: 0.05,
  quote: 5.0,
  quoted_click: 0.05,
  quoted_vqv: 0.0,
  follow_author: 4.0,
  post_unexplored: 0.02,
  // negatives
  not_interested: -43.2,
  block_author: -31.2,
  mute_author: -58.8,
  report: -234.0,
  not_dwelled: -0.02,
};
// continuous heads, excluded from positive_sum in the Rust (see from_params)
const W_CONT = { cont_dwell_time: 0.004, cont_click_dwell_time: 0.0 };

const BIDIRECTIONAL_REPLY_BOOST = 15.0; // BidirectionalFollowReplyWeightBoost
const BIDIRECTIONAL_DWELL_BOOST = 0.0;
const OON_WEIGHT_FACTOR = 0.75; // OonWeightFactor
const TOPIC_OON_WEIGHT_FACTOR = 0.5;
const NEW_USER_OON_WEIGHT_FACTOR = 0.00001; // params/config.rs
const AUTHOR_DIVERSITY_DECAY = 0.5;
const AUTHOR_DIVERSITY_FLOOR = 0.25;
const NEGATIVE_SCORES_OFFSET = 0.001; // params/config.rs
const MAX_POST_AGE_HOURS = 48; // MAX_POST_AGE = 48*60*60
const MIN_VIDEO_DURATION_MS = 10_000; // MinVideoDurationMs
const COLD_START_IMPRESSION_THRESHOLD = 1000;
const COLD_START_FOLLOWER_CAP = 1000;
const COLD_START_MAX_POST_AGE_HOURS = 24; // 86400s
const COLD_START_SLOT_MIN = 15, COLD_START_SLOT_MAX = 16;
const RESULT_SIZE = 35; // params/config.rs

const POSITIVE_SUM =
  W.favorite + W.reply + W.retweet + W.photo_expand + W.video_open + W.click +
  W.open_link + W.profile_click + W.vqv + W.share + W.share_via_dm +
  W.share_via_copy_link + W.dwell + W.quote + W.quoted_click + W.quoted_vqv +
  W.follow_author + W.post_unexplored;
const NEGATIVE_SUM =
  -(W.not_interested + W.block_author + W.mute_author + W.report + W.not_dwelled);
const TOTAL_SUM = POSITIVE_SUM + NEGATIVE_SUM;

// ---------------------------------------------------------------------------
// HEURISTIC priors. Rough per-impression rates for a mid-size account.
// ---------------------------------------------------------------------------
const BASE_P = {
  favorite: 0.030, reply: 0.0035, retweet: 0.0045, photo_expand: 0.020,
  video_open: 0.020, click: 0.040, open_link: 0.0060, profile_click: 0.0035,
  vqv: 0.012, share: 0.0022, share_via_dm: 0.0009, share_via_copy_link: 0.0004,
  dwell: 0.30, quote: 0.0009, quoted_click: 0.004, quoted_vqv: 0.002,
  follow_author: 0.0012, post_unexplored: 0.6,
  // Negative feedback is RARE. param.rs says report's baseline probability is
  // >1000x lower than a like's; the big negative weights exist to compensate
  // for that, not because one report outweighs hundreds of likes.
  not_interested: 0.00012, block_author: 0.000025, mute_author: 0.00002,
  report: 0.000025, not_dwelled: 0.55,
  dwell_time: 4.0, click_dwell_time: 0.0,
};

// ---------------------------------------------------------------------------
// Text analysis -> multipliers on the priors.
// ---------------------------------------------------------------------------
const URL_RE = /https?:\/\/\S+/g;
const HASHTAG_RE = /(^|\s)#[\w]+/g;
const MENTION_RE = /(^|\s)@[\w]+/g;
const ENGAGEMENT_BAIT =
  /\b(like (?:and|&) (?:retweet|repost)|rt if|retweet if|follow me|follow for more|drop a|comment below|tag (?:a|your|someone)|who agrees|agree\?|thread 🧵|1\/\d+ 🧵)\b/i;
const HYPE = /\b(insane|game.?changer|mind.?blowing|literally shaking|this changes everything|you won'?t believe|nobody is talking about)\b/i;
const QUESTION = /\?\s*$|\?["')\]]?\s*$/m;
const HOT_TAKE = /\b(unpopular opinion|hot take|controversial|i(?:'|’)ll say it|nobody wants to admit|actually,? )/i;
const NUMBERED_LIST = /(^|\n)\s*(\d+[.)]|[-–—•*])\s+/g;

function analyze(text) {
  const links = text.match(URL_RE) || [];
  const hashtags = text.match(HASHTAG_RE) || [];
  const mentions = text.match(MENTION_RE) || [];
  // hashtags and URLs are not content: excluding them keeps the length bucket
  // stable when a lever strips them, so the delta reflects the lever alone
  const bare = text.replace(URL_RE, "").replace(HASHTAG_RE, "").trim();
  const lines = text.split(/\n/).filter((l) => l.trim());
  const listItems = (text.match(NUMBERED_LIST) || []).length;
  return {
    chars: text.length,
    bareChars: bare.length,
    words: bare.split(/\s+/).filter(Boolean).length,
    links, hashtags, mentions, lines: lines.length, listItems,
    endsWithQuestion: QUESTION.test(text.trim()),
    bait: ENGAGEMENT_BAIT.test(text),
    hype: HYPE.test(text),
    hotTake: HOT_TAKE.test(text),
    allCapsRun: /\b[A-Z]{6,}\b/.test(text),
    emojiCount: (text.match(/\p{Extended_Pictographic}/gu) || []).length,
  };
}

function priorsFor(a, o) {
  const p = { ...BASE_P };
  const m = (k, x) => { p[k] *= x; };

  // Length. Very short = low dwell. 120-260 chars is the sweet spot for dwell
  // without losing the scroll. Walls of text raise not_dwelled.
  if (a.bareChars < 60) { m("dwell", 0.55); m("not_dwelled", 1.25); p.dwell_time *= 0.5; }
  else if (a.bareChars <= 280) { m("dwell", 1.15); m("not_dwelled", 0.9); p.dwell_time *= 1.3; }
  else { m("dwell", 1.35); m("not_dwelled", 0.95); p.dwell_time *= 1.9; m("favorite", 0.9); }

  // Structure: line breaks and list items buy dwell cheaply.
  if (a.lines >= 3 || a.listItems >= 2) { m("dwell", 1.2); p.dwell_time *= 1.35; m("share_via_copy_link", 1.6); m("share_via_dm", 1.5); }

  // A genuine question at the end is the single cheapest reply driver.
  if (a.endsWithQuestion) { m("reply", 2.2); m("favorite", 0.9); }
  if (a.hotTake) { m("reply", 1.8); m("quote", 2.0); m("not_interested", 1.4); m("block_author", 1.3); m("mute_author", 1.3); }

  // Engagement bait: X's spam labelling machinery targets exactly this
  // (COPYPASTA_SPAM / SPAM_HIGH_RECALL), and it reads as low-trust to viewers.
  if (a.bait) { m("not_interested", 3.0); m("report", 2.5); m("mute_author", 2.0); m("reply", 1.2); m("share_via_dm", 0.5); m("share_via_copy_link", 0.4); }
  if (a.hype) { m("not_interested", 1.6); m("share_via_copy_link", 0.6); m("dwell", 0.9); }
  if (a.allCapsRun) { m("mute_author", 1.4); m("not_interested", 1.3); }

  // Hashtags: no positive head in the model consumes them. They cost trust.
  if (a.hashtags.length >= 3) { m("not_interested", 1.5); m("mute_author", 1.4); m("favorite", 0.85); }
  else if (a.hashtags.length > 0) { m("not_interested", 1.15); }

  if (a.emojiCount >= 6) { m("not_interested", 1.3); m("share_via_copy_link", 0.7); }

  // Mentions of non-followers with links is a documented spam-label trigger.
  if (a.mentions.length >= 3) { m("report", 1.8); m("not_interested", 1.6); }

  // External link. click/open_link exist but are worth 0.4/0.2 vs share 2-20.
  // The bigger effect is that people leave, so dwell and reply collapse.
  if (o.link || a.links.length) {
    // `click` is the post-detail click head, not the link click -- a link
    // barely moves it. open_link is the link one, and it is worth 0.2.
    m("click", 1.2); m("open_link", 4.0);
    m("dwell", 0.75); m("reply", 0.6); m("favorite", 0.7);
    m("share_via_copy_link", 0.7); m("not_dwelled", 1.15);
  }

  // Media.
  if (o.media === "photo") { m("photo_expand", 6.0); m("dwell", 1.25); m("favorite", 1.35); p.dwell_time *= 1.4; m("share_via_dm", 1.4); }
  else if (o.media === "video") {
    m("video_open", 7.0); m("dwell", 1.4); p.dwell_time *= 2.2; m("share_via_dm", 1.6);
    m("reply", 0.85);
    // vqv weight is 0.0 by default, and gated on >= 10s anyway.
    p.vqv = (o.videoMs ?? 0) >= MIN_VIDEO_DURATION_MS ? p.vqv : 0;
  } else { p.photo_expand = 0; p.video_open = 0; p.vqv = 0; }

  if (!o.quote) { p.quoted_click = 0; p.quoted_vqv = 0; }
  else { m("dwell", 1.15); m("reply", 1.2); }

  // Replies and retweets are structurally capped: see gate report.
  if (o.reply) { m("follow_author", 0.5); m("profile_click", 1.4); m("reply", 1.4); }
  if (o.retweet) { m("follow_author", 0.3); m("favorite", 0.7); m("quote", 0.2); }

  // Discovery: a viewer who does not follow you is colder on everything.
  if (o.oon) {
    m("favorite", 0.6); m("reply", 0.45); m("dwell", 0.85); m("follow_author", 3.0);
    m("not_interested", 1.8); m("block_author", 1.6); m("mute_author", 1.5);
  }

  for (const k of Object.keys(p)) p[k] = Math.min(p[k], k === "dwell" || k === "not_dwelled" || k === "post_unexplored" ? 0.95 : 0.5);
  return p;
}

// ---------------------------------------------------------------------------
// FACTS: the filter stack. These are drops, not deboosts.
// ---------------------------------------------------------------------------
function gates(a, o) {
  const g = [];
  const fail = (name, src, msg) => g.push({ level: "DROP", name, src, msg });
  const warn = (name, src, msg) => g.push({ level: "WARN", name, src, msg });

  if (o.ageHours > MAX_POST_AGE_HOURS)
    fail("AgeFilter", "filters/age_filter.rs", `post is ${o.ageHours}h old; MAX_POST_AGE is ${MAX_POST_AGE_HOURS}h. Nothing older is a For You candidate, ever.`);
  else if (o.ageHours > 24)
    warn("AgeFilter", "filters/age_filter.rs", `${MAX_POST_AGE_HOURS - o.ageHours}h of eligibility left, and past 24h you are also out of cold-start range.`);

  if (o.oon && (o.reply || o.retweet))
    fail("OONRetweetReplyFilter", "filters/oon_retweet_reply_filter.rs", "replies and reposts are dropped outright for viewers who do not follow you. This content can only reach existing followers.");

  if (o.reply && !o.oon)
    warn("SelfReplyChainFilter", "filters/self_reply_chain_filter.rs", "your reply survives only if the viewer follows the account you replied to (or it is your own self-thread). Replying to a stranger reaches almost no one.");

  if (o.reply || o.retweet)
    warn("OON rescore for in-network", "scorers/ranking_scorer.rs:677", `EnableOonRescoreForInNetworkRepliesRetweets is true, so even in-network replies/reposts take the ${OON_WEIGHT_FACTOR}x discount.`);

  if (o.thread)
    warn("DedupConversationFilter", "filters/dedup_conversation_filter.rs", "one post per conversation id survives. Posts in the same thread compete with each other; only the top-scoring one is served.");

  if (a.links.length)
    warn("SPAM_HIGH_RECALL", "botmaker-rules/.../LQ_Tweets_With_LQ_URL_Verdict...bot", "any LOW_QUALITY verdict anywhere in the URL redirect chain applies SPAM_HIGH_RECALL to the post, which is an out-of-network drop rule. Shorteners inherit the destination's verdict.");

  if (a.bait)
    warn("COPYPASTA_SPAM", "botmaker-rules/.../BBQDuplicateTextProd.bot", "near-duplicate text across posts is clustered offline and labeled COPYPASTA_SPAM. Reusing a template across posts is the exact detection target.");

  if (o.media === "video" && (o.videoMs ?? 0) < MIN_VIDEO_DURATION_MS)
    warn("vqv gate", "params/param.rs MinVideoDurationMs", `video under ${MIN_VIDEO_DURATION_MS}ms gets no video-quality-view head. (Note: VqvWeight default is 0.0 anyway.)`);

  return g;
}

function coldStart(o) {
  // scorers/author_cold_start.rs :: cold_start_base_eligible + params
  const reasons = [];
  if (o.reply) reasons.push("it is a reply (in_reply_to_tweet_id must be none)");
  if (o.retweet) reasons.push("it is a repost (retweeted_tweet_id must be none)");
  if (o.followers > COLD_START_FOLLOWER_CAP) reasons.push(`author has ${o.followers} followers, cap is ${COLD_START_FOLLOWER_CAP}`);
  if (o.impressions >= COLD_START_IMPRESSION_THRESHOLD) reasons.push(`already at ${o.impressions} impressions, threshold is ${COLD_START_IMPRESSION_THRESHOLD}`);
  if (o.ageHours > COLD_START_MAX_POST_AGE_HOURS) reasons.push(`older than ${COLD_START_MAX_POST_AGE_HOURS}h`);
  return { eligible: reasons.length === 0, reasons };
}

// ---------------------------------------------------------------------------
// FACTS: ranking_scorer.rs :: compute_weighted_parts / offset_score
// ---------------------------------------------------------------------------
function score(p, o) {
  const replyW = (o.mutual && !o.reply && !o.retweet) ? W.reply + BIDIRECTIONAL_REPLY_BOOST : W.reply;
  const dwellW = (o.mutual && !o.reply && !o.retweet) ? W.dwell + BIDIRECTIONAL_DWELL_BOOST : W.dwell;
  const vqvW = (o.media === "video" && (o.videoMs ?? 0) >= MIN_VIDEO_DURATION_MS) ? W.vqv : 0;

  const terms = [
    ["favorite", p.favorite * W.favorite],
    ["reply", p.reply * replyW],
    ["retweet", p.retweet * W.retweet],
    ["photo_expand", p.photo_expand * W.photo_expand],
    ["video_open", p.video_open * W.video_open],
    ["click", p.click * W.click],
    ["open_link", p.open_link * W.open_link],
    ["profile_click", p.profile_click * W.profile_click],
    ["vqv", p.vqv * vqvW],
    ["share", p.share * W.share],
    ["share_via_dm", p.share_via_dm * W.share_via_dm],
    ["share_via_copy_link", p.share_via_copy_link * W.share_via_copy_link],
    ["dwell", p.dwell * dwellW],
    ["quote", p.quote * W.quote],
    ["quoted_click", p.quoted_click * W.quoted_click],
    ["quoted_vqv", p.quoted_vqv * W.quoted_vqv],
    ["cont_dwell_time", p.dwell_time * W_CONT.cont_dwell_time],
    ["cont_click_dwell_time", p.click_dwell_time * W_CONT.cont_click_dwell_time],
    ["follow_author", p.follow_author * W.follow_author],
    ["not_interested", p.not_interested * W.not_interested],
    ["block_author", p.block_author * W.block_author],
    ["mute_author", p.mute_author * W.mute_author],
    ["report", p.report * W.report],
    ["not_dwelled", p.not_dwelled * W.not_dwelled],
    // PostUnexploredWeightInNetworkOnly defaults true
    ["post_unexplored", o.oon ? 0 : p.post_unexplored * W.post_unexplored],
  ];

  let pos = 0, neg = 0;
  for (const [, t] of terms) { if (t >= 0) pos += t; else neg -= t; }
  const net = pos - neg;
  const offset = TOTAL_SUM === 0
    ? Math.max(net, 0)
    : net < 0
      ? ((net + NEGATIVE_SUM) / TOTAL_SUM) * NEGATIVE_SCORES_OFFSET
      : net + NEGATIVE_SCORES_OFFSET;

  // author diversity: (1-floor)*decay^k + floor, k = higher-scoring posts of yours in pool
  const k = o.sameAuthorRank;
  const diversity = (1 - AUTHOR_DIVERSITY_FLOOR) * Math.pow(AUTHOR_DIVERSITY_DECAY, k) + AUTHOR_DIVERSITY_FLOOR;
  const afterDiversity = offset * diversity;

  const oonApplies = o.oon || o.reply || o.retweet;
  const oonFactor = o.newViewer ? NEW_USER_OON_WEIGHT_FACTOR : o.topicFeed ? TOPIC_OON_WEIGHT_FACTOR : OON_WEIGHT_FACTOR;
  const final = oonApplies ? afterDiversity * oonFactor : afterDiversity;

  // reachProxy is monotone in net and survives the negative branch, unlike
  // `final` which offset_score compresses into a band near 0.001.
  const reachProxy = Math.max(net, 0) * diversity * (oonApplies ? oonFactor : 1);

  return { terms, pos, neg, net, offset, diversity, oonApplies, oonFactor, final, replyW, reachProxy };
}

// ---------------------------------------------------------------------------
// GOALS. Reach is not the objective for everyone. The two actions that actually
// move money -- open_link (0.2) and profile_click (0.0) -- are the two worst-paid
// heads in the model, so a conversion-optimal post is NOT a reach-optimal post.
// Yield = reach x P(conversion action). You spend reach to get a conversion.
// ---------------------------------------------------------------------------
function yields(s, p) {
  return {
    reach: s.reachProxy,
    follow: s.reachProxy * p.follow_author,
    // profile click -> bio link is the conversion path when the post has no link
    convert: s.reachProxy * (p.open_link + p.profile_click * 0.35),
  };
}
function objective(s, p, goal) {
  const y = yields(s, p);
  return goal === "follow" ? y.follow : goal === "convert" ? y.convert : s.net;
}

// ---------------------------------------------------------------------------
// Levers: re-score with one thing changed, report the delta.
// ---------------------------------------------------------------------------
// Ranked on `net` (the raw weighted score) rather than `final`, because
// offset_score flattens everything in the negative branch into ~0.001 and the
// deltas stop being readable. net is what offset_score is monotone in.
function levers(text, o) {
  const baseP = priorsFor(analyze(text), o);
  const baseS = score(baseP, o);
  const base = objective(baseS, baseP, o.goal);
  const variants = [];
  const add = (label, mutate) => {
    const o2 = { ...o }; let t2 = text;
    const r = mutate(o2); if (typeof r === "string") t2 = r;
    const p2 = priorsFor(analyze(t2), o2);
    const s = score(p2, o2);
    const v = objective(s, p2, o.goal);
    variants.push({ label, delta: v - base, pct: base > 0 ? ((v / base - 1) * 100) : null });
  };

  const a = analyze(text);
  if (!a.endsWithQuestion) add("End on a real question (drives the reply head, weight 5.0)", () => text.trim() + "\n\nWhat am I missing?");
  if (!o.mutual) add("Be a mutual follow of the viewer (reply weight 5.0 -> 20.0)", (x) => { x.mutual = true; });
  if (a.links.length || o.link) add("Move the link out of the post (into a reply)", (x) => { x.link = false; return text.replace(URL_RE, "").trim(); });
  if (a.hashtags.length) add("Delete the hashtags (no scoring head consumes them)", () => text.replace(HASHTAG_RE, "").replace(/\s+/g, " ").trim());
  if (a.bait) add("Cut the engagement-bait phrasing", () => text.replace(ENGAGEMENT_BAIT, "").trim());
  if (a.hype) add("Cut the hype adjectives", () => text.replace(HYPE, "").trim());
  if (o.media === "none") add("Add an image (photo_expand + dwell)", (x) => { x.media = "photo"; });
  if (a.lines < 3 && a.bareChars > 140) add("Break into 3+ short lines (dwell + copy-link share)", () => text.replace(/\. /g, ".\n\n"));
  if (o.reply || o.retweet) add("Post it as an original instead of a reply/repost", (x) => { x.reply = false; x.retweet = false; });
  if (o.sameAuthorRank > 0) add("Be your only post in this scoring pool (author diversity)", (x) => { x.sameAuthorRank = 0; });
  return variants.sort((x, y) => y.delta - x.delta);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const texts = [];
  const o = {
    media: "none", videoMs: 0, link: false, quote: false, reply: false,
    retweet: false, thread: false, oon: false, mutual: false, followers: 5000,
    ageHours: 1, impressions: 0, sameAuthorRank: 0, newViewer: false,
    topicFeed: false, jsonOut: false, goal: "reach",
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const next = () => argv[++i];
    switch (k) {
      case "--text": texts.push(next()); break;
      case "--media": o.media = next(); break;
      case "--goal": o.goal = next(); break;
      case "--video-ms": o.videoMs = +next(); break;
      case "--followers": o.followers = +next(); break;
      case "--age-hours": o.ageHours = +next(); break;
      case "--impressions": o.impressions = +next(); break;
      case "--same-author-rank": o.sameAuthorRank = +next(); break;
      case "--link": o.link = true; break;
      case "--quote": o.quote = true; break;
      case "--reply": o.reply = true; break;
      case "--retweet": o.retweet = true; break;
      case "--thread": o.thread = true; break;
      case "--oon": o.oon = true; break;
      case "--mutual": o.mutual = true; break;
      case "--new-viewer": o.newViewer = true; break;
      case "--topic-feed": o.topicFeed = true; break;
      case "--json-out": o.jsonOut = true; break;
      default:
        if (k.startsWith("--")) { console.error(`unknown flag ${k}`); process.exit(2); }
    }
  }
  return { texts, o };
}
const pad = (s, n) => String(s).padEnd(n);
const bar = (v, max, n = 24) => "█".repeat(Math.max(0, Math.round((Math.abs(v) / max) * n)));

function report(text, o) {
  const a = analyze(text);
  const p = priorsFor(a, o);
  const s = score(p, o);
  const g = gates(a, o);
  const cs = coldStart(o);

  console.log("\n" + "=".repeat(72));
  console.log(JSON.stringify(text.length > 90 ? text.slice(0, 90) + "…" : text));
  console.log("=".repeat(72));

  console.log(`\nshape: ${a.bareChars} chars · ${a.words} words · ${a.lines} lines · ` +
    `${a.links.length} link(s) · ${a.hashtags.length} hashtag(s) · ${a.mentions.length} mention(s) · ` +
    `media=${o.media}${o.mutual ? " · mutual" : ""}${o.oon ? " · out-of-network" : " · in-network"}`);

  console.log("\n-- GATES (drops are from the repo's filter stack, not opinions) --");
  if (!g.length) console.log("  clean: no filter in the stack drops or flags this.");
  for (const x of g) console.log(`  [${x.level}] ${x.name}  (${x.src})\n         ${x.msg}`);

  console.log("\n-- COLD START (scorers/author_cold_start.rs) --");
  if (cs.eligible)
    console.log(`  ELIGIBLE. A post like this can be force-injected at feed slot ${COLD_START_SLOT_MIN}-${COLD_START_SLOT_MAX}\n` +
      `  of ${RESULT_SIZE} regardless of score, for viewers it reaches. This is the single largest\n  free lever available to a <=${COLD_START_FOLLOWER_CAP}-follower account.`);
  else { console.log("  NOT eligible:"); for (const r of cs.reasons) console.log(`    - ${r}`); }

  const maxAbs = Math.max(...s.terms.map(([, t]) => Math.abs(t)));
  console.log("\n-- SCORE CONTRIBUTION (weight x heuristic P(action)) --");
  const sorted = [...s.terms].filter(([, t]) => t !== 0).sort((x, y) => Math.abs(y[1]) - Math.abs(x[1]));
  for (const [name, t] of sorted)
    console.log(`  ${pad(name, 22)} ${t >= 0 ? "+" : "-"}${Math.abs(t).toFixed(5)}  ${bar(t, maxAbs)}`);

  console.log(`\n  positive ${s.pos.toFixed(5)}   negative ${s.neg.toFixed(5)}   net ${s.net.toFixed(5)}`);
  console.log(`  offset_score            ${s.offset.toFixed(5)}`);
  console.log(`  author diversity x${s.diversity.toFixed(4)}   (k=${o.sameAuthorRank} higher-scoring posts of yours in pool)`);
  console.log(`  oon factor       x${s.oonApplies ? s.oonFactor : 1}`);
  console.log(`  FINAL            ${s.final.toFixed(6)}`);

  const y = yields(s, p);
  console.log("\n-- FUNNEL (relative units; reach is SPENT to get a conversion) --");
  console.log(`  reach proxy                      ${y.reach.toFixed(5)}`);
  console.log(`  follow yield   reach x P(follow) ${y.follow.toFixed(7)}   [follow_author weight 4.0 -- well paid]`);
  console.log(`  convert yield  reach x P(click)  ${y.convert.toFixed(7)}   [open_link 0.2, profile_click 0.0 -- unpaid]`);
  console.log(`  optimizing for: ${o.goal.toUpperCase()}`);
  if (o.goal === "convert")
    console.log("  NOTE: profile_click has weight 0.0 and open_link 0.2, against reply 5.0\n" +
                "  and copy-link 20.0. Conversion actions buy you no reach. Expect the\n" +
                "  reach-optimal and convert-optimal drafts to disagree -- that is real.");

  const lv = levers(text, o);
  if (lv.length) {
    console.log(`\n-- HIGHEST-LEVERAGE EDITS (re-scored, ranked by ${o.goal} gain) --`);
    for (const v of lv) {
      const d = `${v.delta >= 0 ? "+" : "-"}${Math.abs(v.delta).toFixed(4)}`;
      const pct = v.pct === null ? "" : ` (${v.pct >= 0 ? "+" : ""}${v.pct.toFixed(0)}%)`;
      console.log(`  ${d.padStart(9)}${pct.padEnd(9)}  ${v.label}`);
    }
  }
  return { text, net: s.net, final: s.final, yields: y, obj: objective(s, p, o.goal),
           gates: g, coldStart: cs, levers: lv, terms: s.terms };
}

const { texts, o } = parseArgs(process.argv.slice(2));
if (!texts.length) {
  console.error("usage: node score.mjs --text \"your draft\" [--media photo] [--oon] [--mutual] ...");
  process.exit(2);
}
const results = texts.map((t) => report(t, o));
if (results.length > 1) {
  console.log("\n" + "=".repeat(72));
  console.log(`A/B RANKING  (goal = ${o.goal})`);
  console.log("=".repeat(72));
  [...results].sort((a, b) => b.obj - a.obj).forEach((r, i) =>
    console.log(`  ${i + 1}. ${o.goal} ${r.obj.toFixed(7)}  reach ${r.yields.reach.toFixed(5)}  ${JSON.stringify(r.text.slice(0, 40))}`));
}
if (o.jsonOut) console.log("\n__JSON__\n" + JSON.stringify(results, null, 2));
console.log("\nNOTE: weights/gates are verbatim from xai-org/x-algorithm. The P(action)");
console.log("priors are heuristic stand-ins for the Phoenix model. Trust the ORDER of");
console.log("the levers and the gate report; the absolute score is arbitrary units.\n");
