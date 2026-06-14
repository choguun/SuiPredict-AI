import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Admin",
  description:
    "Operator panel for SuiPredict AI: withdraw protocol fees, configure weekly prize distribution, resolve disputed markets, create admin markets.",
  robots: { index: false, follow: false },
};

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return children;
}
