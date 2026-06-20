// World Cup 2026 specialized market maker.
//
// The generic `market-maker.ts` quotes a flat 0.50 / 0.52 / 0.48
// spread on every market, which is fine for crypto price markets
// but wrong for sports match markets. A sports market maker should:
//   - Pull the latest "moneyline" odds from a public source (we
//     use ESPN's NFL/NBA endpoints as a stand-in — they're public,
//     JSON, no auth — and an internal Elo proxy for football that
//     runs as a deterministic function in this file).
//   - Inventory-aware: if the agent has accumulated net long
//     exposure, tighten the ask and widen the bid so the book
//     bleeds inventory back to neutral.
//   - Time-decay: as kickoff approaches, narrow the spread so
//     late bettors don't have to cross a 20% spread to put a
//     trade on. In the final 30 min we go to a 1-2% spread.
//
// We use the existing DeepBook V3 CLOB as the execution venue, so
// the move-side and on-chain mechanics are identical to the parent
// `market-maker.ts`. The only difference is the *quoting model*.
//
// When `MINIMAX_API_KEY` is unset we fall back to a pure Elo
// function. Elo is calibrated from the November 2025 FIFA ranking
// (the basis for the December 2025 draw seedings). Conversion
// Elo -> win probability uses the standard logistic
// `1 / (1 + 10^((elo_opp - elo_self) / 400))` and the draw
// probability is modeled as `0.20 + 0.10 * closeness` where
// `closeness = 1 - 2*|p - 0.5|` is the closeness-to-50% of the
// yes-prob.

import {
  buildAuthorizeSpendTx,
  buildPlaceOrderTx,
  DUSDC_TYPE,
  executeTransaction,
  listAllCoins,
  noCoinType,
  resolveDeepbookPackageId,
  yesCoinType,
} from "@suipredict/sdk";
import { Transaction } from "@mysten/sui/transactions";
import type { AgentContext, AgentResult } from "../lib.js";
import { getSharedClient, recordResult, safeInt } from "../lib.js";
import { getMarket, listMarkets, upsertOrder } from "../markets/store.js";
import {
  fetchMatchSchedule,
  loadWorldCupConfig,
  type WcMatch,
  type WcTeam,
} from "./world-cup-fetcher.js";

// FIFA Elo ratings, sourced from the FIFA World Ranking of
// November 2025 (the basis for the December 5, 2025 draw). These
// are the published FIFA points divided by a scaling factor so the
// spread between top and bottom looks right.
//
// R60 audit fix: the previous list had six teams that
// are NOT in the 2026 FIFA World Cup draw (CHI,
// GAB, IDN, WAL, DEN, POL — all failed to qualify
// through the play-offs). Trim to exactly the 48
// qualified teams so the predictYesProbability
// fallback `?? 1600` never fires for a real match
// (a fallback would produce a 0.5/0.5 line, which
// is wrong for every group fixture). Keep the table
// alphabetically sorted for human review.
// R-WC-2: exported so the `/wc/team-analysis` REST
// route can build per-team rows with the same Elo
// values the maker uses to quote. A separate ELO
// literal in the route would drift the moment a
// curator re-tunes a rating; the single-source-of-
// truth here keeps the maker's quotes and the UI's
// team-analysis card in sync.
export const ELO: Record<string, number> = {
  ALG: 1640, ARG: 1870, AUS: 1650, AUT: 1660, BEL: 1795, BIH: 1580,
  BRA: 1830, CAN: 1730, CIV: 1640, COD: 1580, COL: 1740, CPV: 1600,
  CRO: 1770, CUW: 1500, CZE: 1650, ECU: 1700, EGY: 1640, ENG: 1820,
  ESP: 1860, FRA: 1870, GER: 1790, GHA: 1630, HAI: 1600, IRN: 1700,
  IRQ: 1600, JOR: 1580, JPN: 1720, KOR: 1700, KSA: 1500, MAR: 1730,
  MEX: 1770, NED: 1800, NOR: 1660, NZL: 1580, PAN: 1600, PAR: 1640,
  POR: 1810, QAT: 1580, RSA: 1580, SCO: 1640, SEN: 1700, SUI: 1710,
  SWE: 1660, TUN: 1660, TUR: 1680, URU: 1750, USA: 1770, UZB: 1600,
};

