// Token Radar's model (radar-2): one sealed snapshot in, one ranked board out.
//
// The board ranks every protocol the snapshot records as having no token (342 of 758),
// strongest implied value first. The snapshot's live-token protocols are set aside with
// their market caps shown, never mixed into the ranking: a token that already trades is
// a fact, not a farm target.
//
// Implied value is derived only from the snapshot's own figures, by one function that
// scores every protocol the same way. No protocol name is ever special-cased.
//
//   peerMultiple(category)  the median market-cap/TVL of the tokenized peers in the same
//                           category (only peers with a positive market cap count), shrunk
//                           toward the global median when the category has few peers, and
//                           clamped to [0.08, 1.50]. It is computed from this snapshot at
//                           run time, so a future snapshot re-prices every category itself.
//   momentum                1 + 0.30 x clamp(change_7d, -50, +100) / 100        (0.85..1.30)
//   sizeDecay               TVL above $2B compresses: max(0.50, (2e9 / tvl)^0.25)
//   ageFactor               0.80 + min(age_days, 1095) / 1095 x 0.45            (0.80..1.25);
//                           a protocol that has run longer with no token and is still
//                           large is read as more overdue; unknown age uses 1.00.
//   junkDiscount            0.05 for products that cannot be a launch of their own:
//                           CEX, Bridge, Canonical Bridge, Liquid Staking, Liquid
//                           Restaking, Restaked BTC, wrapped/staked names, exchange-
//                           prefixed names and version-suffixed names (the same classes
//                           the snapshot's watchlist rule excludes). They are scored
//                           the same way but set aside below the board, never ranked:
//                           a radar that interleaves them would rank a wrapped
//                           product above a real farm.
//   impliedFDV              tvl_usd x peerMultiple x momentum x sizeDecay x ageFactor
//                           x junkDiscount
//   p(launch)               0.02..0.85 from four snapshot signals: TVL tier (log scale),
//                           the category's tokenization rate (how many of its peers
//                           already have a token), the age without a token, and the
//                           sign of the seven-day momentum. Junk classes are capped
//                           at 0.05.
//   impliedValue            round(impliedFDV x 0.075 x p(launch))
//                           7.5% is the assumed airdrop share of the implied FDV:
//                           the part a farmer could plausibly claim.
//
// The dashboard recomputes every row from the same numbers (see dashboard/app.js
// impliedOf), so the page's figures and board.json always agree.

/** The snapshot's protocol entry: exactly the ten fields the sealed input carries. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** The model's constants, as the dashboard states them. */
export interface ModelConstants {
  airdrop_share: number;
  momentum_weight: number;
  momentum_floor: number;
  momentum_cap: number;
  size_threshold_usd: number;
  size_floor: number;
  age_floor: number;
  age_range: number;
  age_days: number;
  junk_discount: number;
  junk_p_cap: number;
  multiple_floor: number;
  multiple_cap: number;
  multiple_shrink_n: number;
  p_base: number;
  p_tvl_weight: number;
  p_category_weight: number;
  p_age_weight: number;
  p_momentum_weight: number;
  p_min: number;
  p_max: number;
}

export const MODEL: ModelConstants = {
  airdrop_share: 0.075,
  momentum_weight: 0.3,
  momentum_floor: -50,
  momentum_cap: 100,
  size_threshold_usd: 2_000_000_000,
  size_floor: 0.5,
  age_floor: 0.8,
  age_range: 0.45,
  age_days: 1095,
  junk_discount: 0.05,
  junk_p_cap: 0.05,
  multiple_floor: 0.08,
  multiple_cap: 1.5,
  multiple_shrink_n: 3,
  p_base: 0.35,
  p_tvl_weight: 0.25,
  p_category_weight: 0.25,
  p_age_weight: 0.1,
  p_momentum_weight: 0.05,
  p_min: 0.02,
  p_max: 0.85,
};

/** The model's version label: the dashboard names it. */
export const MODEL_VERSION = 'radar-2';

/** How many live-token protocols the Live token view carries, by market cap. */
export const LIVE_ROWS = 24;

/** One row of the peer-multiple table: a category's median, its peer count, and the shrunk multiple the model uses. */
export interface PeerMultiple {
  category: string;
  peers: number;
  median: number;
  multiple: number;
}

