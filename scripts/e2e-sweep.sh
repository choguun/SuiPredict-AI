#!/bin/bash
# E2E smoke test against the live deployment.
export PATH="/opt/homebrew/bin:/usr/bin:/bin:$PATH"
AGENTS="https://agents-production-11fd.up.railway.app"
WEB="https://suipredict-web.vercel.app"
PY=/opt/homebrew/bin/python3

echo "==== A. AGENTS BACKEND (8 endpoints) ===="
for path in /health /decisions /markets /wc/groups /wc/schedule /wc/upcoming /faucet/info /agents/manifest; do
  code=$(curl -sS -o /dev/null -w "%{http_code}" "$AGENTS$path?limit=1")
  echo "  $code  $path"
done

echo ""
echo "==== B. WC CREATOR (recent activity) ===="
curl -sS "$AGENTS/decisions?limit=30" 2>&1 | $PY -c "
import json,sys
try:
    d=json.load(sys.stdin)
except Exception as e:
    print('  parse error:', e); sys.exit()
agents = {}
for x in d:
    a = x.get('agent','')
    agents.setdefault(a, []).append(x)
print(f'  agents seen in last 30: {sorted(agents.keys())}')
for a in ['WorldCupCreator','WorldCupMaker','AutoFunder','PositionIndexer','RiskMonitor','ParlayWorker','MarketMaker','StreakSweeper','PrizeDistributor','PrizeAdmin','LeaderboardWorker','MarketCreator','MarketResolver','WorldCupResolver']:
    if a in agents:
        x = agents[a][0]
        print(f'  {a:20s} {x.get(\"action\"):15s} {x.get(\"reasoning\",\"\")[:80]}')
    else:
        print(f'  {a:20s} (no recent decision — outside cadence window)')
"

echo ""
echo "==== C. GAMIFICATION (5 endpoints) ===="
for path in "/leaderboard/week?limit=5" "/prize/pool" "/stats"; do
  code=$(curl -sS -o /dev/null -w "%{http_code}" "$AGENTS$path")
  echo "  $code  $path"
done

echo ""
echo "==== D. WEB PAGES (home + key feature pages) ===="
for path in / /worldcup /markets /leaderboard /parlay /portfolio /agents /friends /settings /admin /dispute /agent-policy; do
  code=$(curl -sS -o /dev/null -w "%{http_code}" -L "$WEB$path")
  echo "  $code  $path"
done

echo ""
echo "==== E. SAMPLE MARKET (wc26-E1v2) ===="
curl -sS "$AGENTS/markets/wc26-E1v2" 2>&1 | $PY -c "
import json,sys
try:
    d=json.load(sys.stdin)
    print(f'  id={d.get(\"id\")} status={d.get(\"status\")}')
    print(f'  title={d.get(\"title\",\"\")[:70]}')
    print(f'  pool={d.get(\"deepbook_pool_id\",\"\")[:20]}…')
    print(f'  onchain_market_id={d.get(\"onchain_market_id\",\"\")[:20]}…')
    print(f'  dispute_count={d.get(\"dispute_count\")}  resolved_at={d.get(\"resolved_at_ms\")}')
except Exception as e:
    print(f'  error: {e}')
"

echo ""
echo "==== F. FRIENDS API ===="
code=$(curl -sS -o /dev/null -w "%{http_code}" "$AGENTS/friends/list?user=0x0cdc0f4df0284828adde270ab50db083341135562866c26404ec945597d49716")
echo "  $code  /friends/list"

echo ""
echo "==== G. ON-CHAIN SANITY (agent balance) ===="
curl -sS "https://fullnode.testnet.sui.io:443" -X POST -H "Content-Type: application/json" -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"suix_getBalance\",\"params\":[\"0x0cdc0f4df0284828adde270ab50db083341135562866c26404ec945597d49716\"]}" | $PY -c "
import json,sys
d=json.load(sys.stdin)
r=d.get('result',{})
print(f'  agent SUI: {int(r.get(\"totalBalance\",\"0\"))/1e9:.4f} SUI ({r.get(\"coinObjectCount\")} coins)')
"