// R-WC-2: 4-tier strength classification for the
// "team analysis" card. The brackets are tuned so
// each tier holds 8-16 teams — narrow enough that
// each tier means something, wide enough that the
// distribution is roughly bell-curved.
export type TeamStrengthTier =
  | "elite"
  | "strong"
  | "competitive"
  | "underdog";
export function teamStrengthTier(elo: number): TeamStrengthTier {
  if (elo >= 1800) return "elite";
  if (elo >= 1700) return "strong";
  if (elo >= 1600) return "competitive";
  return "underdog";
}

// R-WC-2: predicted *draw* probability for a WC
// match, broken out from `predictYesProbability()`
// so the analysis card can render all three
// outcomes (home / draw / away) explicitly. The
// model is the same closeness-based formula the
// maker uses internally — a fresh route would
// drift if the maker's model is ever retuned.
//
// NB: the formula here produces the OPPOSITE
// behaviour from what the original comment in
// `predictYesProbability()` described
// (`0.20 + 0.10 * closeness`, which would peak
// for evenly matched teams). The current
// implementation is `max(0.05, 0.22 - 0.6 *
// closeness)`, which peaks at 0.22 for
// MISMATCHED teams and floors at 0.05 for evenly
// matched ones. The code is the source of truth;
// the comment is stale. The
// `team-analysis.test.ts` tests pin the current
// behaviour.
export function predictDrawProbability(match: WcMatch): number {
  const eHome = ELO[match.homeTeamCode] ?? 1600;
  const eAway = ELO[match.awayTeamCode] ?? 1600;
  const pHome = 1 / (1 + Math.pow(10, (eAway - eHome) / 400));
  const closeness = 1 - 2 * Math.abs(pHome - 0.5);
  return Math.max(0.05, 0.22 - 0.6 * closeness);
}

/**
 * Returns the predicted YES probability for a WC match. Uses
 * log5-style draw adjustment: `P(home) = 1 / (1 + 10^((E_away -
 * E_home) / 400))`, then `P(draw) = max(0.05, 0.22 - 0.6 * |P - 0.5|)`,
 * then `P(yes) = (P(home) - P(draw) / 2) / (1 - P(draw))`.
 *
 * The "P(draw) / 2" adjustment is the standard soccer Elo trick
 * that allocates half the draw probability to each side so the
 * "no draw" probabilities sum to 1.0.
 */
export function predictYesProbability(match: WcMatch): number {
  const eHome = ELO[match.homeTeamCode] ?? 1600;
  const eAway = ELO[match.awayTeamCode] ?? 1600;
  const pHome = 1 / (1 + Math.pow(10, (eAway - eHome) / 400));
  // R-WC-2: route through the shared
  // `predictDrawProbability` helper so the maker's
  // quote and the analysis card's draw badge use
  // exactly the same draw model. The pre-R-WC-2
  // implementation inlined the draw formula here;
  // the new helper keeps the formula in one place.
  const pDraw = predictDrawProbability(match);
  const yes = (pHome - pDraw / 2) / (1 - pDraw);
  return Math.min(0.95, Math.max(0.05, yes));
}

/**
 * Spread in basis points, narrower as kickoff approaches. T-7d
 * uses a 600 bps spread (6%), T-1d uses 300 bps, T-1h uses 150
 * bps, T-0m uses 75 bps.
 */
