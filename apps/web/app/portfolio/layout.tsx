import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Portfolio",
  description:
    "Your YES/NO share balances across every active SuiPredict AI prediction market. Redeem winning shares for DUSDC once a market resolves.",
};

export default function PortfolioLayout({ children }: { children: React.ReactNode }) {
  return children;
}
