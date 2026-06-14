import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "AI Agents",
  description:
    "Live view of the 15 autonomous AI agents that create, market-make, and resolve every SuiPredict prediction market. Crons, decisions, drift detector.",
};

export default function AgentsLayout({ children }: { children: React.ReactNode }) {
  return children;
}
