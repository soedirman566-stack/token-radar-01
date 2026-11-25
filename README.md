[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/soedirman566-stack/token-radar-01/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/soedirman566-stack/token-radar-01/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

# Token Launch Radar v2

A radar for protocols that record no token yet. It reads the sealed DefiLlama
snapshot (758 protocols), scores every one of the 342 that record no token,
and ranks them by the implied value of a future launch — with a concrete,
costed farm plan for each. All 40 watchlist protocols are covered, and the
radar also ranks the pre-token protocols below the watchlist floor that the
list leaves out.

## The model

No hardcoded names and no hardcoded multiples. Each category's FDV/TVL
multiple is **calibrated from the snapshot itself**: the median market-cap /
TVL ratio of that category's already-tokenised protocols (categories with
fewer than 3 tokenised peers fall back to the global median). Then, per
protocol:

- **Implied FDV** = TVL × category multiple × momentum (7-day TVL change,
  clamped to −50…+100, worth ×0.70–×1.30) × age (tokenless-and-large is worth
  up to ×1.25 at five years) × a size decay for very large TVL.
- **P(launch)** blends the TVL tier, the tokenless age, the category's
  tokenisation rate (share of its protocols that already have tokens) and the
  sign of momentum, clamped to 5–85%.
- **Implied value** (the rank key) = implied FDV × **7.5% assumed airdrop
  share** × P(launch), in whole dollars.

Wrapped, staked and bridged products, versioned copies and exchanges' own
products record no token either, but they are not launch candidates: they are
flagged in the data, given "farm the parent instead" plans, scaled so they
always sit below the real board, and badged NOT A CANDIDATE in the dashboard.

## The dashboard

A hand-written static page (no framework, no network): a sortable board with
text search and chain / category / watchlist-only filters, watchlist rows
badged, a per-protocol detail view with the full model breakdown and farm
plan, and a "How the ranking works" section that prints the calibrated
multiples table the model actually used. Farm plans come from per-category
playbooks parameterised with each protocol's name, chains and TVL tier: every
step names a concrete action with a dollar cost estimate and a time or
cadence, including a points-tracking step and a one-wallet anti-sybil step.

## Run it

```
node main.ts --input <path-to-snapshot.json> --output <output-dir>
```

With no arguments it reads `/input/snapshot.json` and writes `/output`
(`MAKEFUN_OUTPUT_DIR` also names the output directory). Node 22.18+, standard
library only. It writes `board.json`, `dashboard/` (page plus a generated
`data.js`), `screenshots/` and `dossier.json` (built with the scorer's own
`vendor/makefun-board.ts`). Two runs write the same bytes.
