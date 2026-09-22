#!/bin/bash
# End-to-end smoke test on a local validator:
#   deploy program → bootstrap (USDC mint, platform, markets) → start keeper (random-walk prices),
#   indexer (memory store) and trial engine → hit every health/read endpoint → tear down.
set -euo pipefail
export PATH="$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
LOGDIR="${SMOKE_LOGDIR:-$ROOT/.smoke}"
mkdir -p "$LOGDIR"
PROGRAM_ID="$(solana address -k target/deploy/vault-keypair.json)"
export SOLANA_RPC_URL=http://127.0.0.1:8899
export VAULT_PROGRAM_ID="$PROGRAM_ID"
export ANCHOR_WALLET="$HOME/.config/solana/id.json"

cleanup() { echo "--- teardown"; kill $(jobs -p) 2>/dev/null || true; }
trap cleanup EXIT

echo "--- validator (program $PROGRAM_ID)"
solana-test-validator --reset --quiet --ledger "$LOGDIR/ledger" \
  --bpf-program "$PROGRAM_ID" target/deploy/vault.so > "$LOGDIR/validator.log" 2>&1 &
for i in $(seq 1 60); do solana cluster-version -u localhost >/dev/null 2>&1 && break; sleep 1; done
solana airdrop 50 -u localhost "$(solana address)" >/dev/null

echo "--- bootstrap"
rm -f .devnet.json
pnpm exec ts-node --transpile-only scripts/bootstrap-devnet.ts | tee "$LOGDIR/bootstrap.log"
export USDC_MINT="$(grep '^USDC_MINT=' "$LOGDIR/bootstrap.log" | cut -d= -f2)"

echo "--- services"
STORE=memory API_PORT=4000 pnpm --filter @kydo/indexer dev > "$LOGDIR/indexer.log" 2>&1 &
PRICE_SOURCE=random-walk KEEPER_INTERVAL_MS=2000 PRICE_PUSH_MS=1500 pnpm --filter @kydo/keeper dev > "$LOGDIR/keeper.log" 2>&1 &
STORE=memory TRIAL_PORT=4100 TRIAL_PRICE_SOURCE=indexer pnpm --filter @kydo/trial-engine dev > "$LOGDIR/trial.log" 2>&1 &
for i in $(seq 1 60); do curl -sf localhost:4000/health >/dev/null 2>&1 && curl -sf localhost:4100/health >/dev/null 2>&1 && break; sleep 1; done
sleep 8   # let the keeper push a few price rounds

echo "--- endpoints"
for p in /health /config /markets /prices "/pools?sort=roi" /alerts; do
  printf "GET %-18s " "$p"; curl -sf "localhost:4000$p" | cut -c1-220; echo
done
printf "GET trial /health     "; curl -sf localhost:4100/health; echo
printf "GET trial state       "; curl -sf "localhost:4100/trial/$(solana address)" | cut -c1-220; echo

echo "--- keeper log tail"; tail -5 "$LOGDIR/keeper.log"
echo "--- indexer log tail"; tail -3 "$LOGDIR/indexer.log"
PRICES="$(curl -sf localhost:4000/prices)"
if echo "$PRICES" | grep -q '"price"'; then echo "SMOKE OK: keeper pushed prices, indexer read them from the mock oracles"; else echo "SMOKE FAIL: no prices"; exit 1; fi
