# World Cup 2026 — Autonomous Agents

The MVP is the 2026 FIFA World Cup (June 11 – July 19, 2026, USA/Canada/Mexico,
48 teams, 12 groups, 104 matches). The agents fleet is specialized for
sports markets: market creation, market making, and resolution all run
fully autonomously against public web sources.

## New agents

| Agent | Cadence | Role |
|-------|---------|------|
| `world-cup-creator` | `*/15 * * * *` | Drops binary "Will X beat Y?" markets for upcoming group matches |
| `world-cup-resolver` | `*/5 * * * *` | Scrapes Wikipedia per-group pages for completed match results → on-chain `resolve_market` |
| `world-cup-maker` | `*/2 * * * *` | Quotes bid/ask on WC markets with Elo-based mid-prices and time-decaying spread |

## Data flow

```
                          ┌──────────────────────┐
                          │  Wikipedia (en)      │
                          │  2026 FIFA WC Group  │
                          │  A-L pages           │
                          └──────────┬───────────┘
                                     │ JSON-API
                                     ▼
                          ┌──────────────────────┐
                          │ world-cup-fetcher.ts │
                          │  - 12 groups, 48     │
                          │    teams (hardcoded  │
                          │    + 6h Wiki re-     │
                          │    validation)       │
                          │  - 72 match schedule │
                          │  - match results     │
                          └──────────┬───────────┘
                                     │
                ┌────────────────────┼─────────────────────┐
                ▼                    ▼                     ▼
       ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐
       │ WC creator       │  │ WC resolver      │  │ WC market maker  │
       │ next 7d matches  │  │ expired markets  │  │ Elo-based mid    │
       │ → on-chain       │  │ → Wikipedia      │  │ → time-decay     │
       │   create_market  │  │   score →        │  │   spread →       │
       │   (500 DEEP)     │  │   resolve_market │  │   place_order    │
       └────────┬─────────┘  └────────┬─────────┘  └────────┬─────────┘
                │                     │                     │
                ▼                     ▼                     ▼
       ┌──────────────────────────────────────────────────────────────┐
       │ Sui Blockchain · prediction_market + DeepBook V3            │
       │ YES/DBUSDC permissionless pool per match                     │
       └──────────────────────────────────────────────────────────────┘
                │
                ▼
       ┌──────────────────────────────────────────────────────────────┐
       │ SQLite mirror (markets.db) → /wc/groups, /wc/schedule, …    │
       └──────────────────────────────────────────────────────────────┘
                │
                ▼
       ┌──────────────────────────────────────────────────────────────┐
       │ Web UI · /worldcup, /worldcup/group/[letter], /markets      │
       │ + Friends widget, LivePulse, Celebration                     │
       └──────────────────────────────────────────────────────────────┘
```

## Configuration

| Env var | Default | Purpose |
|---------|---------|---------|
| `AGENT_CRON_WC_CREATOR` | `*/15 * * * *` | WC creator cadence |
| `AGENT_CRON_WC_RESOLVER` | `*/5 * * * *` | WC resolver cadence |
| `AGENT_CRON_WC_MAKER` | `*/2 * * * *` | WC maker cadence |
| `MAX_ACTIVE_WC_MARKETS` | `20` | Cap on simultaneous WC markets |
| `WC_RESOLVER_CONFIDENCE` | `85` | LLM-gate threshold (off — we use Wikipedia) |
| `WC_MM_QUOTE_SIZE` | `5_000_000` | 5 YES shares per side |
| `WC_MM_MAX_MARKETS` | `8` | Quote on up to 8 upcoming matches per tick |

## REST surface

All read-only:

| Route | Returns |
|-------|---------|
| `GET /wc/groups` | `{ groups: WcGroup[] }` (12 groups, 48 teams) |
| `GET /wc/schedule?since=ms&until=ms` | `{ matches: WcMatch[] }` (72 group matches) |
| `GET /wc/upcoming?windowMs=ms` | `{ upcoming: [{ id, title, kickoffIn }] }` |

## Elo model

`world-cup-maker.ts` uses a hardcoded Elo per team (sourced from the
FIFA World Ranking of November 2025, the basis for the December 5,
2025 draw). The conversion to "probability of home win" follows the
standard logistic with a draw adjustment:

```
P(home)   = 1 / (1 + 10^((E_away - E_home) / 400))
P(draw)   = max(0.05, 0.22 - 0.6 * closeness)
closeness = 1 - 2 * |P(home) - 0.5|
P(yes)    = (P(home) - P(draw) / 2) / (1 - P(draw))
```

The spread tightens as kickoff approaches:
- T-7d: 600 bps
- T-1d: 250 bps
- T-1h: 150 bps
- T-0m: 75 bps

## Failure modes

| Failure | Behavior |
|---------|----------|
| Wikipedia is rate-limited | Fetcher falls back to hardcoded draw (tested). |
| Wikipedia is down | Same as above. |
| DEEP coin < 500 | Skip pool creation; fall back to demo market in SQLite. |
| Match result not yet reported | Resolver skips and retries next tick (5min cadence). |
| Multi-source conflict | N/A — we trust Wikipedia; future v2 can add ESPN/BBC corroboration. |
| Network outage during tx | Standard Sui retry via SDK's `executeTransaction` (3x exponential backoff). |
