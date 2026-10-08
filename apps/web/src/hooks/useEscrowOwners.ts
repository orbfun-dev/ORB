/**
 * Resolves escrow PDAs among participant keys to their owners (Phase 10
 * §6.4): a participant key whose account decodes as a `PlayerEscrow` is
 * labelled by its `owner` and badged AUTO. Unknown keys are fetched in
 * chunked `getMultipleAccounts` (100 per call) and cached for the session;
 * a missing/undecodable account falls back to rendering the raw key — the
 * documented degradation, never an error. Fixture mode skips the fetch
 * (there is no chain behind the fixtures); the viewer's OWN escrow is
 * still resolved locally via the deterministic `escrowKey(owner)`.
 */

import { useEffect, useRef } from "react";
import { PublicKey } from "@solana/web3.js";
import { decodePlayerEscrow } from "@orbit-jackpot/sdk";
import { useOrbitClient } from "../context/OrbitClientProvider";

const CHUNK = 100;

/** escrow key → owner wallet (an entry maps to itself when it is not an escrow). */
export type EscrowOwnerMap = ReadonlyMap<string, string>;

export function useEscrowOwners(players: readonly string[], live: boolean): EscrowOwnerMap {
  const { client } = useOrbitClient();
  const cache = useRef(new Map<string, string>());

  useEffect(() => {
    if (!live) return;
    const unknown = [...new Set(players)].filter((key) => !cache.current.has(key));
    if (unknown.length === 0) return;
    const chunks: string[][] = [];
    for (let i = 0; i < unknown.length; i += CHUNK) chunks.push(unknown.slice(i, i + CHUNK));
    let disposed = false;
    void (async () => {
      for (const chunk of chunks) {
        const infos = await client.connection
          .getMultipleAccountsInfo(chunk.map((k) => new PublicKey(k)), "confirmed")
          .catch(() => null);
        if (disposed || infos === null) return; // read failed — raw-key fallback
        chunk.forEach((key, i) => {
          const info = infos[i];
          if (info === null) {
            cache.current.set(key, key); // no account — a wallet, or closed
            return;
          }
          try {
            cache.current.set(key, decodePlayerEscrow(info.data).owner);
          } catch {
            cache.current.set(key, key); // a non-escrow account (a wallet)
          }
        });
      }
    })();
    return () => {
      disposed = true;
    };
  }, [client, live, players]);

  return cache.current;
}
