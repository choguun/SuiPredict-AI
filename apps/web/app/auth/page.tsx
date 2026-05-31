"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useEnokiFlow } from "@mysten/enoki/react";

export default function AuthCallbackPage() {
  const router = useRouter();
  const enokiFlow = useEnokiFlow();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Process the OAuth redirect containing the JWT hash
    const handleAuth = async () => {
      try {
        await enokiFlow.handleAuthCallback();
        // Redirect back to home after successful auth
        router.push("/");
      } catch (err) {
        console.error("Auth callback failed:", err);
        setError("Authentication failed. Please try again.");
      }
    };

    handleAuth();
  }, [enokiFlow, router]);

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <div className="text-center">
        {error ? (
          <div className="text-rose-400">
            <h2 className="mb-2 text-xl font-bold">Error</h2>
            <p>{error}</p>
            <button
              onClick={() => router.push("/")}
              className="mt-4 rounded-lg bg-white/10 px-4 py-2 text-sm font-semibold hover:bg-white/20 transition"
            >
              Return Home
            </button>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-4">
            <div className="h-10 w-10 animate-spin rounded-full border-4 border-violet-500 border-t-transparent" />
            <h2 className="text-xl font-bold text-white">Authenticating...</h2>
            <p className="text-sm text-zinc-400">Creating your secure zkLogin session.</p>
          </div>
        )}
      </div>
    </div>
  );
}
