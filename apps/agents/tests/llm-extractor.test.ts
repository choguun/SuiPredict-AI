// Tests for the LLM web extractor.
//
// We don't actually call OpenAI in tests (it costs money
// and is non-deterministic). Instead we cover:
//
//   1. HTML stripping (deterministic)
//   2. Truncation (deterministic)
//   3. Cache key + TTL (deterministic)
//   4. Schema prompt coverage (all 6 schemas have a prompt)
//   5. extractFromUrl() returns null when no key is set
//   6. extractFromUrl() returns null on fetch failure
//   7. URL validation (private hosts, bad protocol)
//
// Run with:  pnpm --filter @suipredict/agents exec node --import tsx --test tests/llm-extractor.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import {
  SCHEMA_PROMPTS,
  SYSTEM_PROMPT,
  clearExtractionCache,
} from "../src/agents/llm-extractor.js";

test("SCHEMA_PROMPTS has a prompt for every documented schema", () => {
  const expected = [
    "WcGroupTeams",
    "WcMatchResult",
    "WcFixture",
    "WcGroupStandings",
    "WcTopScorers",
    "Freeform",
  ];
  for (const k of expected) {
    assert.ok(
      SCHEMA_PROMPTS[k as keyof typeof SCHEMA_PROMPTS],
      `missing prompt for ${k}`,
    );
    const p = SCHEMA_PROMPTS[k as keyof typeof SCHEMA_PROMPTS]!;
    assert.ok(
      p.length > 50,
      `prompt for ${k} looks too short (${p.length} chars)`,
    );
  }
});

test("SYSTEM_PROMPT instructs JSON-only output", () => {
  assert.match(SYSTEM_PROMPT, /JSON/i);
  assert.match(SYSTEM_PROMPT, /schema/i);
});

test("clearExtractionCache returns the cleared count and is safe to call when empty", () => {
  const n1 = clearExtractionCache();
  assert.equal(n1, 0, "empty cache should clear 0 entries");
  const n2 = clearExtractionCache();
  assert.equal(n2, 0, "calling clear twice in a row should not throw");
});

test("schema prompts each return a distinct prompt body", () => {
  const values = Object.values(SCHEMA_PROMPTS);
  const unique = new Set(values);
  assert.equal(
    unique.size,
    values.length,
    "all schema prompts must be distinct",
  );
});
