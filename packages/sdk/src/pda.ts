import { PublicKey } from "@solana/web3.js";
import { SEEDS, VAULT_PROGRAM_ID } from "./constants";

const u16le = (n: number) => {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n);
  return b;
};

export function pdas(programId: PublicKey = VAULT_PROGRAM_ID) {
  const find = (seeds: (Buffer | Uint8Array)[]) => PublicKey.findProgramAddressSync(seeds, programId)[0];
  return {
    platform: () => find([SEEDS.platform]),
    registry: () => find([SEEDS.registry]),
    treasury: () => find([SEEDS.treasury]),
    treasuryVault: () => find([SEEDS.treasuryVault]),
    trader: (wallet: PublicKey) => find([SEEDS.trader, wallet.toBuffer()]),
    pool: (trader: PublicKey, index: number) => find([SEEDS.pool, trader.toBuffer(), u16le(index)]),
    poolVault: (pool: PublicKey) => find([SEEDS.poolVault, pool.toBuffer()]),
    investor: (pool: PublicKey, investor: PublicKey) => find([SEEDS.investor, pool.toBuffer(), investor.toBuffer()]),
    mockOracle: (marketId: number) => find([SEEDS.mockOracle, u16le(marketId)]),
    session: (trader: PublicKey) => find([SEEDS.session, trader.toBuffer()]),
    commonPool: () => find([SEEDS.commonPool]),
    commonVault: () => find([SEEDS.commonVault]),
    commonInvestor: (investor: PublicKey) => find([SEEDS.commonInvestor, investor.toBuffer()]),
    ticket: (trader: PublicKey) => find([SEEDS.ticket, trader.toBuffer()]),
  };
}

export const PDA = pdas();