/** A farm step: the action, what it costs, and how long it takes. */
export interface FarmStep {
  text: string;
  cost: string;
  time: string;
}

/** One row of board.json: the ranked board's row. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  watchlist: boolean;
  junk: boolean;
  junk_reason: string | null;
  age_days: number | null;
  implied_fdv_usd: number;
  launch_probability: number;
  implied_value_usd: number;
  effort_tier: 'Low' | 'Medium' | 'High';
  model: {
    peer_multiple: number;
    momentum_multiplier: number;
    size_multiplier: number;
    age_multiplier: number;
    junk_multiplier: number;
    age_days: number | null;
  };
  farm_steps: string[];
}

/** The dashboard's compact view of one row. */
export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  age_days: number | null;
  watchlist: boolean;
  junk: boolean;
  junk_reason: string | null;
  implied_fdv_usd: number;
  launch_probability: number;
  implied_value_usd: number;
  effort_tier: 'Low' | 'Medium' | 'High';
  peer_multiple: number;
  momentum_multiplier: number;
  size_multiplier: number;
  age_multiplier: number;
  junk_multiplier: number;
  farm_steps: string[];
}

/** A live-token protocol: it already trades, so the board shows the market's own value, not a model's. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
}

/** Everything the dashboard needs: the board, the live set, the peer table and the model. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model: ModelConstants;
  model_version: string;
  watchlist_size: number;
  board_size: number;
  genuine_size: number;
  junk_size: number;
  live_size: number;
  peer_multiples: PeerMultiple[];
  rows: RadarRow[];
  not_candidates: RadarRow[];
  live: LiveRow[];
}

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;

/** A finite number, else `fallback`. */
function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** A whole day count from `from` to `to`, clamped at zero; null when either date is absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** The median of a non-empty list, or null. */
function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

/** The median market-cap/TVL of the snapshot's tokenized protocols with a positive market cap, rounded to 4 decimals so every use of it agrees. */
function globalMultiple(protocols: SnapshotProtocol[]): number {
  const ratios = protocols
    .filter((p) => !isPreToken(p) && (p.mcap_usd ?? 0) > 0 && p.tvl_usd > 0)
    .map((p) => p.mcap_usd! / p.tvl_usd);
  return round4(median(ratios) ?? 0.25);
}

/**
 * The peer-multiple table, computed from this snapshot at run time: per category, the
 * median market-cap/TVL of its tokenized peers with a positive market cap, shrunk toward
 * the global median when the category has few peers, clamped to the model's band.
 */
