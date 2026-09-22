# Running the value-flow trace

`scripts/scenario.ts` walks a $5,000 pool from a trader applying through a
daily-loss breach to settlement, printing the ledger after every instruction.
It is a trace, not a test. It asserts almost nothing, and it exists so the
money can be followed rather than described.

```bash
PID=$(sed -n 's/.*declare_id!("\(.*\)").*/\1/p' programs/vault/src/lib.rs)

solana-test-validator --reset --quiet --ledger /tmp/sc \
  --bpf-program "$PID" target/deploy/vault.so &
until solana cluster-version -u localhost >/dev/null 2>&1; do sleep 1; done
solana airdrop 100 -u localhost "$(solana address)"

ANCHOR_PROVIDER_URL=http://127.0.0.1:8899 ANCHOR_WALLET=~/.config/solana/id.json \
  pnpm exec ts-mocha -p ./tsconfig.json -t 1000000 scripts/scenario.ts
```

Takes about a minute. Most of it is the 31-second wait for the simulated trial
days to elapse.

## Why it switches `daySecs` midway

The trial needs 1-second platform days or 30 of them never pass inside a test.
The daily-loss floor needs days long enough that `roll_day` does not reset
`day_start_nav` between opening a position and the price moving against it.
Otherwise the 4% floor rebases every second and can never be breached. The
trace runs the trial at `daySecs: 1`, then raises it to 86,400 before the pool
is funded.
