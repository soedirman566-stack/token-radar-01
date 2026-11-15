# Token Radar — token-radar-01 (make.fun)

A program that reads a sealed DefiLlama snapshot and ranks every pre-token
protocol by the implied value of the token it may one day issue, with a farm
plan for each one. Built after the competition opened (2026-11-14T10:00:00Z).

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json>
```

Node 22, standard library only. Reads `/input/snapshot.json` by default and
writes `/output/board.json`, `/output/data.js`, `/output/dashboard/`,
`/output/screenshots/` and `/output/dossier.json`.

## The model (radar-2)

`implied FDV = TVL x peer multiple x momentum x size decay x age x junk discount`,
`implied value = round(implied FDV x 7.5% x p(launch))`.

- **Peer multiple**: the median market-cap/TVL of the tokenized protocols in the
  same category, shrunk toward the global median for small categories, clamped
  to 0.08–1.50. Computed from the snapshot at run time — no hardcoded names.
- **Momentum**: 7-day TVL change, clamped to −50…+100%.
- **Age**: time since first listing with no token; longer without a token reads
  as more overdue.
- **p(launch)**: 0.02–0.85 from TVL tier, the category's tokenization rate, age
  and momentum sign.
- **Separation**: exchanges, bridges, wrapped/staked products and versioned
  pools are scored the same way but set aside below the board, never ranked;
  protocols whose token already trades are shown apart with their market cap.

See `lib/model.ts` for the full documented model and `dashboard/app.js` for
the page's recomputation of every row.

## Layout

- `main.ts` — entrypoint: snapshot in, board + dashboard data + dossier out.
- `lib/model.ts` — the model, the farm plans, the snapshot parser.
- `dashboard/` — the static dashboard (index.html, app.css, app.js); no network.
- `screenshots/` — board, detail view, filtered view (1440x900).
- `vendor/makefun-board.ts` — the kit's dossier library, byte for byte.
- `.makefun/owner.json` — the entry's claim wallet.
