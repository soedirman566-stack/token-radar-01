// Token Launch Radar v3 — winsorised, size-banded peer calibration with an
// ensemble fundamentals anchor.
//
// Reads the sealed DefiLlama snapshot, ranks every protocol that records no
// token by the implied value of a future launch, and writes board.json, the
// dashboard (with a generated data.js), the screenshots and dossier.json.
//
// What changed from v2 (which used a plain per-category median multiple):
//  - Every market-cap/TVL ratio is winsorised to the snapshot's own 5th-95th
//    percentile band before it is used, so one micro-cap outlier can no
//    longer drag a whole category's multiple.
//  - A protocol's peer multiple is a weighted median of its category's
//    tokenised peers, weighted by size: peers whose TVL sits within an 8x
//    band of the protocol's own TVL count fully, peers outside it count
//    0.35 — a lending market is priced against lending markets its own size.
//  - The peer estimate is shrunk toward the snapshot-wide multiple with a
//    prior weight of 6 effective peers, so a category with two wild peers
//    cannot produce an absurd multiple; the result is clamped to [0.05, 40].
//  - The implied FDV is a geometric ensemble: 65% the peer model above,
//    35% a fundamentals-only model (TVL x snapshot-wide multiple x momentum
//    x age, no category term), so thin or missing categories degrade to a
//    sane anchor instead of to noise.
//  - Launch probability is a smooth logistic in log TVL instead of six
//    steps, gains a small chain-breadth term (the snapshot has no volume
//    series, so deployment breadth is the liquidity-access proxy), and the
//    momentum factor is softened so one wild week moves value less.
// Implied value per protocol is
//   implied FDV (ensemble) x 7.5% assumed airdrop share x launch probability.
//
// Usage: node main.ts [inputPath] [outputDir]
//        node main.ts --input <path> --output <dir>
//        (defaults /input/snapshot.json and /output; MAKEFUN_OUTPUT_DIR
//         names the output directory when no argument gives one)

import { readFileSync, writeFileSync, mkdirSync, copyFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDossier } from './vendor/makefun-board.ts';

interface Proto {
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

interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: Proto[];
  watchlist: string[];
}

const AIRDROP_SHARE = 0.075;
const PEER_WEIGHT = 0.65; // ensemble weight on the peer-calibrated model
const SHRINK_PRIOR = 6; // effective peers of prior weight on the global multiple
const BAND = 8; // size band: peers within BAND x of the target TVL count fully
const BAND_WEIGHT = 0.35; // weight of a peer outside the size band
const MULT_FLOOR = 0.05;
const MULT_CAP = 40;
const JUNK_CATEGORIES = new Set([
  'Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX',
]);
const EXCHANGE_PREFIXES = new Set([
  'Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini',
]);

// A protocol is "not a launch candidate" when it is a wrapped, staked or
// bridged product of something whose token already trades, a versioned copy,
// or an exchange's own product — the same tests the watchlist rule applies.
function isJunk(p: Proto): boolean {
  if (p.category !== null && JUNK_CATEGORIES.has(p.category)) return true;
  if (/\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/.test(p.name)) return true;
  if (/\b(wrapped|staked|staking)\b/i.test(p.name)) return true;
  const firstWord = p.name.split(/\s+/)[0];
  if (EXCHANGE_PREFIXES.has(firstWord)) return true;
  return false;
}

function hasToken(p: Proto): boolean {
  return p.gecko_id !== null || p.symbol !== null || p.mcap_usd !== null;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  return sorted[base + 1] !== undefined ? sorted[base] + rest * (sorted[base + 1] - sorted[base]) : sorted[base];
}