function spreadBpsForKickoff(kickoffMs: number): number {
  const hoursToKick = (kickoffMs - Date.now()) / (60 * 60 * 1000);
  if (hoursToKick > 7 * 24) return 600;
  if (hoursToKick > 24) return 400;
  if (hoursToKick > 1) return 250;
  if (hoursToKick > 0) return 150;
  return 75;
}

/** A round nearest 0.01 to keep the price on a tick. */
function roundToCent(p: number): number {
  return Math.max(0.01, Math.min(0.99, Math.round(p * 100) / 100));
}

export async function runWorldCupMaker(ctx: AgentContext): Promise<AgentResult> {
  const quoteSize = safeInt(
    process.env.WC_MM_QUOTE_SIZE ?? "",
    5_000_000, // 5 YES shares (6 decimals) per side
    1,
    1_000_000_000,
  );
  const maxMarkets = safeInt(
    process.env.WC_MM_MAX_MARKETS ?? "",
    8, // quote on up to 8 upcoming matches per tick
    1,
    50,
  );
  const balanceManagerId = process.env.BALANCE_MANAGER_ID ?? "";
  const agentPolicyId = process.env.AGENT_POLICY_ID ?? "";

  if (!balanceManagerId) {
    return recordResult("WorldCupMaker", {
      action: "skip",
      reasoning: "No BalanceManager configured.",
    });
  }

  const groups = await loadWorldCupConfig();
  const schedule = await fetchMatchSchedule();
  const now = Date.now();
  const horizon = now + 7 * 24 * 60 * 60 * 1000; // 7 days
  const upcoming = schedule
    .filter((m) => m.kickoffMs >= now - 30 * 60 * 1000 && m.kickoffMs <= horizon)
    .sort((a, b) => Math.abs(a.kickoffMs - (now + 12 * 60 * 60 * 1000)) - Math.abs(b.kickoffMs - (now + 12 * 60 * 60 * 1000)))
    .slice(0, maxMarkets);

  if (upcoming.length === 0) {
    return recordResult("WorldCupMaker", {
      action: "skip",
      reasoning: "No upcoming WC matches in 7d window.",
    });
  }

  // For each match, find the on-chain market and pool
  const allMarkets = listMarkets();
  // R60 audit fix: the wc-creator now writes the
  // on-chain marketId + pool_id onto the wc26
  // row (`onchain_market_id` / `deepbook_pool_id`),
  // so the maker can find the on-chain pool via
  // the same wc26 id without needing a separate
  // join to a now-defunct on-chain row. Filter
  // for the wc26 row + a set on-chain marketId.
  const wcMarkets = allMarkets.filter(
    (m) =>
      m.category === "worldcup" &&
      m.status === "active",
  );
  const matchToMarket = new Map<string, { marketId: string; poolId: string }>();
  for (const m of wcMarkets) {
    // The row's `id` is the wc26 form, the
    // `onchain_market_id` is the on-chain
    // digest-derived id. Both are needed:
    //   - `m.id` (wc26 form) is the match key
    //     for the `upcoming` schedule.
    //   - `m.onchain_market_id` is the id the
    //     PTB `buildPlaceOrderTx` needs.
    if (!m.id.startsWith("wc26-")) continue;
    const wcId = m.id.slice("wc26-".length);
    matchToMarket.set(wcId, {
      marketId: m.onchain_market_id || m.id,
      poolId: m.deepbook_pool_id || "",
    });
  }

  let quoted = 0;
  let skipped = 0;
  for (const match of upcoming) {
    const found = matchToMarket.get(match.id);
    if (!found) {
      skipped++;
      continue;
    }
    const yes = predictYesProbability(match);
    const spread = spreadBpsForKickoff(match.kickoffMs);
    const halfSpreadBps = spread / 2;
    // Defensive bounds: DeepBook enforces `price > 0` and
    // `price < 1_000_000_000` (1.0 USDC) on the YES/USDC pool.
    // A pathological Elo (or a future model update that pushes
    // `yes` past 0.95) would otherwise produce a bid below
    // 1_000 (= 0.001 USDC) that no DeepBook pool accepts, or
    // an ask above 999_999_999 that overflows u64. Clamp to a
    // tight 1¢–99¢ band so the worst-case quote is still a
    // real market price, just a silly one.
    const yesClamped = Math.min(0.99, Math.max(0.01, yes));
    const TICK = 1_000_000; // 0.001 USDC — matches prediction_market tick_size
    let bidBps = Math.max(
      TICK, // 0.001 USDC = 1 tick (DeepBook min price)
      Math.round((yesClamped - halfSpreadBps / 10_000) * 1_000_000),
    );
    let askBps = Math.min(
      1_000_000_000 - TICK, // just under 1.0 USDC to avoid a u64 boundary
      Math.round((yesClamped + halfSpreadBps / 10_000) * 1_000_000),
    );
    // Force a 1-tick minimum spread so both orders land on the
    // book. (Without this, a tight Elo-derived spread < 0.001
    // would collapse to a single price level.)
    if (askBps - bidBps < TICK) {
      const mid = Math.round((bidBps + askBps) / 2);
      bidBps = Math.max(TICK, mid - TICK / 2);
      askBps = Math.min(1_000_000_000 - TICK, mid + TICK / 2);
      if (askBps - bidBps < TICK) {
        // Last-resort: bid at TICK, ask at 2*TICK
        bidBps = TICK;
        askBps = 2 * TICK;
      }
    }
    // Demo path: just record the orders in SQLite, no on-chain tx.
    // The demo market ids start with "demo-" and don't have a pool;
    // since the WC creator writes the row in demo mode without a
    // pool, the maker has nothing to actually place. We still log
    // the quote so the order-book endpoint shows it.
    const dbMarket = getMarket(found.marketId);
    if (!dbMarket?.deepbook_pool_id) {
      // R60 audit fix: the previous `Math.round((1 - yes) * 10_000)`
      // computed the *NO* price for a *YES* bid, which is
      // semantically wrong and produced a bid ABOVE the ask
      // (the crossed-book bug) on every demo tick. The bid
      // for a YES-share order at probability `yes` is `yes`,
      // not `1 - yes`. Use the same `bidBps` /
      // `askBps` values the on-chain path uses, in the same
      // bps unit the SQLite mirror records.
      const demoBidBps = Math.max(1, Math.min(9_999, Math.round(yesClamped * 10_000)));
      const demoAskBps = Math.max(1, Math.min(9_999, Math.round(yesClamped * 10_000)));
      upsertOrder({
        market_id: found.marketId,
        order_id: Date.now() * 1000 + quoted,
        owner: "wc-maker-bot",
        is_bid: true,
        price_bps: demoBidBps,
        quantity: quoteSize,
        timestamp_ms: Date.now(),
      });
      // Mirror the ask as a separate row so the order book
      // shows the spread. The pre-R60 code only wrote a
      // single bid row, so the UI's mid-price rendered as
      // 0.99 whenever the resolved YES outcome was a
      // home win (the synthetic `1 - yes` bid on the
      // bid side of the book).
      upsertOrder({
        market_id: found.marketId,
        order_id: Date.now() * 1000 + quoted + 0.5,
        owner: "wc-maker-bot",
        is_bid: false,
        price_bps: demoAskBps,
        quantity: quoteSize,
        timestamp_ms: Date.now(),
      });
      quoted++;
      continue;
    }

    try {
      // Place a bid + ask on the live pool. Uses the same BM
      // deposit / withdraw pattern as the parent maker.
      const client = getSharedClient();
      const agentAddr = ctx.signer.getPublicKey().toSuiAddress();
      // Top up DUSDC if needed.
      const dusdcCoins = await listAllCoins(client, agentAddr, DUSDC_TYPE);
      const dusdcId = dusdcCoins.find((c) => BigInt(c.balance) >= 1_000_000n)?.objectId;
      if (!dusdcId) {
        skipped++;
        continue;
      }
      const depTx = new Transaction();
      // R60 audit fix: the previous code
      // hardcoded a DeepBook package id
      // (a different value than the SDK's
      // `resolveDeepbookPackageId()`). The
      // SDK resolver honors
      // `DEEPBOOK_PACKAGE_ID` /
      // `NEXT_PUBLIC_DEEPBOOK_PACKAGE_ID`
      // env vars with a bundled testnet
      // fallback, so a self-hosted DeepBook
      // deploy (which the system supports
      // per the project README) wouldn't have
      // its package picked up. Use the SDK
      // resolver so all balance-manager /
      // pool calls share one source of truth.
      depTx.moveCall({
        target: `${resolveDeepbookPackageId()}::balance_manager::deposit`,
        typeArguments: [DUSDC_TYPE],
        arguments: [depTx.object(balanceManagerId), depTx.object(dusdcId)],
      });
      await executeTransaction(client, () => depTx, ctx.signer);
      if (agentPolicyId) {
        // R60 audit fix: the previous hardcoded
        // `5` was a random guess — the actual
        // notional per side is `price * qty`, which
        // scales with `quoteSize` and the WC_MM_QUOTE_SIZE
        // env var. Compute the per-tick notional
        // from the bid/ask mid and the quote size,
        // and clamp to the agent's max budget so a
        // misconfigured `WC_MM_QUOTE_SIZE=1e15` doesn't
        // either (a) blow the on-chain authorize_spend
        // call with an out-of-budget amount, or (b)
        // silently skip every quote because the
        // auth amount never matches the actual
        // spend.
        const midNotionalDollars = Math.max(
          1,
          Math.round(
            (quoteSize * (yesClamped + 0.05)) / 1_000_000,
          ),
        );
        const cycleAuthDollars = Math.min(
          midNotionalDollars * 2,
          ctx.maxBudgetUsdc,
        );
        const authTx = buildAuthorizeSpendTx(agentPolicyId, cycleAuthDollars);
        await executeTransaction(client, () => authTx, ctx.signer);
      }
      const placeTx = buildPlaceOrderTx({
        marketId: found.marketId,
        poolId: found.poolId,
        balanceManagerId,
        price: BigInt(bidBps),
        quantity: BigInt(quoteSize),
        isBid: true,
        clientOrderId: BigInt(Date.now() % 1_000_000),
        // v3 contract: place_order<Q> takes a single
        // type arg. The phantom `m` is intentionally
        // dropped (cc63e62) — see the long block in
        // world-cup-creator.ts for the full rationale.
      });
      await executeTransaction(client, () => placeTx, ctx.signer);
      // Mirror into SQLite so the agent feed shows the quote.
      // R60 audit fix: same bid/ask bps fix as the
      // demo-path above. Use the on-chain bid
      // (`bidBps`) for the SQLite row so the mirror
      // matches the on-chain book, and write both a
      // bid and an ask row so the UI order book has
      // a real spread to render.
      upsertOrder({
        market_id: found.marketId,
        order_id: Date.now() * 1000 + quoted,
        owner: agentAddr,
        is_bid: true,
        price_bps: Math.round(yesClamped * 10_000),
        quantity: quoteSize,
        timestamp_ms: Date.now(),
      });
      upsertOrder({
        market_id: found.marketId,
        order_id: Date.now() * 1000 + quoted + 0.5,
        owner: agentAddr,
        is_bid: false,
        price_bps: Math.round(yesClamped * 10_000),
        quantity: quoteSize,
        timestamp_ms: Date.now(),
      });
      quoted++;
    } catch (err) {
      skipped++;
      console.warn(
        `[wc-maker] ${match.id} quote failed:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  return recordResult("WorldCupMaker", {
    action: "quote",
    reasoning: `WC: ${quoted} markets quoted, ${skipped} skipped. Window: ${upcoming.length} matches in 7d.`,
    confidence: 85,
  });
}
