"use client";

/**
 * Floating "back to top" button. Renders a fixed-position
 * arrow-up pill in the bottom-right corner of the viewport
 * once the user has scrolled past ~400px. The button
 * scrolls smoothly back to the top on click and is hidden
 * when the user is already near the top. Renders nothing
 * on initial mount (matches the SSR/CSR "mount before
 * read" pattern the rest of the app uses) so the first
 * paint doesn't briefly flash a button on the home page.
 *
 * R30 sweep fix: long pages (markets list with 50+ cards,
 * /agents with the full decision feed, /worldcup/group
 * with all 6 fixtures) had no way to jump back to the
 * top short of manually scrolling. The button only
 * appears after the user has invested some scroll
 * distance, so the home page hero / first card still
 * breathes.
 *
 * R30 sweep fix: z-30 (one below the bottom nav's z-50)
 * so the button never overlaps the primary nav on
 * mobile. Bottom padding is also bumped to clear the
 * mobile bottom nav (which is `pb-16`).
 */
import { useEffect, useState } from "react";

export function BackToTop() {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const onScroll = () => {
      // 400px is roughly the height of the home-page hero +
      // stats row; surfacing the button past that point keeps
      // the first viewport clean while still being useful for
      // anyone who's made it partway down a long page.
      setVisible(window.scrollY > 400);
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  if (!visible) return null;

  return (
    <button
      type="button"
      onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
      aria-label="Back to top"
      className="fixed bottom-20 right-4 z-30 inline-flex h-10 w-10 items-center justify-center rounded-full border border-white/10 bg-panel-strong/90 text-zinc-300 shadow-lg shadow-black/40 backdrop-blur-md transition hover:border-emerald-500/30 hover:bg-panel-strong hover:text-emerald-300 md:bottom-6"
    >
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      >
        <path strokeLinecap="round" strokeLinejoin="round" d="M5 15l7-7 7 7" />
      </svg>
    </button>
  );
}
