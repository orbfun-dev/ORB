/**
 * Binds `?ref=` to the connected wallet. Renders nothing.
 *
 * Mounted once, in the main app. That is enough, and the reason is
 * worth stating: the referral bonus fires when the server RECORDS the
 * referee's first qualifying event, and for an ORE deploy that is the
 * fee-wallet indexer picking it up, 15–60 seconds after it lands. The
 * binding happens on wallet connect, in the shell every tab shares —
 * the ORE tab included — so it is in place before the referee can sign
 * a deploy, let alone before the indexer sees it.
 *
 * (ORE Lite could not mount this itself: nothing under that feature
 * may import app code. It does not need to.)
 */

import { useWallet } from "@solana/wallet-adapter-react";
import { useReferralCapture } from "./useReferralCapture";

export function ReferralBinder(): null {
  const { publicKey, signMessage } = useWallet();
  useReferralCapture(publicKey?.toBase58() ?? null, signMessage);
  return null;
}
