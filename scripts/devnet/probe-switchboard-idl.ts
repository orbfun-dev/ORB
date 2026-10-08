/**
 * Read-only probe #2: BUILD the three randomness instructions through the
 * SDK's anchor coder and print the produced account metas (the wire truth —
 * the chain-fetched IDL omits isMut/isSigner flags). No transaction is sent.
 */
import { Connection, Keypair, PublicKey, SYSVAR_SLOT_HASHES_PUBKEY } from "@solana/web3.js";
import { AnchorUtils, State, ON_DEMAND_DEVNET_QUEUE } from "@switchboard-xyz/on-demand";
import BN from "bn.js";
// Internal helpers re-exported through the compiled utils barrel (no public
// subpath export in the package's dist).
import { getLutSigner, getLutKey } from "@switchboard-xyz/on-demand/dist/esm/utils/lookupTable.js";

const QUEUE = new PublicKey(ON_DEMAND_DEVNET_QUEUE);

async function main(): Promise<void> {
  const connection = new Connection(
    process.env.DEVNET_RPC_URL ?? "https://api.devnet.solana.com",
    "confirmed",
  );
  const payer = Keypair.generate();
  const program = await AnchorUtils.loadProgramFromConnection(connection, payer);
  const show = (label: string, keys: Array<{ pubkey: PublicKey; isSigner: boolean; isWritable: boolean }>) => {
    console.log(`\n${label}:`);
    for (const k of keys) console.log(`  ${k.pubkey.toBase58().slice(0, 8)}… w=${k.isWritable ? 1 : 0} s=${k.isSigner ? 1 : 0}`);
  };

  // randomnessInit with authority = a PDA (round-PDA stand-in) and payer = wallet
  const randomKp = Keypair.generate();
  const lutSigner = getLutSigner(program.programId, randomKp.publicKey);
  const recentSlot = await connection.getSlot("finalized");
  const lutKey = getLutKey(lutSigner, recentSlot);
  const pdaAuthority = PublicKey.findProgramAddressSync(
    [Buffer.from("round"), Buffer.alloc(8)],
    new PublicKey("G5yNWmzSPVozbXSj2Muv4pV8AbVwTHhJfL6nfWyAC48R"),
  )[0];
  const initIx = await program.instruction.randomnessInit(
    { recentSlot: new BN(recentSlot.toString()) },
    {
      accounts: {
        randomness: randomKp.publicKey,
        queue: QUEUE,
        authority: pdaAuthority,
        payer: payer.publicKey,
        rewardEscrow: PublicKey.findProgramAddressSync(
          [randomKp.publicKey.toBuffer()],
          new PublicKey("9BB6NfeEW7cuqBC6NQXrLaqz2VwM9wLmM5t9wYsyFyyX"),
        )[0],
        systemProgram: PublicKey.default,
        tokenProgram: PublicKey.default,
        associatedTokenProgram: PublicKey.default,
        wrappedSolMint: PublicKey.default,
        programState: State.keyFromSeed(program),
        lutSigner,
        lut: lutKey,
        addressLookupTableProgram: new PublicKey("AddressLookupTab1e1111111111111111111111111"),
      },
    },
  );
  show("randomnessInit (authority = round PDA stand-in)", initIx.keys);

  // randomnessReveal with dummy args, authority = the same PDA
  const revealIx = await program.instruction.randomnessReveal(
    { signature: Buffer.alloc(64), recoveryId: 0, value: Buffer.alloc(32) },
    {
      accounts: {
        randomness: randomKp.publicKey,
        oracle: Keypair.generate().publicKey,
        queue: QUEUE,
        stats: Keypair.generate().publicKey,
        authority: pdaAuthority,
        payer: payer.publicKey,
        recentSlothashes: SYSVAR_SLOT_HASHES_PUBKEY,
        systemProgram: PublicKey.default,
        rewardEscrow: PublicKey.default,
        tokenProgram: PublicKey.default,
        wrappedSolMint: PublicKey.default,
        programState: State.keyFromSeed(program),
      },
    },
  );
  show("randomnessReveal (authority = PDA)", revealIx.keys);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
