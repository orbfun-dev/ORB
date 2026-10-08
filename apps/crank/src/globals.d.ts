/**
 * Type declarations for the deep Switchboard ESM import the phase-8
 * scripts proved live — the package ships no .d.ts at that path.
 */
declare module "@switchboard-xyz/on-demand/dist/esm/utils/lookupTable.js" {
  import { PublicKey } from "@solana/web3.js";
  export function getLutSigner(programId: PublicKey, randomnessAccount: PublicKey): PublicKey;
  export function getLutKey(lutSigner: PublicKey, recentSlot: number): PublicKey;
}
