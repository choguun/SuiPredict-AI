"use client";

import { useEffect, useState } from "react";

/**
 * Small banner that appears when the browser is offline.
 * Surfaces "You're offline — data may be stale" so a user
 * staring at a stuck "Loading..." state knows the cause is
 * their connection, not the agents service. The banner
 * auto-dismisses when connectivity returns. Mirrors the
 * bottom-nav fixed positioning (z-50 just below modal
 * overlays) and respects the mobile-bottom-nav safe area
 * (it sits above the bottom nav so it never overlaps).
 */
export function OfflineBanner() {
  const [online, setOnline] = useState(true);

  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);

  if (online) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed inset-x-0 bottom-16 z-[70] mx-auto mb-2 flex w-fit items-center gap-2 rounded-full border border-amber-500/40 bg-amber-500/95 px-4 py-2 text-xs font-bold text-amber-950 shadow-lg shadow-amber-900/30 md:bottom-4"
    >
      <span
        aria-hidden="true"
        className="inline-block h-2 w-2 animate-pulse rounded-full bg-amber-900"
      />
      You&apos;re offline — data may be stale.
    </div>
  );
}