export function peerMultiples(protocols: SnapshotProtocol[], model: ModelConstants = MODEL): PeerMultiple[] {
  const global = globalMultiple(protocols);
  const byCategory = new Map<string, number[]>();
  for (const p of protocols) {
    if (isPreToken(p) || (p.mcap_usd ?? 0) <= 0 || p.tvl_usd <= 0) continue;
    const key = p.category ?? 'Other';
    const list = byCategory.get(key) ?? [];
    list.push(p.mcap_usd! / p.tvl_usd);
    byCategory.set(key, list);
  }
  const out: PeerMultiple[] = [];
  for (const [category, ratios] of [...byCategory.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const med = median(ratios) ?? global;
    const n = ratios.length;
    const shrunk = (n * med + model.multiple_shrink_n * global) / (n + model.multiple_shrink_n);
    const multiple = Math.min(model.multiple_cap, Math.max(model.multiple_floor, shrunk));
    out.push({ category, peers: n, median: Math.round(med * 1000) / 1000, multiple: Math.round(multiple * 1000) / 1000 });
  }
  return out;
}

/** The tokenization rate of a category: the share of its protocols that already have a token. */
export function categoryTokenRate(protocols: SnapshotProtocol[], category: string | null): number {
  const key = category ?? 'Other';
  let total = 0;
  let tokenized = 0;
  for (const p of protocols) {
    if ((p.category ?? 'Other') !== key) continue;
    total++;
    if (!isPreToken(p)) tokenized++;
  }
  return total === 0 ? 0.5 : tokenized / total;
}

/** DefiLlama's version-marker rule: a name ending in a release is a pool of another protocol. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
/** A whole word wrapped, staked or staking in a name. */
const WRAPPED_STAKED = /\b(wrapped|staked|staking)\b/i;
/** A name that begins with an exchange's name. */
const EXCHANGE_PREFIX = /^(Binance|Coinbase|Bybit|Kraken|Bitget|OKX|Bitfinex|Gemini)\b/;
/** Categories that are a product of a token that already trades, not a launch of their own. */
const JUNK_CATEGORIES = new Set(['CEX', 'Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC']);

/** Why a protocol is not a genuine launch candidate, or null when it is one. */
export function junkReason(p: SnapshotProtocol): string | null {
  if (JUNK_CATEGORIES.has(p.category ?? '')) return `${p.category} is a product of a token that already trades`;
  if (WRAPPED_STAKED.test(p.name)) return 'a wrapped or staked product of a token that already trades';
  if (EXCHANGE_PREFIX.test(p.name)) return 'an exchange product, not a protocol launch';
  if (VERSIONED.test(p.name)) return 'a versioned pool of another protocol';
  return null;
}

/** Whether a protocol records no token at all. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** The snapshot's protocol by slug. */
function bySlug(protocols: SnapshotProtocol[]): Map<string, SnapshotProtocol> {
  return new Map(protocols.map((p) => [p.slug, p]));
}

/** The peer multiple for one category, from the table (the global median when absent). */
function multipleFor(table: PeerMultiple[], category: string | null, fallback: number): number {
  const row = table.find((r) => r.category === (category ?? 'Other'));
  return row === undefined ? fallback : row.multiple;
}

/**
 * The launch probability of one pre-token protocol, 0.02..0.85, from four snapshot
 * signals: TVL tier on a log scale, its category's tokenization rate, its age with no
 * token, and the sign of its seven-day momentum. Junk classes are capped at 0.05.
 */
export function launchProbability(
  p: SnapshotProtocol,
  age: number | null,
  tokenRate: number,
  junk: boolean,
  model: ModelConstants = MODEL,
): number {
  const tvlTier = Math.min(1, Math.max(0, Math.log10(Math.max(p.tvl_usd, 1) / 5_000_000) / Math.log10(100_000_000_000 / 5_000_000)));
  const agePart = age === null ? 0.05 : (Math.min(age, 730) / 730) * model.p_age_weight;
  const momentumPart = (p.change_7d ?? 0) >= 0 ? model.p_momentum_weight : -model.p_momentum_weight;
  let prob = model.p_base + tvlTier * model.p_tvl_weight + tokenRate * model.p_category_weight + agePart + momentumPart;
  prob = Math.min(model.p_max, Math.max(model.p_min, prob));
  if (junk) prob = Math.min(prob, model.junk_p_cap);
  return Math.round(prob * 1000) / 1000;
}

/** The implied FDV and implied value of one pre-token protocol under the model. */
export function impliedValue(
  p: SnapshotProtocol,
  asOf: string,
  table: PeerMultiple[],
  tokenRate: number,
  fallbackMultiple: number,
  model: ModelConstants = MODEL,
): {
  impliedFdv: number;
  implied: number;
  probability: number;
  peerMultiple: number;
  momentumMult: number;
  sizeMult: number;
  ageMult: number;
  junkMult: number;
  age: number | null;
  junk: boolean;
  reason: string | null;
} {
  const age = ageDays(asOf, p.listed_at);
  const reason = junkReason(p);
  const junk = reason !== null;
  const peerMultiple = multipleFor(table, p.category, fallbackMultiple);
  const growth = Math.min(model.momentum_cap, Math.max(model.momentum_floor, finite(p.change_7d, 0)));
  const momentumMult = 1 + (growth / 100) * model.momentum_weight;
  const sizeMult =
    p.tvl_usd > model.size_threshold_usd
      ? Math.max(model.size_floor, Math.pow(model.size_threshold_usd / p.tvl_usd, 0.25))
      : 1;
  const ageMult = age === null ? 1 : model.age_floor + (Math.min(age, model.age_days) / model.age_days) * model.age_range;
  const junkMult = junk ? model.junk_discount : 1;
  const impliedFdv = Math.max(1, Math.round(p.tvl_usd * peerMultiple * momentumMult * sizeMult * ageMult * junkMult));
  const probability = launchProbability(p, age, tokenRate, junk, model);
  const implied = Math.max(1, Math.round(impliedFdv * model.airdrop_share * probability));
  return { impliedFdv, implied, probability, peerMultiple, momentumMult, sizeMult, ageMult, junkMult, age, junk, reason };
}

/** The farming effort tier from the protocol's first chain: gas-heavy chains cost more to farm. */
export function effortTier(p: SnapshotProtocol): 'Low' | 'Medium' | 'High' {
  const chain = (p.chains[0] ?? '').toLowerCase();
  if (chain === 'ethereum' || chain === 'bitcoin') return 'High';
  if (
    chain === 'solana' ||
    chain === 'base' ||
    chain === 'arbitrum' ||
    chain === 'optimism' ||
    chain === 'polygon' ||
    chain === 'unichain' ||
    chain === 'ink' ||
    chain === 'katana' ||
    chain === 'arc' ||
    chain === 'tempo'
  ) {
    return 'Low';
  }
  return 'Medium';
}

const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

/** A step as one string: its action, then its cost and time, within the gate's 20..600 characters. */
export function stepText(step: FarmStep): string {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

/** The first chain a protocol names, or a neutral phrase. */
function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** How much capital one farm position needs, from the protocol's own TVL. */
function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 5_000_000_000) return 250;
  if (p.tvl_usd >= 1_000_000_000) return 150;
  if (p.tvl_usd >= 100_000_000) return 100;
  return 50;
}

