import { useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { UserRound } from "lucide-react";

/**
 * The stock multi-wallet button, re-skinned via the `.connect-button
 * .wallet-adapter-*` rules in styles.css (Tailwind utilities can't win
 * against the adapter's own stylesheet at equal specificity). Phantom and
 * Solflare adapters are registered in `WalletProviders`.
 *
 * Once connected it collapses to a profile circle — no address, no wallet
 * logo. Clicking it still opens the adapter's own menu (copy address,
 * change wallet, disconnect), and the full address rides on the tooltip.
 */
export function ConnectButton() {
  const { publicKey } = useWallet();
  const address = publicKey?.toBase58() ?? null;

  return (
    <span
      className={`connect-button${address !== null ? " is-connected" : ""}`}
      title={address ?? undefined}
    >
      <WalletMultiButton>
        {address !== null ? (
          <>
            <UserRound className="size-[1.15rem]" strokeWidth={2.4} aria-hidden />
            <span className="sr-only">Wallet menu</span>
          </>
        ) : undefined}
      </WalletMultiButton>
    </span>
  );
}
