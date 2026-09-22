#!/usr/bin/env bash
# Upgrade the devnet vault program in place, then migrate pre-upgrade accounts.
#
# Peak SOL need on the authority: ~6.5 SOL buffer rent (refunded on success)
# + ~0.6 SOL programdata extend (kept) + fees → have ≥ 8 SOL.
#
# Usage: scripts/upgrade-devnet.sh            # waits for funding, then upgrades
#        scripts/upgrade-devnet.sh --no-wait  # fail immediately if underfunded
set -euo pipefail
export PATH="$HOME/.local/share/solana/install/active_release/bin:$HOME/.cargo/bin:$PATH"
R="$(cd "$(dirname "$0")/.." && pwd)"
RPC="${SOLANA_RPC_URL:-https://api.devnet.solana.com}"
PROG=G4E1BiuovMpeUCgyh2222GqAQt4cW5dXSovZipFd89T1
KEY="${ANCHOR_WALLET:-$HOME/.config/solana/id.json}"
# Derived, never hardcoded: the deploy pays from $KEY, so the balance gate has
# to watch $KEY. This used to name a literal address that stopped being the
# authority at the last program-id redeploy, so the script waited forever on a
# key it was not spending from.
AUTH="$(solana address -k "$KEY")"
SO="$R/target/deploy/vault.so"
NEED=8

# …and the key has to actually hold the upgrade authority, or the deploy fails
# after the buffer has been paid for.
ONCHAIN=$(solana program show "$PROG" -u "$RPC" | awk '/^Authority/{print $2}')
[[ "$ONCHAIN" == "$AUTH" ]] || {
  echo "upgrade authority mismatch: program says $ONCHAIN, $KEY is $AUTH" >&2
  exit 1
}

bal() { solana balance "$AUTH" -u "$RPC" | awk '{print $1}'; }

if [[ "${1:-}" != "--no-wait" ]]; then
  until awk -v b="$(bal)" -v n="$NEED" 'BEGIN{exit !(b>=n)}'; do
    echo "$(date +%T) balance $(bal) SOL. Waiting for >= $NEED SOL on $AUTH"
    sleep 30
  done
fi
awk -v b="$(bal)" -v n="$NEED" 'BEGIN{exit !(b>=n)}' || { echo "underfunded: $(bal) SOL < $NEED"; exit 1; }

CUR=$(solana program show "$PROG" -u "$RPC" | awk '/Data Length/{print $3}')
NEW=$(stat -f %z "$SO")
if (( NEW > CUR )); then
  EXTEND=$(( NEW - CUR + 10240 ))
  echo "extending programdata by $EXTEND bytes ($CUR -> $NEW)"
  solana program extend "$PROG" "$EXTEND" -u "$RPC" -k "$KEY"
fi

echo "deploying $NEW bytes…"
solana program deploy "$SO" --program-id "$PROG" -u "$RPC" -k "$KEY" \
  --with-compute-unit-price 1000 --max-sign-attempts 100

echo "migrating pre-upgrade accounts…"
cd "$R" && SOLANA_RPC_URL="$RPC" npx ts-node --transpile-only scripts/migrate-accounts.ts

echo "post-upgrade balance: $(bal) SOL"
echo "UPGRADE COMPLETE"