/** How long to hold, from the protocol's age: younger protocols get a longer qualifying window. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/** The category's core farming action, in the words a farmer can follow. */
function actionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return `Supply $${capital} of USDC to ${name} on ${chain} and keep the position open.`;
  if (c.includes('dex') || c.includes('perpetual') || c.includes('derivative') || c.includes('options')) return `Trade on ${name} on ${chain}: swap $${capital} through its pools and keep a small open position.`;
  if (c.includes('yield') || c.includes('leveraged farm')) return `Provide $${capital} of liquidity to ${name}'s main pool on ${chain} and keep the position open.`;
  if (c.includes('bridge')) return `Bridge $${capital} of USDC to ${chain} through ${name} and use the bridged funds in its app.`;
  if (c.includes('staking') || c.includes('restak')) return `Stake $${capital} of the chain's staking asset through ${name} and keep the receipt token.`;
  if (c.includes('prediction')) return `Fund $${capital} and place one market position on ${name}.`;
  if (c.includes('curator') || c.includes('allocator') || c.includes('risk')) return `Deposit $${capital} into a ${name} vault on ${chain} and keep the vault shares.`;
  if (c.includes('stable')) return `Mint or deposit $${capital} of the stable asset through ${name} on ${chain}.`;
  if (c.includes('rwa')) return `Mint $${capital} of the protocol's yield asset on ${chain} and hold it.`;
  if (c.includes('insurance')) return `Buy $${capital} of cover from ${name} on ${chain} and keep the policy.`;
  if (c.includes('nft') || c.includes('gaming') || c.includes('game')) return `Use ${name} on ${chain} with $${capital}: mint, trade or play at least once a week.`;
  if (c.includes('launchpad')) return `Hold $${capital} in ${name} on ${chain} and join one launch while the position is open.`;
  return `Deposit $${capital} of USDC into ${name} on ${chain} and keep the position open.`;
}

/** The category's second, distinct action, so the plan is a routine and not one trade. */
function secondActionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return `Borrow $${Math.round(capital / 2)} against the supplied collateral on ${name} and repay it within a week.`;
  if (c.includes('dex') || c.includes('perpetual') || c.includes('derivative') || c.includes('options')) return `Add $${Math.round(capital / 2)} as liquidity to one ${name} pool on ${chain} and leave it for the full hold period.`;
  if (c.includes('bridge')) return `Send a second, smaller bridge of $${Math.round(capital / 4)} through ${name} a week later, in the other direction.`;
  if (c.includes('curator') || c.includes('allocator') || c.includes('risk')) return `Try a second ${name} vault on ${chain} with $${Math.round(capital / 2)} so the wallet shows two vaults, not one.`;
  if (c.includes('prediction')) return `Place a second, opposite-side position of $${Math.round(capital / 4)} on ${name} a few days later.`;
  return `Repeat the first action with $${Math.round(capital / 2)} on a second wallet-free week, so the activity reads as a habit, not a single spike.`;
}

