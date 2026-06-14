import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Liquidity Vault",
  description:
    "Deposit DUSDC into the autonomous liquidity vault. Earn pro-rata yield from the AI market-making agents quoting bid/ask spreads on DeepBook V3.",
};

export default function VaultLayout({ children }: { children: React.ReactNode }) {
  return children;
}
