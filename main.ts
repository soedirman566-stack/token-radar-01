// Token Launch Radar v2 — peer-calibrated implied-value model.
//
// Reads the sealed DefiLlama snapshot, ranks every protocol that records no
// token by the implied value of a future launch, and writes board.json, the
// dashboard (with a generated data.js), the screenshots and dossier.json.
//
// The category FDV/TVL multiples are not hardcoded: they are calibrated from
// the snapshot itself, as the median market-cap/TVL ratio of the tokenised
// protocols in each category. Implied value per protocol is
//   TVL x category multiple x momentum x age x size decay   (implied FDV)
//   x 7.5% assumed airdrop share x launch probability p.
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

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

interface CategoryStats {
  multiple: number;
  tokenisedPeers: number;
  tokenisationRate: number;
}

// Calibrate one FDV/TVL multiple per category from the snapshot's own
// tokenised protocols; thin categories fall back to the global median.
let globalMedianMultiple = 1;
function calibrate(protocols: Proto[]): Map<string, CategoryStats> {
  const allRatios: number[] = [];
  const byCat = new Map<string, { ratios: number[]; total: number; tokenised: number }>();
  for (const p of protocols) {
    const cat = p.category ?? 'Uncategorised';
    let e = byCat.get(cat);
    if (!e) { e = { ratios: [], total: 0, tokenised: 0 }; byCat.set(cat, e); }
    e.total += 1;
    if (hasToken(p)) e.tokenised += 1;
    if (p.mcap_usd !== null && p.tvl_usd > 0) {
      e.ratios.push(p.mcap_usd / p.tvl_usd);
      allRatios.push(p.mcap_usd / p.tvl_usd);
    }
  }
  const globalMedian = allRatios.length > 0 ? median(allRatios) : 1;
  globalMedianMultiple = globalMedian;
  const out = new Map<string, CategoryStats>();
  for (const [cat, e] of byCat) {
    out.set(cat, {
      multiple: e.ratios.length >= 3 ? median(e.ratios) : globalMedian,
      tokenisedPeers: e.ratios.length,
      tokenisationRate: e.total > 0 ? e.tokenised / e.total : 0,
    });
  }
  return out;
}

function momentumFactor(change7d: number | null): number {
  if (change7d === null) return 1;
  const c = clamp(change7d, -50, 100);
  return c >= 0 ? 1 + 0.003 * c : 1 + 0.006 * c; // -50 -> 0.70, +100 -> 1.30
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

function launchProbability(tvl: number, days: number | null, change7d: number | null, tokenisationRate: number): number {
  let p = tvl >= 1e9 ? 0.55
    : tvl >= 5e8 ? 0.50
    : tvl >= 1e8 ? 0.44
    : tvl >= 5e7 ? 0.38
    : tvl >= 2e7 ? 0.32
    : tvl >= 1e7 ? 0.27
    : 0.22;
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
  momF: number;
  ageF: number;
  sizeF: number;
  days: number | null;
  prob: number;
  fdv: number;
  rawValue: number;
}

function scoreAll(snap: Snapshot, stats: Map<string, CategoryStats>): Scored[] {
  const out: Scored[] = [];
  for (const p of snap.protocols) {
    if (hasToken(p)) continue; // the radar ranks only protocols still to launch
    const st = stats.get(p.category ?? 'Uncategorised');
    const multiple = st ? st.multiple : 1;
    const tokRate = st ? st.tokenisationRate : 0;
    const days = ageInDays(p.listed_at, snap.as_of);
    const momF = momentumFactor(p.change_7d);
    const ageF = ageFactor(days);
    const sizeF = sizeFactor(p.tvl_usd);
    const fdv = p.tvl_usd * multiple * momF * ageF * sizeF;
    const prob = launchProbability(p.tvl_usd, days, p.change_7d, tokRate);
    out.push({
      p, junk: isJunk(p), multiple, momF, ageF, sizeF, days, prob, fdv,
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
  const stats = calibrate(snap.protocols);
  const scored = scoreAll(snap, stats);

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
  ]);
  const multTable = catNames.map((cat, idx) => {
    const st = stats.get(cat);
    return [idx, st ? Math.round(st.multiple * 1000) / 1000 : 1, st ? st.tokenisedPeers : 0, st ? Math.round(st.tokenisationRate * 100) : 0];
  });
  const data = {
    asOf: snap.as_of,
    floorUsd: snap.floor_usd,
    scanned: snap.protocols.length,
    preToken: scored.length,
    globalMult: Math.round(globalMedianMultiple * 1000) / 1000,
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