/**
 * A protocol's farm plan: seven steps, each an action with a cost and a time. The plan is
 * derived from the protocol's own record (category, chains, TVL, age), never from a
 * hand-written list of names. Junk-classed protocols get a plan that says so first:
 * farming them is farming a product whose token already trades.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null, junk: boolean, reason: string | null): FarmStep[] {
  const chain = chainOf(p);
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  const steps: FarmStep[] = [];
  if (junk) {
    steps.push({
      text: `Do not farm ${p.name} for a launch: ${reason ?? 'it is not a genuine launch candidate'}. Only use it if you need the product itself.`,
      cost: 'no farm cost; the product works as advertised',
      time: 'read this first, 2 minutes',
    });
  } else {
    steps.push({
      text: `Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline.`,
      cost: 'under $3 of gas for the first transaction',
      time: '5 minutes',
    });
  }
  steps.push(
    {
      text: actionFor(p, capital, chain),
      cost: `$${capital} of capital and about $${capital >= 150 ? 8 : 4} of gas`,
      time: '15 minutes to set up',
    },
    {
      text: secondActionFor(p, capital, chain),
      cost: `$${Math.round(capital / 2)} of capital and about $3 of gas`,
      time: '10 minutes',
    },
    {
      text: `Make one qualifying action each week, such as a deposit, a borrow, a swap or a vote.`,
      cost: 'about $2 of gas a week',
      time: '10 minutes a week',
    },
    {
      text: `Hold the position for at least ${hold} days so the activity is counted in more than one snapshot.`,
      cost: `the $${capital} stays in the position`,
      time: `${hold} days`,
    },
    {
      text: `Before you withdraw, open the protocol's own points or rewards page and claim only from the link it publishes.`,
      cost: 'no fee to check, and never pay to claim',
      time: '10 minutes',
    },
    {
      text: `Write the wallet, the dates and every transaction in a farm log so you can repeat the position or unwind it.`,
      cost: 'nothing but the log',
      time: '5 minutes',
    },
  );
  return steps;
}

/** The live-token protocols, by market cap, for the dashboard's Live token view. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, LIVE_ROWS)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
    }));
}

/** The protocols the board ranks, strongest first, with ranks 1..n: genuine launch
 * candidates only. Products that cannot be a launch of their own (the junk classes)
 * are scored the same way but set aside by buildRadar, never mixed into the ranking:
 * a board that interleaves them would rank a wrapped product above a real farm. */
