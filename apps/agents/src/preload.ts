// Env preload — runs before ANY other module is imported.
//
// In ES module context, all `import` statements are hoisted to the
// top of the file and evaluated BEFORE the first non-import line.
// That means if the agents service imports the SDK before
// loading the .env, every `const FEE_VAULT_ID = process.env.FEE_VAULT_ID ?? ""`
// inside the SDK evaluates to "" (the default), and the
// resulting on-chain txs reference 0x0...0 object ids.
//
// R58.H4 audit fix: this file MUST be imported as the first
// non-relative import in `apps/agents/src/index.ts`, BEFORE
// `@suipredict/sdk`. We do that with:
//
//   import "./preload.js";
//   import { ... } from "@suipredict/sdk";
//
// Side effects: loads `apps/agents/../.env` (the repo-root .env)
// into `process.env`. The findRepoDotenv walker mirrors the
// pattern in `apps/agents/src/index.ts` but is simpler.

import { config as loadEnv } from "dotenv";
import { resolve } from "node:path";
import { existsSync } from "node:fs";

function findRepoDotenv(start: string): string | undefined {
  let cur = resolve(start);
  for (let i = 0; i < 8; i++) {
    const candidate = resolve(cur, ".env");
    if (existsSync(candidate)) return candidate;
    const parent = resolve(cur, "..");
    if (parent === cur) break;
    cur = parent;
  }
  return undefined;
}

const dotenvPath = findRepoDotenv(process.cwd());
if (dotenvPath) {
  loadEnv({ path: dotenvPath });
}
