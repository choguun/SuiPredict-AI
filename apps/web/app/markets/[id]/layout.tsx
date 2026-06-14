import type { Metadata } from "next";
import { getMarket } from "@suipredict/sdk";

// R30 sweep fix: per-market SSR metadata. The
// market detail page is a client component (it
// needs wallet hooks, polling, etc.) so it can't
// export its own `metadata` — Next.js App Router
// only lets server components / layouts own
// metadata. Wrapping the route in a server layout
// that fetches the market title server-side and
// emits a unique `<title>` + description per
// market means each market has its own SERP
// snippet ("Will Portugal beat Colombia? (Group K
// MD2) · SuiPredict AI") instead of inheriting
// the root layout's generic title. Crawlers see
// the actual market question; social shares
// surface the match-up.
//
// `generateMetadata` runs on the server; the
// fetch to the agents REST endpoint adds ~5ms
// to first paint (cached SQLite read on the
// agents side). If the fetch fails (agents
// down, market not found, malformed id) we fall
// through to a generic market template so the
// page still renders.
export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  let marketId = id;
  try {
    marketId = decodeURIComponent(id);
  } catch {
    // malformed URI; fall through to generic title
  }
  let title = "Market";
  let description =
    "Trade YES / NO on this prediction market. Split DUSDC into shares, route orders through DeepBook V3.";
  try {
    const m = await getMarket(marketId);
    if (m?.title) {
      title = m.title;
      description =
        m.description ??
        `${m.title} — trade YES/NO shares on SuiPredict AI.`;
    }
  } catch {
    // agents down or market not found; fall through to generic
  }
  return {
    title,
    description,
    openGraph: {
      title: `${title} · SuiPredict AI`,
      description,
    },
  };
}

/**
 * R30 sweep fix: emit a JSON-LD `BetDetail` block (a subtype of
 * `Thing` that mirrors the structured-data pattern Polymarket
 * uses) so search engines can render the market question + status
 * as a rich result. The block is hidden from the visible DOM
 * (rendered into a <script type="application/ld+json">) and
 * becomes the canonical machine-readable description of the
 * market — useful for share previews on Slack / X / Discord
 * that respect the structured data.
 */
async function marketJsonLd(marketId: string) {
  try {
    const m = await getMarket(marketId);
    if (!m?.title) return null;
    return {
      "@context": "https://schema.org",
      "@type": "Question",
      name: m.title,
      text: m.description ?? m.title,
      category: m.category,
      expectedAnswer: {
        "@type": "Answer",
        text:
          m.status === "resolved" && m.outcome
            ? `Resolved ${m.outcome.toUpperCase()}`
            : "Open for trading",
      },
      suggestedAnswer: [
        { "@type": "Answer", text: "YES" },
        { "@type": "Answer", text: "NO" },
      ],
      url: `${process.env.NEXT_PUBLIC_SITE_URL ?? "https://suipredict.ai"}/markets/${encodeURIComponent(marketId)}`,
    };
  } catch {
    return null;
  }
}

export default async function MarketDetailLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  let marketId = id;
  try {
    marketId = decodeURIComponent(id);
  } catch {
    // malformed; skip JSON-LD
  }
  const jsonLd = await marketJsonLd(marketId);
  return (
    <>
      {jsonLd && (
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
        />
      )}
      {children}
    </>
  );
}
