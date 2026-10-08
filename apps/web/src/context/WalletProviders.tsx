import { useMemo, type ReactNode } from "react";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { PhantomWalletAdapter } from "@solana/wallet-adapter-phantom";
import { SolflareWalletAdapter } from "@solana/wallet-adapter-solflare";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RPC_COMMITMENT, RPC_ENDPOINT } from "../lib/rpc";

/**
 * Provider stack: wallet-adapter (connection + wallets + modal) wrapping
 * TanStack Query (RPC reads in 7.2+). One connection instance flows to the
 * rest of the app through wallet-adapter's `useConnection`.
 */
export function WalletProviders({ children }: { children: ReactNode }) {
  const wallets = useMemo(
    () => [new PhantomWalletAdapter(), new SolflareWalletAdapter()],
    [],
  );

  const queryClient = useMemo(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            retry: 1,
            refetchOnWindowFocus: false,
            // Accounts are websocket-driven in 7.2; queries act as the
            // initial fetch + reconnect safety net.
            staleTime: 5_000,
          },
        },
      }),
    [],
  );

  return (
    <ConnectionProvider endpoint={RPC_ENDPOINT} config={{ commitment: RPC_COMMITMENT }}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>
          <QueryClientProvider client={queryClient}>
            {children}
          </QueryClientProvider>
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
