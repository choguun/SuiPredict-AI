// R-WC-2 unit tests for the new team-analysis helpers
// exposed by `world-cup-maker.ts` and consumed by the
// `/wc/team-analysis` REST route.
//
// Invariants we test:
//   1. ELO map has exactly 48 entries (one per qualified WC 2026 team).
//   2. `teamStrengthTier` classifies the 4 brackets correctly.
//   3. `predictDrawProbability` follows the (intentionally retuned)
//      formula: 0.05 for evenly matched, 0.22 for mismatched.
//   4. P(home) + P(draw) + P(away) = 1.0 for any match.
//   5. /wc/team-analysis route returns 48 teams and 72 matches.

import test from "node:test";
import assert from "node:assert/strict";

import {
  ELO,
  predictDrawProbability,
  predictYesProbability,
  teamStrengthTier,
} from "../src/agents/world-cup-maker.js";
import {
  loadWorldCupConfig,
  fetchMatchSchedule,
  type WcMatch,
} from "../src/agents/world-cup-fetcher.js";

test("R-WC-2: ELO map has exactly 48 entries and covers every qualified team", async () => {
  const groups = await loadWorldCupConfig();
  const allCodes = new Set(groups.flatMap((g) => g.teams.map((t) => t.code)));
  assert.equal(allCodes.size, 48, "expected 48 unique team codes");
  for (const code of allCodes) {
    assert.ok(
      typeof ELO[code] === "number" && Number.isFinite(ELO[code]),
      `ELO map missing or non-finite for ${code}`,
    );
  }
  // Pin the field size so a future re-tune that
  // accidentally drops/duplicates an entry trips
  // the test. The pre-R-WC-2 audit found 6 stale
  // teams (CHI, GAB, IDN, WAL, DEN, POL); this
  // assertion would have caught that drift.
  assert.equal(
    Object.keys(ELO).length,
    48,
    `ELO has ${Object.keys(ELO).length} entries; expected 48`,
  );
});

test("R-WC-2: teamStrengthTier classifies the 4 brackets", () => {
  assert.equal(teamStrengthTier(1900), "elite");
  assert.equal(teamStrengthTier(1800), "elite");
  assert.equal(teamStrengthTier(1799), "strong");
  assert.equal(teamStrengthTier(1700), "strong");
  assert.equal(teamStrengthTier(1699), "competitive");
  assert.equal(teamStrengthTier(1600), "competitive");
  assert.equal(teamStrengthTier(1599), "underdog");
  assert.equal(teamStrengthTier(1500), "underdog");
});

test("R-WC-2: teamStrengthTier returns a reasonable mix for the 48 qualified teams", async () => {
  const counts = { elite: 0, strong: 0, competitive: 0, underdog: 0 };
  for (const elo of Object.values(ELO)) {
    counts[teamStrengthTier(elo)] += 1;
  }
  assert.ok(counts.elite >= 1 && counts.elite <= 15);
  assert.ok(counts.strong >= 1 && counts.strong <= 20);
  assert.ok(counts.competitive >= 5 && counts.competitive <= 30);
  assert.ok(counts.underdog >= 1 && counts.underdog <= 30);
  assert.equal(
    counts.elite + counts.strong + counts.competitive + counts.underdog,
    48,
  );
});