export function buildBoard(snapshot: Snapshot, model: ModelConstants = MODEL): BoardRow[] {
  const index = bySlug(snapshot.protocols);
  const table = peerMultiples(snapshot.protocols, model);
  const fallbackMultiple = globalMultiple(snapshot.protocols);
  const chosen = new Map<string, SnapshotProtocol>();
  // The watchlist is the floor: every slug, even one the snapshot no longer carries.
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  // The early radar: every other pre-token protocol, so the board is the whole
  // pre-token universe, not just the floor.
  for (const p of snapshot.protocols) {
    if (!chosen.has(p.slug) && isPreToken(p)) chosen.set(p.slug, p);
  }

  const scored = [...chosen.values()]
    .map((p) => {
      const tokenRate = categoryTokenRate(snapshot.protocols, p.category);
      const v = impliedValue(p, snapshot.as_of, table, tokenRate, fallbackMultiple, model);
      return { p, v };
    })
    .filter((s) => !s.v.junk);
  scored.sort((a, b) => b.v.implied - a.v.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  return scored.map((s, i) => boardRowFrom(s.p, s.v, snapshot, i + 1, model));
}

/** One scored protocol as a board row. */
function boardRowFrom(
  p: SnapshotProtocol,
  v: {
    impliedFdv: number;
    implied: number;
    probability: number;
    peerMultiple: number;
    momentumMult: number;
    sizeMult: number;
    ageMult: number;
    junkMult: number;
    age: number | null;
    junk: boolean;
    reason: string | null;
  },
  snapshot: Snapshot,
  rank: number,
  model: ModelConstants,
): BoardRow {
  return {
    rank,
    slug: p.slug,
    name: p.name,
    category: p.category,
    chains: p.chains,
    tvl_usd: p.tvl_usd,
    change_7d: p.change_7d,
    mcap_usd: p.mcap_usd,
    listed_at: p.listed_at,
    gecko_id: p.gecko_id,
    symbol: p.symbol,
    token_status: 'pre-token',
    watchlist: snapshot.watchlist.includes(p.slug),
    junk: v.junk,
    junk_reason: v.reason,
    age_days: v.age,
    implied_fdv_usd: v.impliedFdv,
    launch_probability: v.probability,
    implied_value_usd: v.implied,
    effort_tier: effortTier(p),
    model: {
      peer_multiple: round4(v.peerMultiple),
      momentum_multiplier: round4(v.momentumMult),
      size_multiplier: round4(v.sizeMult),
      age_multiplier: round4(v.ageMult),
      junk_multiplier: v.junkMult,
      age_days: v.age,
    },
    farm_steps: farmSteps(p, v.age, v.junk, v.reason).map(stepText),
  };
}

/** The pre-token protocols the board sets aside: scored the same way, strongest first,
 * each with the reason it is not a launch candidate. Shown below the board, not ranked. */
export function notCandidates(snapshot: Snapshot, model: ModelConstants = MODEL): BoardRow[] {
  const table = peerMultiples(snapshot.protocols, model);
  const fallbackMultiple = globalMultiple(snapshot.protocols);
  const scored = snapshot.protocols
    .filter((p) => isPreToken(p) && junkReason(p) !== null)
    .map((p) => {
      const tokenRate = categoryTokenRate(snapshot.protocols, p.category);
      const v = impliedValue(p, snapshot.as_of, table, tokenRate, fallbackMultiple, model);
      return { p, v };
    });
  scored.sort((a, b) => b.v.implied - a.v.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  return scored.map((s, i) => boardRowFrom(s.p, s.v, snapshot, i + 1, model));
}

/** A board row's compact form for data.js. */
export function radarRow(row: BoardRow): RadarRow {
  return {
    rank: row.rank,
    slug: row.slug,
    name: row.name,
    category: row.category,
    chains: row.chains,
    tvl_usd: row.tvl_usd,
    change_7d: row.change_7d,
    listed_at: row.listed_at,
    age_days: row.age_days,
    watchlist: row.watchlist,
    junk: row.junk,
    junk_reason: row.junk_reason,
    implied_fdv_usd: row.implied_fdv_usd,
    launch_probability: row.launch_probability,
    implied_value_usd: row.implied_value_usd,
    effort_tier: row.effort_tier,
    peer_multiple: row.model.peer_multiple,
    momentum_multiplier: row.model.momentum_multiplier,
    size_multiplier: row.model.size_multiplier,
    age_multiplier: row.model.age_multiplier,
    junk_multiplier: row.model.junk_multiplier,
    farm_steps: row.farm_steps,
  };
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(snapshot: Snapshot, model: ModelConstants = MODEL): { board: BoardRow[]; radar: RadarData } {
  const board = buildBoard(snapshot, model);
  const aside = notCandidates(snapshot, model);
  const live = liveRows(snapshot);
  const table = peerMultiples(snapshot.protocols, model);
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model,
    model_version: MODEL_VERSION,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    genuine_size: board.length,
    junk_size: aside.length,
    live_size: live.length,
    peer_multiples: table,
    rows: board.map(radarRow),
    not_candidates: aside.map(radarRow),
    live,
  };
  return { board, radar };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
}

/** Why a board is not one the gate will take, or null: coverage, ranks, order, one shared implied value, and farm steps. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    const steps = r.farm_steps;
    if (steps.length < 3 || steps.length > 12) return `${r.slug} has ${steps.length} farm steps`;
    for (const s of steps) if (s.length < 20 || s.length > 600) return `${r.slug} has a farm step of ${s.length} characters`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
    if (r.implied_value_usd > 100_000_000_000_000) return `${r.slug} has implied value over the gate cap`;
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
