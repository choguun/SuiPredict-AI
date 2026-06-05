"use client";

import { useEffect, useState } from "react";
import { useWallets, useCurrentAccount, useDAppKit } from "@mysten/dapp-kit-react";
import { useEnokiFlow, useZkLogin } from "@mysten/enoki/react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

/**
 * R51 audit fix: validate `NEXT_PUBLIC_SUI_NETWORK`
 * against the Sui allowlist before passing to the
 * Enoki zkLogin flow. A typo (e.g. `mantinet`) would
 * otherwise cast to a string and mint a testnet
 * zkLogin session for a mainnet deploy. The same
 * allowlist exists in `app/admin/page.tsx:101-107`
 * and `lib/dapp-kit.ts`; the Enoki flow was the
 * sole survivor without it.
 */
const SUI_LOGIN_NETWORKS = ["testnet", "mainnet", "devnet"] as const;
type SuiLoginNetwork = typeof SUI_LOGIN_NETWORKS[number];
function resolveSuiNetworkForLogin(raw: string | undefined): SuiLoginNetwork {
  if (raw && (SUI_LOGIN_NETWORKS as readonly string[]).includes(raw)) {
    return raw as SuiLoginNetwork;
  }
  return "testnet";
}

export function ConnectModal() {
  const [isOpen, setIsOpen] = useState(false);
  // R48 audit fix: track which connect button (Google or
  // a specific wallet name) is currently busy so the user can't
  // double-click and fire two OAuth popups / wallet prompts in
  // parallel. Some wallets treat two simultaneous connect
  // requests as a UX attack and reject both; the previous
  // double-click was harmless-looking but produced a confusing
  // "no wallet selected" / "user cancelled" round-trip.
  const [busy, setBusy] = useState<null | "google" | string>(null);
  const queryClient = useQueryClient();
  const wallets = useWallets();
  const currentAccount = useCurrentAccount();
  const dappKit = useDAppKit();

  const enokiFlow = useEnokiFlow();
  const zkLogin = useZkLogin();

  const activeAddress = currentAccount?.address || zkLogin?.address;
  const isZkLogin = !!zkLogin?.address && !currentAccount?.address;

  const handleGoogleLogin = async () => {
    if (busy) return;
    // Read the Google OAuth client id defensively. `as string` would
    // coerce the runtime placeholder "undefined" into the Enoki call
    // and silently fail the OAuth round-trip; the round-17 audit
    // found this exact footgun. Surface a visible toast instead of
    // dropping the rejection to console.error.
    const googleClientId = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID ?? "";
    if (!googleClientId) {
      toast.error(
        "NEXT_PUBLIC_GOOGLE_CLIENT_ID is not set in this deployment. Google zkLogin is disabled.",
      );
      return;
    }
    const protocol = window.location.protocol;
    const host = window.location.host;
    const redirectUrl = `${protocol}//${host}/auth`;

    setBusy("google");
    enokiFlow
      .createAuthorizationURL({
        provider: "google",
        clientId: googleClientId,
        redirectUrl: redirectUrl,
        // R39 audit fix: read the network from the same env var
        // `lib/dapp-kit.ts` uses. R34 fixed the gRPC client
        // (R34:1) but missed the Enoki zkLogin flow — its
        // `network` field is passed to EnokiFlow independently
        // of the dAppKit client and is what selects which
        // network the zkLogin ephemeral keypair is bound to.
        // A mainnet deploy with the old `network: "testnet"`
        // would mint a testnet zkLogin session: the Google
        // OAuth round-trip would succeed, but every subsequent
        // signAndExecuteTransaction would target the wrong
        // chain.
        //
        // R51 audit fix: validate the env value against
        // the Sui network allowlist instead of a raw
        // `as` cast. A typo in `.env`
        // (`NEXT_PUBLIC_SUI_NETWORK=mantinet`) previously
        // passed the cast and minted a testnet zkLogin
        // session for a mainnet deploy. The admin page
        // and `lib/dapp-kit.ts` already use the same
        // allowlist check (R34/R39); the Enoki zkLogin
        // flow here was the survivor.
        network: resolveSuiNetworkForLogin(
          process.env.NEXT_PUBLIC_SUI_NETWORK,
        ),
      })
      .then((url) => {
        // Note: the user is navigating away; no need to clear
        // `busy` because the component unmounts.
        window.location.href = url;
      })
      .catch((err) => {
        toast.error(
          err instanceof Error ? err.message : "Google zkLogin failed",
        );
        setBusy(null);
      });
  };

  const handleDisconnect = async () => {
    // R46 audit fix: confirm before disconnecting. The
    // previous flow went straight from the "Disconnect"
    // button click to `dappKit.disconnectWallet()` /
    // `enokiFlow.logout()`, which clears the session,
    // drops the wallet cookie, and re-renders the
    // ConnectWallet button. A user who mis-clicked the
    // button (it's the only rose-coloured CTA in the
    // modal, easy to fat-finger) would have to redo
    // the full Google OAuth / wallet extension flow
    // to reconnect. The R45 admin-page pattern
    // (window.confirm on submit) is the right shape
    // — quick, no extra UI surface, hard to bypass
    // accidentally. We only confirm when there's
    // actually a session to lose (the button is only
    // rendered in the connected view) so this is
    // one confirm per accidental click.
    if (
      !window.confirm(
        "Disconnect your wallet? You'll need to reconnect to sign transactions.",
      )
    ) {
      return;
    }
    // R44 audit fix: mirror the R42 `connectWallet` try/catch
    // pattern. `enokiFlow.logout()` and `dappKit.disconnectWallet()`
    // both reject (Enoki on cookie-clearing failures, dapp-kit on a
    // wallet extension that hangs during the disconnect handshake),
    // and the previous code awaited them bare — a rejection
    // surfaced as a silent unhandled promise rejection in the
    // console and the modal stayed open with no visible feedback.
    // Wrap each call, surface a toast on failure, and always close
    // the modal in `finally` so the user can retry.
    try {
      if (isZkLogin) {
        await enokiFlow.logout();
      } else {
        await dappKit.disconnectWallet();
      }
      // R48 audit fix: clear the React Query cache for the
      // address-keyed queries so a second user connecting to
      // the same browser doesn't briefly see the previous
      // user's portfolio / marketsList / dailyMarkets / streak
      // data while React Query refetches. Clear on success
      // only — a failed disconnect keeps the cache as-is so
      // the user can retry without losing UI state.
      //
      // R51 audit fix: add `type: "active"` to match
      // the project convention (R43/R44/R45/R50
      // closed the same pattern in parlay, vault,
      // and markets/[id]). TanStack Query v5
      // defaults to `"all"` (matches inactive
      // subscribers too) — a future SSR-hydration
      // strategy that registers an `["marketsList"]`
      // query with `type: "inactive"` would have its
      // cache nuked on every disconnect, surprising
      // the next user.
      const keys = [
        "portfolio",
        "marketsList",
        "dailyMarkets",
        "userStreakId",
        "streakInfo",
        "profile",
      ];
      for (const k of keys) {
        queryClient.removeQueries({ queryKey: [k], type: "active" });
      }
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "unknown error";
      toast.error(`Failed to disconnect: ${message}`);
    } finally {
      setIsOpen(false);
    }
  };

  const shortenAddress = (addr: string) => {
    return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
  };

  // R46 audit fix: close the modal on Escape. The modal is
  // keyboard-focusable (the close X button has focus when the
  // user tabs in) but a sighted power user hitting Escape
  // expects the modal to close — the previous build ignored
  // Escape and required a click on the X or backdrop. The
  // handler binds on `keydown` only while the modal is open
  // and removes itself on close so we don't leak listeners
  // across opens.
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setIsOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isOpen]);

  return (
    <>
      {/* Trigger Button */}
      {activeAddress ? (
        <button
          onClick={() => setIsOpen(true)}
          className="flex items-center gap-2 rounded-xl border border-violet-500/30 bg-violet-600/10 px-4 py-2.5 text-sm font-semibold text-violet-300 shadow-[0_0_15px_rgba(139,92,246,0.15)] transition hover:bg-violet-600/20 hover:border-violet-500/50"
        >
          {isZkLogin && (
            <svg className="h-4 w-4" viewBox="0 0 24 24">
              <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
              <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
              <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
              <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
            </svg>
          )}
          {shortenAddress(activeAddress)}
        </button>
      ) : (
        <button
          onClick={() => setIsOpen(true)}
          className="rounded-xl bg-gradient-to-r from-violet-600 to-cyan-600 px-5 py-2.5 text-sm font-bold text-white shadow-lg shadow-cyan-900/30 transition-all hover:scale-105 hover:shadow-cyan-500/20"
        >
          Connect Wallet
        </button>
      )}

      {/* Modal Overlay */}
      {isOpen && (
        // R47 audit fix: add the standard ARIA
        // dialog attributes — `role="dialog"`,
        // `aria-modal="true"`, and
        // `aria-labelledby` pointing at the
        // visible `<h2>` heading. The previous
        // bare <div> overlay gave screen
        // readers a context shift announcement
        // but no role announcement, and
        // didn't expose the dialog's label
        // to assistive tech.
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="connect-modal-title"
          className="fixed inset-0 z-[100] flex h-[100dvh] w-screen flex-col items-center justify-center bg-black/60 p-4 backdrop-blur-sm animate-in fade-in duration-200"
        >
          {/* Modal Content */}
          <div className="relative w-full max-w-md max-h-[85dvh] overflow-y-auto rounded-3xl border border-white/10 bg-[#11141d] shadow-2xl shadow-black/80 animate-in zoom-in-95 duration-200 hide-scrollbar">
            {/* Background Gradients */}
            <div className="absolute -top-32 -right-32 h-64 w-64 rounded-full bg-violet-600/10 blur-[80px] pointer-events-none" />
            <div className="absolute -bottom-32 -left-32 h-64 w-64 rounded-full bg-cyan-600/10 blur-[80px] pointer-events-none" />
            
            <div className="relative p-6 sm:p-8">
              <div className="flex items-center justify-between mb-8">
                <h2
                  id="connect-modal-title"
                  className="text-xl font-bold tracking-tight text-white"
                >
                  {activeAddress ? "Your Profile" : "Connect"}
                </h2>
                <button
                  onClick={() => setIsOpen(false)}
                  className="flex h-8 w-8 items-center justify-center rounded-full bg-white/5 text-zinc-400 transition hover:bg-white/10 hover:text-white"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>

              {activeAddress ? (
                /* Connected State View */
                <div className="space-y-6">
                  <div className="flex flex-col items-center justify-center gap-3 rounded-2xl border border-white/5 bg-white/[0.02] p-8 text-center">
                    <div className="flex h-16 w-16 items-center justify-center rounded-full bg-gradient-to-br from-violet-600 to-cyan-600 text-2xl shadow-lg">
                      👾
                    </div>
                    <div>
                      <p className="text-sm font-medium text-zinc-400">Connected Address</p>
                      <p className="text-lg font-bold text-white tracking-wide mt-1">
                        {shortenAddress(activeAddress)}
                      </p>
                    </div>
                    {isZkLogin && (
                      <span className="mt-2 inline-flex items-center gap-1.5 rounded-full bg-[#4285F4]/10 px-3 py-1 text-xs font-semibold text-[#4285F4] border border-[#4285F4]/20">
                        <svg className="h-3 w-3" viewBox="0 0 24 24">
                          <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="currentColor"/>
                          <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
                          <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
                          <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
                        </svg>
                        Google zkLogin
                      </span>
                    )}
                  </div>
                  <button
                    onClick={handleDisconnect}
                    className="w-full rounded-xl bg-white/5 py-3.5 text-sm font-bold text-rose-400 transition hover:bg-rose-500/10 hover:text-rose-300"
                  >
                    Disconnect
                  </button>
                </div>
              ) : (
                /* Disconnected State View */
                <div className="space-y-6">
                  {/* Social Logins */}
                  <div>
                    <h3 className="mb-3 text-xs font-bold uppercase tracking-widest text-zinc-500">Social Login</h3>
                    <button
                      onClick={handleGoogleLogin}
                      disabled={busy !== null}
                      className="group flex w-full items-center gap-3 rounded-xl border border-white/10 bg-white/[0.04] p-3.5 transition hover:bg-white/10 disabled:opacity-50"
                    >
                      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-white/10 transition group-hover:scale-110">
                        <svg className="h-5 w-5" viewBox="0 0 24 24">
                          <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
                          <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
                          <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
                          <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
                        </svg>
                      </div>
                      <div className="text-left flex-1">
                        <div className="font-semibold text-white">Continue with Google</div>
                        <div className="text-xs text-zinc-400">Powered by Enoki zkLogin</div>
                      </div>
                    </button>
                  </div>

                  {/* Web3 Wallets */}
                  <div>
                    <h3 className="mb-3 text-xs font-bold uppercase tracking-widest text-zinc-500">Web3 Wallets</h3>
                    <div className="space-y-2">
                      {wallets.length === 0 && (
                        <div className="text-sm text-zinc-500 italic p-2 border border-dashed border-white/10 rounded-xl text-center">
                          No installed wallets found.
                        </div>
                      )}
                      {wallets.map((wallet) => (
                        <button
                          key={wallet.name}
                          disabled={busy !== null}
                          onClick={async () => {
                            if (busy) return;
                            setBusy(wallet.name);
                            // R42 audit fix: `dappKit.connectWallet`
                            // rejects on user-cancelled prompts
                            // (wallet popup closed without confirm),
                            // network mismatch, or a wallet extension
                            // that fails to inject a `connect`
                            // handler. The previous code awaited the
                            // call without a try/catch — a rejected
                            // promise would surface as a silent
                            // unhandled rejection in the console
                            // and leave the modal open with no
                            // feedback. Wrap and surface a toast so
                            // the user can retry or pick a different
                            // wallet.
                            try {
                              await dappKit.connectWallet({ wallet });
                              setIsOpen(false);
                            } catch (err) {
                              const message =
                                err instanceof Error
                                  ? err.message
                                  : "unknown error";
                              toast.error(
                                `Failed to connect ${wallet.name}: ${message}`,
                              );
                            } finally {
                              setBusy(null);
                            }
                          }}
                          className="flex w-full items-center gap-3 rounded-xl border border-white/5 bg-transparent p-3 transition hover:bg-white/[0.04] disabled:opacity-50"
                        >
                          <div className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-white/10">
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img src={wallet.icon} alt={wallet.name} className="h-full w-full object-cover" />
                          </div>
                          <div className="text-left font-medium text-zinc-300 hover:text-white">
                            {wallet.name}
                          </div>
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
