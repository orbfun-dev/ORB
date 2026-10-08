// @vitest-environment happy-dom
/**
 * The header wallet button: a labelled brass pill while disconnected, a
 * bare profile circle once connected — never the shortened address — with
 * the adapter's menu (copy / change / disconnect) still behind a click.
 *
 * Drives the REAL WalletProvider with a fake adapter rather than mocking
 * useWallet: the stock button reads the wallet through the adapter's own
 * base-ui hook, which a module mock would not reach.
 */

import { useEffect, useState, type ReactNode } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ConnectionProvider, WalletProvider, useWallet } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import {
  BaseSignerWalletAdapter,
  WalletReadyState,
  type WalletName,
} from "@solana/wallet-adapter-base";
import { Keypair, type PublicKey, type Transaction, type VersionedTransaction } from "@solana/web3.js";
import { afterEach, describe, expect, it } from "vitest";
import { ConnectButton } from "../src/components/wallet/ConnectButton";

const KEY = Keypair.generate().publicKey;
const SHORT = `${KEY.toBase58().slice(0, 4)}..${KEY.toBase58().slice(-4)}`;

class FakeAdapter extends BaseSignerWalletAdapter {
  name = "Fake" as WalletName<"Fake">;
  url = "https://example.invalid";
  icon = "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'/>";
  readyState = WalletReadyState.Installed;
  supportedTransactionVersions = null;
  private key: PublicKey | null = null;
  get publicKey() {
    return this.key;
  }
  get connecting() {
    return false;
  }
  async connect() {
    this.key = KEY;
    // Child effects run before the provider's, so yield a tick for it to
    // attach its `connect` listener first — as a real wallet's popup does.
    await new Promise((r) => setTimeout(r, 0));
    this.emit("connect", KEY);
  }
  async disconnect() {
    this.key = null;
    this.emit("disconnect");
  }
  async signTransaction<T extends Transaction | VersionedTransaction>(tx: T) {
    return tx;
  }
}

function AutoConnect() {
  const { select, wallet, connect, connected } = useWallet();
  useEffect(() => {
    if (wallet === null) select("Fake" as WalletName);
    else if (!connected) void connect();
  }, [wallet, connected, select, connect]);
  return null;
}

function Shell({ children, connect }: { children: ReactNode; connect: boolean }) {
  // One adapter per mount: a fresh instance per render would orphan the
  // provider's connect listener and the button would never see the key.
  const [wallets] = useState(() => [new FakeAdapter()]);
  return (
    <ConnectionProvider endpoint="http://127.0.0.1:8899">
      <WalletProvider wallets={wallets} autoConnect={false}>
        <WalletModalProvider>
          {connect && <AutoConnect />}
          {children}
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}

afterEach(cleanup);

describe("ConnectButton", () => {
  it("is a labelled pill while disconnected", () => {
    const { container } = render(
      <Shell connect={false}>
        <ConnectButton />
      </Shell>,
    );
    expect(container.querySelector(".connect-button.is-connected")).toBeNull();
    expect(screen.getByRole("button").textContent).toMatch(/select wallet|connect/i);
  });

  it("collapses to a profile circle once connected — no address shown", async () => {
    const { container } = render(
      <Shell connect>
        <ConnectButton />
      </Shell>,
    );
    const wrapper = await waitFor(() => {
      const el = container.querySelector(".connect-button.is-connected");
      expect(el).not.toBeNull();
      return el;
    });
    const button = wrapper!.querySelector("button.wallet-adapter-button")!;
    expect(button.textContent).not.toContain(SHORT);
    expect(button.querySelector("svg")).not.toBeNull();
    // the full address stays discoverable on hover
    expect(wrapper!.getAttribute("title")).toBe(KEY.toBase58());

    // the adapter's menu still opens behind the circle
    fireEvent.click(button);
    expect(screen.getByRole("menu").className).toContain("wallet-adapter-dropdown-list-active");
    expect(screen.getByText(/disconnect/i)).toBeTruthy();
  });
});
