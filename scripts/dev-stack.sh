#!/bin/bash
# Dev stack for Kydo. Localnet (default) or devnet.
#   scripts/dev-stack.sh up                       localnet: validator + program → bootstrap → services + apps
#   NETWORK=devnet scripts/dev-stack.sh up        devnet: (deploy if needed) → bootstrap → services + apps
#   scripts/dev-stack.sh down | status
#   scripts/dev-stack.sh faucet <wallet> <usd>
#   NETWORK=devnet scripts/dev-stack.sh upgrade   upgrade the deployed program to target/deploy/vault.so (needs ≈5.5 SOL free for the buffer)
#   PLATFORM_CONFIG=config/platform.jsonc scripts/dev-stack.sh up     use spec timings instead of the demo file
#
# devnet prerequisites: the admin keypair (~/.config/solana/id.json) needs ~7 devnet SOL
# (program rent ≈ 5.45 SOL + fees). `solana airdrop 2 -u devnet` is rate-limited; use
# https://faucet.solana.com when it fails.
set -euo pipefail
export PATH="$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
# Secrets and overrides live in the repo-root .env (gitignored). PYTH_API_KEY,
# DATABASE_URL, a keyed RPC. Services start via `pnpm --filter`, which runs them
# with cwd = the package directory, so their own `dotenv/config` looks for
# services/<name>/.env and never sees this file. Export it here instead.
# Anything the branches below set explicitly still wins.
if [ -f "$ROOT/.env" ]; then set -a; . "$ROOT/.env"; set +a; fi
NETWORK="${NETWORK:-localnet}"
D="$ROOT/.devstack"
mkdir -p "$D"
# `declare_id!` is authoritative: deployed at any other address the program
# rejects every instruction with DeclaredProgramIdMismatch (4100). Deriving the
# id from target/deploy/vault-keypair.json is wrong on a fresh checkout. That
# file is gitignored, so `anchor build` mints a random keypair and the stack
# would deploy to an address the program itself refuses to run at.
DECLARED_ID="$(grep -o 'declare_id!("[^"]*"' programs/vault/src/lib.rs | cut -d'"' -f2)"
PROGRAM_ID="${PROGRAM_ID:-$DECLARED_ID}"
KEYPAIR_ID="$(solana address -k target/deploy/vault-keypair.json 2>/dev/null || true)"
if [ -n "$KEYPAIR_ID" ] && [ "$KEYPAIR_ID" != "$PROGRAM_ID" ]; then
  echo "--- note: target/deploy/vault-keypair.json is $KEYPAIR_ID, but the program declares $PROGRAM_ID."
  echo "          Localnet loads the .so at the declared address and needs no keypair; a devnet"
  echo "          deploy does, so put the real one in place before NETWORK=devnet."
fi
export ANCHOR_WALLET="$HOME/.config/solana/id.json"
export VAULT_PROGRAM_ID="$PROGRAM_ID"
PRICE_SOURCE="${PRICE_SOURCE:-hermes}"   # hermes = live Pyth prices (needs PYTH_API_KEY; degrades to exchange spot only with PRICE_ALLOW_EXCHANGE_FALLBACK=true); exchange = Binance/Coinbase; random-walk = synthetic, localhost only

if [ "$NETWORK" = "devnet" ]; then
  # A keyed RPC belongs in the gitignored .env (loaded above), never in the repo.
  # The public endpoint works but rate-limits per IP, which the 5 s mark cadence
  # the liquidation buffer is sized for will not survive.
  export SOLANA_RPC_URL="${SOLANA_RPC_URL:-https://api.devnet.solana.com}"
  export SOLANA_WS_URL="${SOLANA_WS_URL:-}"
  case "$SOLANA_RPC_URL" in
    *api.devnet.solana.com*)
      echo "--- WARNING: using the public devnet RPC. It throttles per IP, so marks will lag and"
      echo "             evaluate_risk can revert with OracleStale. Set SOLANA_RPC_URL in .env." ;;
  esac
  # 5 s marks/pushes: the liquidation buffer (and so the first-loss cushion)
  # is sized for an ~18 s window. The old 20 s values were a public-devnet
  # throttling workaround; a keyed RPC does not need them, and running slower
  # silently exposes investors by the difference.
  # PUSH_MS=2000 is measured under the full stack, not guessed. A Pyth pull
  # round is ~2.9 s (one VAA, then all five post_updates at once) and devnet
  # adds confirmation lag. These numbers were measured against the old
  # oracleMaxAgeSlots=25 (10 s); it is now 150 (60 s) because a throttled RPC
  # stretches a round to ~17.6 s, so there is far more headroom than this table
  # implies. Keep the cadence tight anyway. A wide window is tolerance for a
  # slow keeper, not a licence to be one.
  # Measured OracleStale rate on evaluate_risk, all with both round fixes in:
  #   5000  35 slots worst, reverts constantly
  #   4000  25 slots worst. Passes solo, no margin
  #   3000  18 slots solo, but 3 stale ticks in 90 s once the indexer, trial
  #         engine and both Next apps are sharing the RPC
  #   2000  0 stale over 425 s / 107 rounds / ~85 risk ticks   <- shipped
  # Costs 2.63 SOL/day. Do NOT slow it down to save SOL: the honest lever is
  # oracleMaxAgeSlots, and widening that widens the adverse-move window the
  # first-loss cushion covers, so minFirstLossBps has to be re-derived with it.
  KEEPER_MS=${KEEPER_MS:-5000}; PUSH_MS=${PUSH_MS:-10000}; SNAP_MS=${SNAP_MS:-10000}
  STATE_FILE="$ROOT/.devnet.json"
