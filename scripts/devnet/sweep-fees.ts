/**
 * `admin_sweep_fees` — drains the treasury vault's accrued fees to a
 * destination wallet. Signer is the TREASURY AUTHORITY (deliberately
 * separate from the admin); the keypair lives at
 * scripts/devnet/keys/treasury.json (fund it ~0.01 SOL for the tx fee
 * first — it is normally empty).
 *
 *   npx tsx scripts/devnet/sweep-fees.ts [destinationPubkey]
 */

import {
  configKey,
  OrbitJackpotClient,
  treasuryKey,
} from "@orbit-jackpot/sdk";
import { PublicKey, Transaction } from "@solana/web3.js";
import { connection, explorer, loadOrGenerateKeypair, send } from "./common";

const SYSVAR_RENT_PUBKEY = new PublicKey("SysvarRent111111111111111111111111111111111");

async function main(): Promise<void> {
  const destinationArg = process.argv[2];
  const authority = loadOrGenerateKeypair("treasury");
  const destination = new PublicKey(destinationArg ?? authority.publicKey.toBase58());

  const client = new OrbitJackpotClient(connection);
  const tx = new Transaction();
  tx.add({
    keys: [
      { pubkey: configKey(), isSigner: false, isWritable: false },
      { pubkey: treasuryKey(), isSigner: false, isWritable: true },
      { pubkey: authority.publicKey, isSigner: true, isWritable: false },
      { pubkey: destination, isSigner: false, isWritable: true },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
    ],
    programId: client.programId,
    // sha256("global:admin_sweep_fees")[..8]
    data: Buffer.from("f682dc94f34f871e", "hex"),
  });
  await send(tx, [authority], "admin_sweep_fees");
  console.log(`treasury: ${explorer(treasuryKey().toBase58(), "address")}`);
}

void main().catch((err) => {
  console.error(String(err));
  process.exitCode = 1;
});
