/**
 * Live native SOL balance of the connected wallet: instant via
 * `accountSubscribe`, with a slow 30 s poll as the websocket-degradation
 * fallback (the RPC diet pass — the socket carries every change while it
 * works; hidden tabs skip the poll entirely and refresh once on focus).
 * BigInt lamports.
 */

import { useEffect, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useOrbitClient } from "../context/OrbitClientProvider";

const POLL_MS = 30_000;

const isHidden = (): boolean => typeof document !== "undefined" && document.hidden;

export function useWalletBalance(): { balanceLamports: bigint | null } {
  const { client } = useOrbitClient();
  const { publicKey } = useWallet();
  const [balanceLamports, setBalance] = useState<bigint | null>(null);

  useEffect(() => {
    if (publicKey === null) {
      setBalance(null);
      return;
    }
    let alive = true;
    const refresh = (): void => {
      if (isHidden()) return; // the socket still updates a hidden tab
      client.connection
        .getBalance(publicKey, "confirmed")
        .then((lamports) => {
          if (alive) setBalance(BigInt(lamports));
        })
        .catch(() => {
          // keep the last known balance; the poll retries
        });
    };
    const id = client.connection.onAccountChange(
      publicKey,
      (info) => setBalance(BigInt(info.lamports)),
      "confirmed",
    );
    refresh();
    const poll = setInterval(refresh, POLL_MS);
    const onVisible = (): void => {
      if (document.visibilityState === "visible") refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      alive = false;
      clearInterval(poll);
      document.removeEventListener("visibilitychange", onVisible);
      void client.connection.removeAccountChangeListener(id);
    };
  }, [client, publicKey]);

  return { balanceLamports };
}