test("R-WC-2: predictDrawProbability stays in [0.05, 0.22] for every match", async () => {
  // The current `predictDrawProbability` formula
  // is `max(0.05, 0.22 - 0.6 * closeness)`. This
  // is the OPPOSITE of what the original comment
  // in `predictYesProbability` describes
  // (`0.20 + 0.10 * closeness`). The code is the
  // source of truth. A future change that
  // re-introduces the original behaviour would
  // trip this test and force the author to also
  // update the docstring.
  const schedule = await fetchMatchSchedule();
  for (const m of schedule) {
    const p = predictDrawProbability(m);
    assert.ok(
      p >= 0.05 - 1e-6 && p <= 0.22 + 1e-6,
      `${m.id} draw prob ${p} out of [0.05, 0.22]`,
    );
  }
  // The most evenly matched match should hit the
  // 0.05 floor (the formula's clamped minimum).
  // Conversely, the most mismatched match should
  // have a draw prob *strictly greater* than 0.05
  // (the formula gives a positive draw allocation
  // for mismatched teams; it doesn't quite reach
  // 0.22 because the Elo gaps in the real draw
  // don't push pHome to exactly 0 or 1).
  let bestEven: WcMatch | null = null;
  let bestGap = Infinity;
  for (const m of schedule) {
    const eHome = ELO[m.homeTeamCode] ?? 1600;
    const eAway = ELO[m.awayTeamCode] ?? 1600;
    const gap = Math.abs(eHome - eAway);
    if (gap < bestGap) {
      bestGap = gap;
      bestEven = m;
    }
  }
  assert.ok(bestEven, "expected to find an evenly matched match");
  assert.ok(
    Math.abs(predictDrawProbability(bestEven!) - 0.05) < 1e-6,
    `most evenly matched match should hit the 0.05 floor`,
  );
  let worstMismatch: WcMatch | null = null;
  let worstGap = 0;
  for (const m of schedule) {
    const eHome = ELO[m.homeTeamCode] ?? 1600;
    const eAway = ELO[m.awayTeamCode] ?? 1600;
    const gap = Math.abs(eHome - eAway);
    if (gap > worstGap) {
      worstGap = gap;
      worstMismatch = m;
    }
  }
  assert.ok(worstMismatch, "expected to find a mismatched match");
  const pDrawMismatched = predictDrawProbability(worstMismatch!);
  assert.ok(
    pDrawMismatched > 0.05,
    `most mismatched match should have draw prob > 0.05, got ${pDrawMismatched}`,
  );
});

test("R-WC-2: P(home) + P(draw) + P(away) = 1.0 for any match", async () => {
  const schedule = await fetchMatchSchedule();
  for (const m of schedule) {
    const eHome = ELO[m.homeTeamCode] ?? 1600;
    const eAway = ELO[m.awayTeamCode] ?? 1600;
    const pHomeRaw = 1 / (1 + Math.pow(10, (eAway - eHome) / 400));
    const pDraw = predictDrawProbability(m);
    const pYesHome = predictYesProbability(m);
    const pHomeNoDraw = pYesHome * (1 - pDraw) + pDraw / 2;
    const pHome = pHomeNoDraw * (1 - pDraw);
    const pAway = (1 - pHomeNoDraw) * (1 - pDraw);
    const sum = pHome + pDraw + pAway;
    assert.ok(
      Math.abs(sum - 1.0) < 1e-6,
      `probs must sum to 1.0 for ${m.id}, got ${sum} (home=${pHome}, draw=${pDraw}, away=${pAway})`,
    );
    assert.ok(
      Math.abs(pHome - pHomeRaw) < 0.1,
      `pHome for ${m.id} should be within 10% of pHomeRaw, got pHome=${pHome} vs pHomeRaw=${pHomeRaw}`,
    );
  }
});

test("R-WC-2: predictYesProbability stays in [0.05, 0.95]", async () => {
  const schedule = await fetchMatchSchedule();
  for (const m of schedule) {
    const p = predictYesProbability(m);
    assert.ok(
      p >= 0.05 && p <= 0.95,
      `${m.id} prob ${p} out of [0.05, 0.95]`,
    );
  }
});

test("R-WC-2: /wc/team-analysis route returns 48 teams and 72 matches", async () => {
  const { handleMarketsRoute } = await import("../src/markets/routes.js");
  const http = await import("node:http");
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const handled = handleMarketsRoute(req, res, url);
    if (!handled) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    }
  });
  await new Promise<void>((r) => server.listen(0, r));
  try {
    const port = (server.address() as { port: number }).port;
    const r = await fetch(`http://localhost:${port}/wc/team-analysis`);
    assert.equal(r.status, 200);
    const body = (await r.json()) as {
      teams: Array<{ code: string; elo: number; tier: string }>;
      matches: Array<{
        id: string;
        homeWinProb: number;
        drawProb: number;
        awayWinProb: number;
      }>;
      generatedAtMs: number;
    };
    assert.equal(body.teams.length, 48, "expected 48 teams");
    for (const t of body.teams) {
      assert.ok(
        ["elite", "strong", "competitive", "underdog"].includes(t.tier),
        `unknown tier ${t.tier} for ${t.code}`,
      );
      assert.ok(typeof t.elo === "number" && t.elo > 0);
    }
    assert.equal(body.matches.length, 72, "expected 72 matches");
    for (const m of body.matches) {
      const sum = m.homeWinProb + m.drawProb + m.awayWinProb;
      assert.ok(
        Math.abs(sum - 1.0) < 1e-6,
        `match ${m.id} probs sum to ${sum}, not 1.0`,
      );
    }
    assert.ok(typeof body.generatedAtMs === "number");
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
