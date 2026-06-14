import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Friends",
  description:
    "Follow Sui addresses and see their open YES/NO positions across every SuiPredict AI prediction market. Private social graph stored locally.",
};

export default function FriendsLayout({ children }: { children: React.ReactNode }) {
  return children;
}