else
  export SOLANA_RPC_URL=http://127.0.0.1:8899
  unset SOLANA_WS_URL
  KEEPER_MS=3000; PUSH_MS=2500; SNAP_MS=2000
  STATE_FILE="$ROOT/.localnet.json"
fi
export STATE_FILE

start() { # name, command...
  local name="$1"; shift
  ( "$@" > "$D/$name.log" 2>&1 & echo $! > "$D/$name.pid" )
  echo "  started $name (pid $(cat "$D/$name.pid"))"
}

down() {
  for f in "$D"/*.pid; do
    [ -f "$f" ] || continue
    pkill -P "$(cat "$f")" 2>/dev/null || true
    kill "$(cat "$f")" 2>/dev/null || true
    rm -f "$f"
  done
  pkill -f "solana-test-validator --ledger $D/ledger" 2>/dev/null || true
  echo "stack stopped"
}

usdc_mint() { grep '^USDC_MINT=' "$D/bootstrap.log" | cut -d= -f2; }

case "${1:-up}" in
  down) down ;;
  status)
    for f in "$D"/*.pid; do [ -f "$f" ] && printf "%-12s pid %s %s\n" "$(basename "$f" .pid)" "$(cat "$f")" "$(kill -0 "$(cat "$f")" 2>/dev/null && echo up || echo DOWN)"; done
    curl -sf localhost:4000/health && echo; curl -sf localhost:4100/health && echo ;;
  faucet)
    USDC_MINT="$(usdc_mint)" pnpm exec ts-node --transpile-only scripts/bootstrap-devnet.ts faucet "$2" "$3" ;;
  upgrade)
    BAL="$(solana balance -u "$SOLANA_RPC_URL" 2>/dev/null | awk '{print $1}')"
    echo "--- upgrading $PROGRAM_ID on $NETWORK (admin balance ${BAL:-?} SOL; the upgrade buffer needs ≈5.5 SOL, refunded afterwards)"
    anchor upgrade target/deploy/vault.so --program-id "$PROGRAM_ID" --provider.cluster "$([ "$NETWORK" = devnet ] && echo devnet || echo localnet)" --provider.wallet "$ANCHOR_WALLET"
    echo "--- re-applying platform params and restarting services"
    PLATFORM_CONFIG="${PLATFORM_CONFIG:-config/platform.demo.jsonc}" pnpm exec ts-node --transpile-only scripts/bootstrap-devnet.ts apply-params "$PLATFORM_CONFIG" || true
    exec "$0" up ;;
  up)
    down >/dev/null 2>&1 || true
    echo "--- network: $NETWORK  rpc: $SOLANA_RPC_URL  program: $PROGRAM_ID"
    if [ "$NETWORK" = "devnet" ]; then
      BAL="$(solana balance -u "$SOLANA_RPC_URL" 2>/dev/null | awk '{print $1}')"
      echo "--- admin $(solana address) balance: ${BAL:-?} SOL"
      if ! solana program show "$PROGRAM_ID" -u "$SOLANA_RPC_URL" >/dev/null 2>&1; then
        echo "--- program not on devnet yet → anchor deploy (needs ≈5.5 SOL rent)"
        anchor deploy --provider.cluster devnet --provider.wallet "$ANCHOR_WALLET"
      else
        echo "--- program already deployed on devnet"
      fi
      rm -f "$D/ledger.localnet.marker"
    else
      echo "--- validator"
      start validator solana-test-validator --reset --quiet --ledger "$D/ledger" --bpf-program "$PROGRAM_ID" target/deploy/vault.so
      for i in $(seq 1 60); do solana cluster-version -u localhost >/dev/null 2>&1 && break; sleep 1; done
      solana airdrop 100 -u localhost "$(solana address)" >/dev/null
      rm -f "$STATE_FILE"   # fresh chain → fresh mint
    fi
    echo "--- bootstrap (test USDC mint, platform, markets, demo params)"
    pnpm exec ts-node --transpile-only scripts/bootstrap-devnet.ts | tee "$D/bootstrap.log" | grep -E "created|reusing|init_platform|already|registered|exists|USDC_MINT="
    USDC_MINT="$(usdc_mint)"
    export USDC_MINT
    PLATFORM_CONFIG="${PLATFORM_CONFIG:-config/platform.demo.jsonc}"
    echo "--- platform params from $PLATFORM_CONFIG"
    pnpm exec ts-node --transpile-only scripts/bootstrap-devnet.ts apply-params "$PLATFORM_CONFIG" || true
    # landing (:3001) needs API_URL / NETWORK / VAULT_PROGRAM_ID / TERMINAL_URL;
    # the rest are harmless extras for it.
    for app in terminal landing; do
      cat > "apps/$app/.env.local" <<EOF
NEXT_PUBLIC_RPC_URL=${APP_RPC_URL:-$SOLANA_RPC_URL}
NEXT_PUBLIC_API_URL=http://127.0.0.1:4000
NEXT_PUBLIC_TRIAL_URL=http://127.0.0.1:4100
NEXT_PUBLIC_TERMINAL_URL=http://127.0.0.1:3000
NEXT_PUBLIC_VAULT_PROGRAM_ID=$PROGRAM_ID
NEXT_PUBLIC_USDC_MINT=$USDC_MINT
NEXT_PUBLIC_NETWORK=$NETWORK
EOF
    done
    echo "--- services"
    # Postgres if reachable (docker compose up -d postgres), else in-memory stores.
    if [ -z "${DATABASE_URL:-}" ] && docker exec kydo_postgres pg_isready -U kydo >/dev/null 2>&1; then
      export DATABASE_URL=postgres://kydo:kydo@localhost:5432/kydo
    fi
    # STORE follows Postgres availability unless overridden: pg keeps trial logs / history across restarts,
    # memory loses them (a trial engine restart then makes every wallet's export "no trial account").
    STORE="${STORE:-$([ -n "${DATABASE_URL:-}" ] && echo pg || echo memory)}"
    [ "$STORE" = pg ] && echo "    store: postgres ($DATABASE_URL)" || echo "    store: in-memory. Trial logs are lost on restart (start Postgres with: pnpm db:up)"
    export PUBLIC_INVESTOR_URL="${PUBLIC_INVESTOR_URL:-http://localhost:3001}"
    start indexer env STORE="$STORE" API_PORT=4000 SNAPSHOT_INTERVAL_MS=$SNAP_MS FAUCET_ENABLED=true FAUCET_KEYPAIR="$ANCHOR_WALLET" USDC_MINT="$USDC_MINT" pnpm --filter @kydo/indexer dev
    start keeper env PRICE_SOURCE="$PRICE_SOURCE" KEEPER_INTERVAL_MS=$KEEPER_MS PRICE_PUSH_MS=$PUSH_MS pnpm --filter @kydo/keeper dev
    start trial env STORE="$STORE" TRIAL_PORT=4100 TRIAL_PRICE_SOURCE=indexer TRIAL_DEV_FORCE_PASS=true pnpm --filter @kydo/trial-engine dev
    start terminal pnpm --filter @kydo/terminal dev
    start landing pnpm --filter @kydo/landing dev
    for i in $(seq 1 90); do curl -sf localhost:4000/health >/dev/null 2>&1 && curl -sf localhost:4100/health >/dev/null 2>&1 && curl -sf localhost:3000 >/dev/null 2>&1 && curl -sf localhost:3001 >/dev/null 2>&1 && break; sleep 1; done
    echo
    echo "==================================================================="
    echo " Network       $NETWORK   RPC $SOLANA_RPC_URL"
    if [ "$NETWORK" = "devnet" ]; then echo " Wallet        Phantom → Settings → Developer Settings → Devnet"; else echo " Wallet        Phantom → Settings → Developer Settings → Localhost"; fi
    echo " Program       $PROGRAM_ID"
    echo " Test USDC     $USDC_MINT"
    echo " Terminal      http://localhost:3000"
    echo " Investor app  http://localhost:3001"
    echo " Indexer API   http://localhost:4000   Trial engine http://localhost:4100"
    echo " Fund a wallet: click “Get test USDC” in either app, or scripts/dev-stack.sh faucet <WALLET> 5000"
    echo " Logs: $D/*.log   Stop: scripts/dev-stack.sh down"
    echo "==================================================================="
    ;;
esac
