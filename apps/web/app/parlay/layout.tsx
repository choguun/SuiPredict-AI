import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Parlay Builder",
  description:
    "Combine multiple YES/NO predictions into a single parlay for a multiplied payout. Lock 1 DUSDC, hit all legs, claim the multiplied prize.",
};

export default function ParlayLayout({ children }: { children: React.ReactNode }) {
  return children;
}
