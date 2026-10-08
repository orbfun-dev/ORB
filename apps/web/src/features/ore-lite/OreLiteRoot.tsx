/**
 * OreLiteRoot — the ORE tab's content, mounted by the app shell at "#/ore"
 * like every other page (src/pages/OrePage.tsx, lazy).
 *
 * The app's provider stack is DEVNET; ORE exists only on mainnet-beta.
 * This component therefore scopes its own mainnet ConnectionProvider and
 * its own query client around the miner: every `useConnection()` under it
 * resolves to mainnet, and its query keys never mix with the app's devnet
 * cache. Nothing outside this subtree sees either.
 *
 * The wallet is the app's: one WalletProvider, one connect button in the
 * shared header. That is safe across clusters because ORE never lets the
 * wallet send — `useOreDeploy` asks only for `signTransaction` and the
 * mainnet client submits the signed bytes itself.
 */

import { useMemo } from "react";
import { ConnectionProvider } from "@solana/wallet-adapter-react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ORE_RPC_URL } from "./config";
import { OreLiteMiner } from "./components/OreLiteMiner";

export function OreLiteRoot() {
  const queryClient = useMemo(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            retry: 1,
            refetchOnWindowFocus: false,
            staleTime: 2_000,
          },
        },
      }),
    [],
  );

  return (
    <ConnectionProvider endpoint={ORE_RPC_URL} config={{ commitment: "confirmed" }}>
      <QueryClientProvider client={queryClient}>
        <OreLiteMiner />
      </QueryClientProvider>
    </ConnectionProvider>
  );
}