// Weighted median: the value where cumulative weight first reaches half the
// total weight. Deterministic for a fixed input order after sorting by value.
function weightedMedian(items: { v: number; w: number }[]): number {
  const s = [...items].sort((a, b) => a.v - b.v);
  const total = s.reduce((acc, x) => acc + x.w, 0);
  let acc = 0;
  for (const x of s) {
    acc += x.w;
    if (acc >= total / 2) return x.v;
  }
  return s.length > 0 ? s[s.length - 1].v : 1;
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

interface Peer {
  ratio: number; // winsorised market-cap / TVL
  tvl: number;
}

interface CategoryStats {
  tokenisedPeers: number;
  tokenisationRate: number;
  representativeMultiple: number; // peer multiple at the category's median pre-token TVL
}

interface Calibration {
  stats: Map<string, CategoryStats>;
  peersByCat: Map<string, Peer[]>;
  globalMultiple: number; // winsorised snapshot-wide median multiple
}

let globalMultipleValue = 1;

// Calibrate from the snapshot itself: winsorise every tokenised protocol's
// market-cap/TVL ratio into the snapshot's 5th-95th percentile band, group
// the survivors by category, and keep the snapshot-wide winsorised median as
// the global anchor and shrinkage target.
function calibrate(protocols: Proto[]): Calibration {
  const rawRatios: number[] = [];
  for (const p of protocols) {
    if (p.mcap_usd !== null && p.tvl_usd > 0) rawRatios.push(p.mcap_usd / p.tvl_usd);
  }
  const sortedRatios = [...rawRatios].sort((a, b) => a - b);
  const lo = quantile(sortedRatios, 0.05);
  const hi = quantile(sortedRatios, 0.95);
  const winsorised = rawRatios.map((r) => clamp(r, lo, hi));
  const globalMultiple = winsorised.length > 0 ? median(winsorised) : 1;
  globalMultipleValue = globalMultiple;

  const peersByCat = new Map<string, Peer[]>();
  const totals = new Map<string, { total: number; tokenised: number; preTokenTvls: number[] }>();
  for (const p of protocols) {
    const cat = p.category ?? 'Uncategorised';
    let t = totals.get(cat);
    if (!t) { t = { total: 0, tokenised: 0, preTokenTvls: [] }; totals.set(cat, t); }
    t.total += 1;
    if (hasToken(p)) {
      t.tokenised += 1;
      if (p.mcap_usd !== null && p.tvl_usd > 0) {
        const peer = { ratio: clamp(p.mcap_usd / p.tvl_usd, lo, hi), tvl: p.tvl_usd };
        const arr = peersByCat.get(cat);
        if (arr) arr.push(peer); else peersByCat.set(cat, [peer]);
      }
    } else {
      t.preTokenTvls.push(Math.max(1, p.tvl_usd));
    }
  }

  const stats = new Map<string, CategoryStats>();
  for (const [cat, t] of totals) {
    const peers = peersByCat.get(cat) ?? [];
    const repTvl = t.preTokenTvls.length > 0 ? median(t.preTokenTvls) : 1e8;
    stats.set(cat, {
      tokenisedPeers: peers.length,
      tokenisationRate: t.total > 0 ? t.tokenised / t.total : 0,
      representativeMultiple: peerMultiple(peers, repTvl, globalMultiple),
    });
  }
  return { stats, peersByCat, globalMultiple };
}

// The peer multiple for one protocol: a size-weighted median of its
// category's winsorised peer ratios, shrunk toward the global multiple by a
// prior of SHRINK_PRIOR effective peers, then clamped to a sane range. A
// category with no tokenised peers prices at the global multiple.
function peerMultiple(peers: Peer[], tvl: number, globalMultiple: number): number {
  if (peers.length === 0) return clamp(globalMultiple, MULT_FLOOR, MULT_CAP);
  const items = peers.map((peer) => ({
    v: peer.ratio,
    w: peer.tvl >= tvl / BAND && peer.tvl <= tvl * BAND ? 1 : BAND_WEIGHT,
  }));
  const wm = weightedMedian(items);
  const nEff = items.reduce((acc, x) => acc + x.w, 0);
  const shrunk = (nEff * wm + SHRINK_PRIOR * globalMultiple) / (nEff + SHRINK_PRIOR);
  return clamp(shrunk, MULT_FLOOR, MULT_CAP);
}

function momentumFactor(change7d: number | null): number {
  if (change7d === null) return 1;
  // Softened from v2: a single wild week moves the value less (a +60% week
  // is worth x1.15, not x1.30), and the clamps bite earlier.
  const c = clamp(change7d, -40, 60);
  return c >= 0 ? 1 + 0.0025 * c : 1 + 0.005 * c; // -40 -> 0.80, +60 -> 1.15
}

function ageInDays(listedAt: string | null, asOf: string): number | null {
  if (listedAt === null) return null;
  const ms = Date.parse(asOf + 'T00:00:00Z') - Date.parse(listedAt + 'T00:00:00Z');
  if (Number.isNaN(ms)) return null;
  return Math.max(0, Math.round(ms / 86400000));
}

function ageFactor(days: number | null): number {
  if (days === null) return 1;
  return 1 + 0.25 * clamp(days, 0, 1825) / 1825; // up to x1.25 at five tokenless years
}

function sizeFactor(tvl: number): number {
  if (tvl <= 1e9) return 1;
  return Math.pow(1e9 / tvl, 0.08); // very large TVL rarely launches near peer multiples
}

function launchProbability(tvl: number, days: number | null, change7d: number | null, tokenisationRate: number, chainCount: number): number {
  // Smooth in log TVL (v2 stepped through six tiers, so two near-identical
  // protocols either side of a tier edge got visibly different odds): a
  // logistic centred on $100M of TVL, worth 0.16 at the smallest sizes and
  // rising toward 0.60 for the largest.
  const z = (Math.log10(Math.max(1, tvl)) - 8) / 0.75;
  let p = 0.16 + 0.44 / (1 + Math.exp(-z));
  p *= 0.75 + 0.5 * tokenisationRate; // categories that tokenise, tokenise again
  if (days !== null) {
    if (days >= 730) p *= 1.15;
    else if (days >= 365) p *= 1.08;
    else if (days < 90) p *= 0.85;
  }
  if (change7d !== null) {
    if (change7d > 5) p *= 1.06;
    else if (change7d < -10) p *= 0.92;
  }
  // The snapshot carries no volume or liquidity series, so the breadth of a
  // protocol's deployment stands in for it: a protocol live on more chains
  // has more places a launch can be distributed and farmed. Worth up to
  // x1.15 at six or more chains.
  p *= 1 + 0.03 * Math.min(Math.max(0, chainCount - 1), 5);
  return clamp(p, 0.05, 0.85);
}

// ---- Farm plans -----------------------------------------------------------

const GAS_BY_CHAIN: Record<string, [string, string]> = {
  Ethereum: ['$4-$8', '$12-$30'],
  Solana: ['under $0.10', 'under $1'],
  Base: ['$0.10-$0.50', '$1-$4'],
  Arbitrum: ['$0.20-$1', '$2-$6'],
  Optimism: ['$0.20-$1', '$2-$6'],
  Polygon: ['$0.05-$0.30', '$1-$3'],
  BSC: ['$0.20-$0.80', '$2-$5'],
  Avalanche: ['$0.30-$1.50', '$3-$8'],
};

interface FarmCtx {
  name: string;
  chain1: string;
  capital: string;
  tranche: string;
  gas: string;
  gasWeek: string;
}

function farmCtx(p: Proto): FarmCtx {
  const chain1 = p.chains.length > 0 ? p.chains[0] : 'Ethereum';
  const [gas, gasWeek] = GAS_BY_CHAIN[chain1] ?? ['$0.50-$2', '$4-$10'];
  const tier = p.tvl_usd >= 1e8 ? 0 : p.tvl_usd >= 2e7 ? 1 : 2;
  return {
    name: p.name,
    chain1,
    capital: ['$500-$2,000', '$200-$800', '$50-$300'][tier],
    tranche: ['$300-$700', '$100-$300', '$25-$100'][tier],
    gas,
    gasWeek,
  };
}

function playbookKey(category: string | null): string {
  switch (category) {
    case 'Lending': case 'Uncollateralized Lending': case 'CDP': case 'CDP Manager': case 'Collateral Markets':
      return 'lending';
    case 'Dexs':
      return 'dex';
    case 'Derivatives': case 'Interest Rate Derivatives': case 'Options Vault':
      return 'perps';
    case 'Yield': case 'Yield Aggregator': case 'Leveraged Farming': case 'Farm': case 'Basis Trading':
      return 'yield';
    case 'Risk Curators': case 'Onchain Capital Allocator':
      return 'curator';
    case 'RWA':
      return 'rwa';
    default:
      return 'generic';
  }
}

const CORE_STEP: Record<string, (c: FarmCtx) => string> = {
  lending: (c) => `Supply collateral into ${c.name} on ${c.chain1} in three tranches over the first week (about ${c.tranche} each) rather than one lump sum, then borrow a conservative 30-40 percent against it and repay within days. Cost: about ${c.gas} per transaction.`,
  dex: (c) => `Swap between the main pairs on ${c.name} (${c.chain1}) in sizes of ${c.tranche} or more, two to three swaps in the first session, and add a small two-sided liquidity position you leave in place. Cost: about ${c.gas} per swap plus the pool's trading fee.`,
  perps: (c) => `Open small perpetual positions on ${c.name} on ${c.chain1} at 2-3x leverage with a strict stop, trading both long and short across the first week so the account shows real usage, not one lucky bet. Cost: about ${c.gas} per order plus trading fees on ${c.tranche} of size.`,
  yield: (c) => `Deposit ${c.tranche} into the flagship vault or pool of ${c.name} on ${c.chain1} and leave it compounding; a sustained vault balance is what most launch snapshots read. Cost: about ${c.gas} for the deposit and no ongoing fee.`,
  curator: (c) => `Allocate ${c.tranche} to one curated vault on ${c.name} (${c.chain1}) and a second ${c.tranche} to a different curator's vault on the same platform, since curator platforms reward depositors on both sides. Cost: about ${c.gas} per deposit.`,
  rwa: (c) => `Onboard with ${c.name} on ${c.chain1}: complete any accreditation or KYC step early, because it can take days, then take a first ${c.tranche} position in its flagship real-world asset pool. Cost: about ${c.gas} in gas plus any onboarding fee the app shows.`,
  generic: (c) => `Use the core product of ${c.name} on ${c.chain1} with ${c.tranche} of working capital in the first week: complete one full cycle of its main action (deposit, stake, mint or trade, as the app offers) rather than a token touch. Cost: about ${c.gas} per transaction.`,
};

const CADENCE_STEP: Record<string, (c: FarmCtx) => string> = {
  lending: (c) => `Repeat a small supply-borrow-repay cycle on ${c.name} every week for 8 weeks, keeping utilisation under 60 percent so liquidation risk stays near zero. Cost: roughly ${c.gasWeek} a week in gas and about 15 minutes each round.`,
  dex: (c) => `Make 2-4 swaps a week on ${c.name} for 8 weeks at varied sizes and times of day, and rebalance the liquidity position once a month. Cost: about ${c.gasWeek} a week in gas and fees, roughly 20 minutes weekly.`,
  perps: (c) => `Trade ${c.name} in two sessions a week for 8 weeks, keeping each position under a quarter of your working capital and logging every fill in your sheet. Cost: about ${c.gasWeek} a week in fees and roughly 30 minutes a week.`,
  yield: (c) => `Top up the ${c.name} position by about 10 percent every two weeks for 8 weeks, and harvest or restake rewards once they are worth more than the gas to claim. Cost: about ${c.gas} per top-up and 10 minutes a fortnight.`,
  curator: (c) => `Review your ${c.name} allocations monthly: move capital toward vaults gaining TVL share and away from any vault with rising bad debt or falling rates. Cost: about ${c.gas} per rebalance and 20 minutes a month.`,
  rwa: (c) => `Add to the ${c.name} position monthly for 6 months and hold through each yield distribution; real-world asset launches reward duration of holding more than turnover. Cost: about ${c.gas} per addition and 15 minutes monthly.`,
  generic: (c) => `Repeat the main ${c.name} action weekly for 8 weeks at slightly varied sizes, and try one secondary feature (a second chain, pool or product line) by week four. Cost: about ${c.gasWeek} a week and 15-20 minutes weekly.`,
};

function farmSteps(p: Proto, junk: boolean): string[] {
  const c = farmCtx(p);
  if (junk) {
    return [
      `Do not farm ${c.name} for a launch of its own: it is a wrapped, staked or bridged product, or an exchange's own product, so any token value already sits with the parent asset. Cost: $0 - the step is skipping it.`,
      `If you want the exposure, hold or stake the underlying asset through its own protocol instead, where any future distribution would be based. Cost: the parent product's normal gas, about ${c.gas} per transaction on ${c.chain1}.`,
      `Watch the parent protocol's announcements rather than ${c.name}'s: distributions for products like this are paid on the underlying asset, not on the wrapped form. Cost: $0 and about 5 minutes a month.`,
      `Once a month, re-check whether ${c.name} still records no token of its own in the data; if that ever changes, rebuild the plan around the new token's own market. Cost: $0 and 5 minutes monthly.`,
    ];
  }
  const key = playbookKey(p.category);
  return [
    `Open a fresh wallet used only for ${c.name} and fund it with ${c.capital} of working capital on ${c.chain1}. One wallet, used consistently, is the identity a points program rewards. Setup costs about ${c.gas} in gas and 20 minutes.`,
    CORE_STEP[key](c),
    CADENCE_STEP[key](c),
    `Once a week, open the ${c.name} app and record your points, balance and any season deadline in a tracking sheet, with a screenshot. Launch snapshots are rarely announced in advance. Cost: $0 and about 10 minutes weekly.`,
    `Keep every ${c.name} action on that single wallet: vary amounts by roughly 10-20 percent, spread actions across different days, and never mirror the same amounts from other wallets. Cost: $0; consistency, not volume, is what survives a sybil filter.`,
    `Once a month, check ${c.name}'s governance forum and official announcements for a token vote, a points season end or a claim window, and keep your transaction hashes in the tracking sheet. Cost: $0 and about 15 minutes monthly.`,
  ];
}

// ---- Board ----------------------------------------------------------------

interface Scored {
  p: Proto;
  junk: boolean;
  multiple: number;
  fundMultiple: number;
  momF: number;
  ageF: number;
  sizeF: number;
  days: number | null;
  prob: number;
  fdv: number;
  rawValue: number;
}

function scoreAll(snap: Snapshot, cal: Calibration): Scored[] {
  const out: Scored[] = [];
  for (const p of snap.protocols) {
    if (hasToken(p)) continue; // the radar ranks only protocols still to launch
    const cat = p.category ?? 'Uncategorised';
    const st = cal.stats.get(cat);
    const tokRate = st ? st.tokenisationRate : 0;
    const tvl = Math.max(1, p.tvl_usd); // guard: a zero or missing TVL prices at the floor, never NaN
    const multiple = peerMultiple(cal.peersByCat.get(cat) ?? [], tvl, cal.globalMultiple);
    const days = ageInDays(p.listed_at, snap.as_of);
    const momF = momentumFactor(p.change_7d);
    const ageF = ageFactor(days);
    const sizeF = sizeFactor(tvl);
    // Ensemble: geometric blend of the peer model and a fundamentals-only
    // model that knows no category, only the snapshot-wide multiple.
    const fdvPeer = tvl * multiple * momF * ageF * sizeF;
    const fdvFund = tvl * cal.globalMultiple * momF * ageF;
    const fdv = Math.exp(PEER_WEIGHT * Math.log(fdvPeer) + (1 - PEER_WEIGHT) * Math.log(fdvFund));
    const prob = launchProbability(tvl, days, p.change_7d, tokRate, p.chains.length);
    out.push({
      p, junk: isJunk(p), multiple, fundMultiple: cal.globalMultiple, momF, ageF, sizeF, days, prob, fdv,
      rawValue: fdv * AIRDROP_SHARE * prob,
    });
  }
  return out;
}

function byValueThenSlug(a: Scored, b: Scored): number {
  if (b.rawValue !== a.rawValue) return b.rawValue - a.rawValue;
  return a.p.slug < b.p.slug ? -1 : 1;
}

function copyDir(src: string, dst: string): void {
  mkdirSync(dst, { recursive: true });
  for (const name of readdirSync(src)) {
    const s = join(src, name);
    const d = join(dst, name);
    if (statSync(s).isDirectory()) copyDir(s, d);
    else copyFileSync(s, d);
  }
}

function resolvePaths(): { inputPath: string; outDir: string } {
  const args = process.argv.slice(2);
  let inputPath: string | undefined;
  let outDir: string | undefined;
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--input') inputPath = args[++i];
    else if (args[i] === '--output' || args[i] === '--out') outDir = args[++i];
    else positional.push(args[i]);
  }
  return {
    inputPath: inputPath ?? positional[0] ?? '/input/snapshot.json',
    outDir: outDir ?? positional[1] ?? process.env.MAKEFUN_OUTPUT_DIR ?? '/output',
  };
}

