[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/soedirman566-stack/token-radar-01/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/soedirman566-stack/token-radar-01/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

# Token Launch Radar v3

A radar for protocols that record no token yet. It reads the sealed DefiLlama
snapshot (758 protocols), scores every one of the 342 that record no token,
and ranks them by the implied value of a future launch — with a concrete,
costed farm plan for each. All 40 watchlist protocols are covered, and the
radar also ranks the pre-token protocols below the watchlist floor that the
list leaves out.

## The model

No hardcoded names and no hardcoded multiples. Peer multiples are
**calibrated from the snapshot itself**, with three defences v2 lacked
(v2 priced a $1.56B protocol at 0.6% of its TVL because its category had
exactly three tokenised peers with a median mcap/TVL of 0.0059):

- **Winsorised ratios**: every tokenised protocol's market-cap / TVL ratio
  is clamped to the snapshot's own 5th–95th percentile band before use.
- **Size-banded weighted median**: a protocol's peer multiple is the
  weighted median of its category's winsorised peer ratios — peers within
  8× of its own TVL count fully, peers outside the band count 0.35 — then
  **shrunk toward the snapshot-wide multiple** with a prior of 6 effective
  peers and clamped to [0.05, 40]. Only 144 of the snapshot's 758 protocols
  carry a usable ratio, so thin categories are the norm, not the exception.
- **Ensemble FDV**: implied FDV is a geometric blend, 65% the peer model
  and 35% a fundamentals-only model (TVL × snapshot-wide multiple ×
  momentum × age, no category term), so a thin or missing category degrades
  to a sane anchor instead of to noise.

Then, per protocol:

- **Peer FDV** = TVL × peer multiple × momentum (7-day TVL change, clamped
  to −40…+60, worth ×0.80–×1.15) × age (tokenless-and-large is worth up to
  ×1.25 at five years) × a size decay for very large TVL.
- **P(launch)** is a smooth logistic in log TVL centred on $100M (v2
  stepped through six tiers), adjusted for the tokenless age, the
  category's tokenisation rate, the sign of momentum and chain breadth —
  the snapshot carries no volume series, so the number of chains a protocol
  is deployed on is the liquidity-access proxy — clamped to 5–85%.
- **Implied value** (the rank key) = ensemble implied FDV × **7.5% assumed
  airdrop share** × P(launch), in whole dollars.

Wrapped, staked and bridged products, versioned copies and exchanges' own
products record no token either, but they are not launch candidates: they are
flagged in the data, given "farm the parent instead" plans, scaled so they
always sit below the real board, and badged NOT A CANDIDATE in the dashboard.

## The dashboard

A hand-written static page (no framework, no network): a sortable board with
text search and chain / category / watchlist-only filters, watchlist rows
badged, a per-protocol detail view with the full model breakdown and farm
plan, and a "How the ranking works" section that prints the calibrated
multiples table the model actually used. The detail view's factor strip is
shipped per row by the program itself, so the breakdown always agrees with
the board it wrote. Screenshots are renders of this dashboard running the
submitted model. Farm plans come from per-category
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
