import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Settings",
  description:
    "Configure your agent policy: create or revoke agent wallets, set DUSDC budget caps, pause agents, and register your forecaster profile.",
};

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  return children;
}
