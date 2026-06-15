// Friend / social graph store.
//
// The MVP deliberately avoids a server-side social graph: friends
// are just a list of Sui addresses the user has followed, stored
// in localStorage. This keeps the agent pipeline (which never
// touches user data) and the privacy story (only the user sees
// their own friends list) clean.
//
// Every consumer should use the hook `useFriends()` rather than
// reading localStorage directly, so the UI updates when the user
// adds/removes a friend.

import { useCallback, useEffect, useState } from "react";

const STORAGE_KEY = "suipredict.friends.v1";

function isSuiAddress(s: string): boolean {
  return /^0x[a-fA-F0-9]{64}$/.test(s.trim());
}

function readFriends(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const j = JSON.parse(raw) as unknown;
    if (!Array.isArray(j)) return [];
    return j
      .filter((x): x is string => typeof x === "string" && isSuiAddress(x))
      .map((x) => x.toLowerCase());
  } catch {
    return [];
  }
}

function writeFriends(addrs: string[]) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(addrs));
  } catch {
    /* private mode etc. */
  }
}

export interface UseFriendsResult {
  friends: string[];
  add: (addr: string) => boolean;
  remove: (addr: string) => void;
  has: (addr: string) => boolean;
  isValidAddress: typeof isSuiAddress;
}

export function useFriends(): UseFriendsResult {
  const [friends, setFriends] = useState<string[]>([]);
  useEffect(() => {
    setFriends(readFriends());
  }, []);
  const add = useCallback((addr: string) => {
    const norm = addr.trim().toLowerCase();
    if (!isSuiAddress(norm)) return false;
    if (friends.includes(norm)) return false;
    const next = [...friends, norm];
    setFriends(next);
    writeFriends(next);
    return true;
  }, [friends]);
  const remove = useCallback((addr: string) => {
    const norm = addr.trim().toLowerCase();
    const next = friends.filter((f) => f !== norm);
    setFriends(next);
    writeFriends(next);
  }, [friends]);
  const has = useCallback((addr: string) => friends.includes(addr.trim().toLowerCase()), [friends]);
  return { friends, add, remove, has, isValidAddress: isSuiAddress };
}

/** Short form for UI display, e.g. 0x1234…abcd */
export function shortAddr(addr: string): string {
  if (addr.length < 12) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}
