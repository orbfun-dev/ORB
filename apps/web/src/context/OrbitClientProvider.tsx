import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import { useConnection } from "@solana/wallet-adapter-react";
import {
  OrbitJackpotClient,
  PROGRAM_ID,
  type OrbitEventEnvelope,
  type OrbitEventName,
} from "@orbit-jackpot/sdk";

interface OrbitClient {
  /** The wallet-adapter connection — the app's single RPC handle. */
  connection: ReturnType<typeof useConnection>["connection"];
  /** SDK client: decoders, fetchers, tx builders, event subscriptions. */
  client: OrbitJackpotClient;
  programId: string;
}

const OrbitClientContext = createContext<OrbitClient | null>(null);

/**
 * Builds the SDK client over the wallet-adapter connection so both share
 * one websocket/RPC pool. Everything downstream reads state through this —
 * components never construct `OrbitJackpotClient` themselves.
 *
 * NOTE: the client (and its event feed) is REBUILT when the connection
 * identity changes. Subscribe through {@link useOrbitEventSubscription},
 * whose cleanup tears down on unmount and on connection change — a
 * subscription held past a client swap would listen on a dead feed.
 */
export function OrbitClientProvider({ children }: { children: ReactNode }) {
  const { connection } = useConnection();

  const value = useMemo<OrbitClient>(() => {
    return {
      connection,
      client: new OrbitJackpotClient(connection),
      programId: PROGRAM_ID.toString(),
    };
  }, [connection]);

  return (
    <OrbitClientContext.Provider value={value}>
      {children}
    </OrbitClientContext.Provider>
  );
}

export function useOrbitClient(): OrbitClient {
  const ctx = useContext(OrbitClientContext);
  if (ctx === null) {
    throw new Error("useOrbitClient requires <OrbitClientProvider>");
  }
  return ctx;
}

/**
 * Live event subscription with full lifecycle management: resubscribes
 * when the client changes (connection swap), unsubscribes on unmount, and
 * always invokes the latest handler without resubscribing on every render.
 * `enabled: false` keeps the hook mounted but inert — fixture mode uses
 * this to hold hook order stable without talking to any network.
 */
export function useOrbitEventSubscription(
  name: OrbitEventName,
  handler: (envelope: OrbitEventEnvelope) => void,
  { enabled = true }: { enabled?: boolean } = {},
): void {
  const { client } = useOrbitClient();
  const savedHandler = useRef(handler);
  useEffect(() => {
    savedHandler.current = handler;
  }, [handler]);

  useEffect(() => {
    if (!enabled) return;
    let listenerId: number | null = null;
    let alive = true;
    void client
      .subscribe(name, (envelope) => savedHandler.current(envelope))
      .then((id) => {
        if (alive) {
          listenerId = id;
        } else {
          // Unmounted (or deps changed) before the subscription resolved.
          void client.unsubscribe(id);
        }
      });
    return () => {
      alive = false;
      if (listenerId !== null) {
        void client.unsubscribe(listenerId);
      }
    };
  }, [client, name, enabled]);
}
