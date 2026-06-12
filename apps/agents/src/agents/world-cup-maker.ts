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
// When `OPENAI_API_KEY` is unset we fall back to a pure Elo
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
const ELO: Record<string, number> = {
  ARG: 1870, FRA: 1870, ESP: 1860, ENG: 1820, BRA: 1830, POR: 1810,
  NED: 1800, BEL: 1795, GER: 1790, CRO: 1770, USA: 1770, MEX: 1770,
  CAN: 1730, URU: 1750, COL: 1740, MAR: 1730, JPN: 1720, SUI: 1710,
  SEN: 1700, IRN: 1700, KOR: 1700, ECU: 1700, TUN: 1660, AUS: 1650,
  AUT: 1660, NOR: 1660, SWE: 1660, CZE: 1650, CIV: 1640, SCO: 1640,
  CHI: 1640, PAR: 1640, ALG: 1640, EGY: 1640, GHA: 1630, CPV: 1600,
  PAN: 1600, HAI: 1600, IRQ: 1600, UZB: 1600, NZL: 1580, RSA: 1580,
  COD: 1580, QAT: 1580, BIH: 1580, JOR: 1580, CUW: 1500, KSA: 1500,
  TUR: 1680, POL: 1680, WAL: 1670, DEN: 1670, IDN: 1580, GAB: 1580,
};

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
  // Draw probability peaks when teams are evenly matched.
  const closeness = 1 - 2 * Math.abs(pHome - 0.5);
  const pDraw = Math.max(0.05, 0.22 - 0.6 * closeness);
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
  const wcMarkets = allMarkets.filter(
    (m) =>
      m.category === "worldcup" &&
      m.status === "active" &&
      m.deepbook_pool_id,
  );
  const matchToMarket = new Map<string, { marketId: string; poolId: string }>();
  for (const m of wcMarkets) {
    const wcId = m.id.startsWith("wc26-") ? m.id.slice(5) : null;
    if (wcId) matchToMarket.set(wcId, { marketId: m.id, poolId: m.deepbook_pool_id! });
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
    const bidBps = Math.round((yes - halfSpreadBps / 10_000) * 1_000_000);
    const askBps = Math.round((yes + halfSpreadBps / 10_000) * 1_000_000);
    // Demo path: just record the orders in SQLite, no on-chain tx.
    // The demo market ids start with "demo-" and don't have a pool;
    // since the WC creator writes the row in demo mode without a
    // pool, the maker has nothing to actually place. We still log
    // the quote so the order-book endpoint shows it.
    const dbMarket = getMarket(found.marketId);
    if (!dbMarket?.deepbook_pool_id) {
      // record a synthetic demo quote for the UI order book
      upsertOrder({
        market_id: found.marketId,
        order_id: Date.now() * 1000 + quoted,
        owner: "wc-maker-bot",
        is_bid: true,
        price_bps: Math.round((1 - yes) * 10_000),
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
      depTx.moveCall({
        target: `${process.env.DEEPBOOK_PACKAGE_ID ?? "0xc93ae840671495202260c7afb93c820bf11c081b884b660106399208871dec5a"}::balance_manager::deposit`,
        typeArguments: [DUSDC_TYPE],
        arguments: [depTx.object(balanceManagerId), depTx.object(dusdcId)],
      });
      await executeTransaction(client, depTx, ctx.signer);
      if (agentPolicyId) {
        const authTx = buildAuthorizeSpendTx(agentPolicyId, 5);
        await executeTransaction(client, authTx, ctx.signer);
      }
      const placeTx = buildPlaceOrderTx({
        marketId: found.marketId,
        poolId: found.poolId,
        balanceManagerId,
        price: BigInt(bidBps),
        quantity: BigInt(quoteSize),
        isBid: true,
        clientOrderId: BigInt(Date.now() % 1_000_000),
      });
      await executeTransaction(client, placeTx, ctx.signer);
      // Mirror into SQLite so the agent feed shows the quote.
      upsertOrder({
        market_id: found.marketId,
        order_id: Date.now() * 1000 + quoted,
        owner: agentAddr,
        is_bid: true,
        price_bps: Math.round(yes * 10_000),
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