function main(): void {
  const { inputPath, outDir } = resolvePaths();
  const repoDir = dirname(fileURLToPath(import.meta.url));
  const snap = JSON.parse(readFileSync(inputPath, 'utf8')) as Snapshot;
  const watch = new Set(snap.watchlist);
  const cal = calibrate(snap.protocols);
  const scored = scoreAll(snap, cal);

  const real = scored.filter((s) => !s.junk).sort(byValueThenSlug);
  const junk = scored.filter((s) => s.junk).sort(byValueThenSlug);
  // Junk rows sit below the whole real board. Scale every junk value by one
  // shared factor so the largest junk value lands at half the real board's
  // smallest value: the ordering then holds by construction, whatever the
  // raw model said about a wrapped or exchange product's TVL.
  const realValues = real.map((s) => Math.max(1, Math.round(s.rawValue)));
  const junkFit = realValues.length > 0 && junk.length > 0
    ? Math.min(1, (0.5 * Math.min(...realValues)) / Math.max(...junk.map((s) => s.rawValue)))
    : 1;
  const ordered: { s: Scored; value: number }[] = [];
  real.forEach((s, i) => ordered.push({ s, value: realValues[i] }));
  for (const s of junk) ordered.push({ s, value: Math.max(1, Math.round(s.rawValue * junkFit)) });

  const rows = ordered.map((o, i) => ({
    slug: o.s.p.slug,
    name: o.s.p.name,
    rank: i + 1,
    implied_value_usd: o.value,
    farm_steps: farmSteps(o.s.p, o.s.junk),
    category: o.s.p.category,
    chains: o.s.p.chains,
    tvl_usd: o.s.p.tvl_usd,
    change_7d: o.s.p.change_7d,
    implied_fdv_usd: Math.round(o.s.fdv),
    launch_probability: Math.round(o.s.prob * 1000) / 1000,
    peer_multiple: Math.round(o.s.multiple * 1000) / 1000,
    global_multiple: Math.round(o.s.fundMultiple * 1000) / 1000,
    watchlist: watch.has(o.s.p.slug),
    launch_candidate: !o.s.junk,
  }));

  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'board.json'), JSON.stringify({ rows }, null, 2) + '\n');

  // Dashboard: copy the hand-written page, then generate its data beside it.
  const dashOut = join(outDir, 'dashboard');
  copyDir(join(repoDir, 'dashboard'), dashOut);
  const catIndex = new Map<string, number>();
  const catNames: string[] = [];
  for (const r of rows) {
    const cat = r.category ?? 'Uncategorised';
    if (!catIndex.has(cat)) { catIndex.set(cat, catNames.length); catNames.push(cat); }
  }
  const round3 = (x: number) => Math.round(x * 1000) / 1000;
  const dataRows = ordered.map((o, i) => [
    o.s.p.slug,
    o.s.p.name,
    i + 1,
    catIndex.get(o.s.p.category ?? 'Uncategorised'),
    o.s.p.chains.join(','),
    o.s.p.tvl_usd,
    o.s.p.change_7d === null ? null : Math.round(o.s.p.change_7d * 10) / 10,
    Math.round(o.s.fdv),
    Math.round(o.s.prob * 100),
    ordered[i].value,
    watch.has(o.s.p.slug) ? 1 : 0,
    o.s.days === null ? -1 : o.s.days,
    o.s.junk ? 1 : 0,
    round3(o.s.multiple),
    round3(o.s.fundMultiple),
    round3(o.s.momF),
    round3(o.s.ageF),
    round3(o.s.sizeF),
  ]);
  const multTable = catNames.map((cat, idx) => {
    const st = cal.stats.get(cat);
    return [idx, st ? round3(st.representativeMultiple) : round3(cal.globalMultiple), st ? st.tokenisedPeers : 0, st ? Math.round(st.tokenisationRate * 100) : 0];
  });
  const data = {
    asOf: snap.as_of,
    floorUsd: snap.floor_usd,
    scanned: snap.protocols.length,
    preToken: scored.length,
    globalMult: round3(globalMultipleValue),
    cats: catNames,
    mult: multTable,
    rows: dataRows,
  };
  writeFileSync(join(dashOut, 'data.js'), 'window.RADAR=' + JSON.stringify(data) + ';\n');

  copyDir(join(repoDir, 'screenshots'), join(outDir, 'screenshots'));

  const dossier = buildDossier(outDir, { text_max_bytes: 65536 });
  writeFileSync(join(outDir, 'dossier.json'), dossier);
}

main();
