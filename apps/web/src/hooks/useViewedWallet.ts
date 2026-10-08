/**
 * The identity the UI displays: the real connected wallet, or — in DEV
 * builds only — a `?wallet=<base58>` URL override. The override exists so
 * fixture mode can demonstrate identity-driven UI (claim banner, refund
 * banner, "you" highlights) without a signing wallet; transaction hooks
 * (useDeposit/useClaim/useRefund) deliberately use the REAL wallet, so an
 * overridden session can see a banner but never send a transaction.
 */

import { useMemo } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";

export interface ViewedWallet {
  /** Display identity — overridden in dev by `?wallet=`. */
  publicKey: PublicKey | null;
  /** Whether a REAL signing wallet is connected (gates every send button). */
  canSign: boolean;
  /** True when the displayed identity comes from the dev override. */
  isOverride: boolean;
}

export function useViewedWallet(): ViewedWallet {
  const { publicKey, connected } = useWallet();

  return useMemo<ViewedWallet>(() => {
    if (import.meta.env.DEV && typeof window !== "undefined") {
      const param = new URLSearchParams(window.location.search).get("wallet");
      if (param !== null && param.trim() !== "") {
        try {
          return {
            publicKey: new PublicKey(param.trim()),
            canSign: connected,
            isOverride: true,
          };
        } catch {
          // invalid base58 in the param — fall through to the real wallet
        }
      }
    }
    return { publicKey, canSign: connected, isOverride: false };
  }, [publicKey, connected]);
}
