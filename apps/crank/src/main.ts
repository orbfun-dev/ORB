/**
 * orbit-crank entrypoint (phase 9.2–9.4): the autonomous keeper.
 *
 * Boots the full supervision stack — config, structured logs, keeper
 * identity, paced/backoff RPC gateway, /healthz, persistent state,
 * Switchboard context, chain reader, WS-backed round monitor, and the
 * action executor — then hands control to the supervisor loop:
 *
 *   lock expired windows → keep one round open → settle pending rounds
 *   (create → pin → commit → gateway reveal → settle, verified) →
 *   sweep/refund/close terminal rounds.
 *
 *   npm run dev --workspace @orbit-jackpot/crank
 */

import { Connection, PublicKey } from "@solana/web3.js";
import { EntropySeeds } from "./entropy";
import { ORB_CLUSTER, OrbitJackpotClient, PROGRAM_ID } from "@orbit-jackpot/sdk";
import { loadConfig, redactUrl } from "./config";
import { createLogger } from "./log";
import { loadKeeper } from "./keeper";
import { RpcGateway } from "./rpc";
import { HealthMonitor } from "./health";
import { StateStore } from "./state";
import { ChainReader } from "./reader";
import { SwitchboardCtx } from "./randomness";
import { RoundMonitor } from "./monitor";
import { FileEscrowRegistry } from "./escrows";
import { TxExecutor } from "./actions";
import { Supervisor } from "./supervisor";
import type { HandlerCtx } from "./context";

const VERSION: string = require("../package.json").version;

async function main(): Promise<void> {
  const cfg = loadConfig();
  // The SDK picked PROGRAM_ID from ORB_CLUSTER at import; the config read
  // the same variable. They must agree, or every PDA targets the wrong program.
  if (cfg.cluster !== ORB_CLUSTER) {
    throw new Error(`cluster mismatch: config ${cfg.cluster} vs SDK ${ORB_CLUSTER}`);
  }
  const logger = createLogger(cfg.logLevel, cfg.logFile);
  const keeper = loadKeeper(cfg, logger);
  const keeperPubkey = keeper.keypair.publicKey.toBase58();

  const connection = new Connection(cfg.rpcUrl, { commitment: cfg.commitment });
  const rpc = new RpcGateway(connection, logger.child({ mod: "rpc" }), {
    paceMs: cfg.rpcPaceMs,
    maxBackoffMs: cfg.maxBackoffMs,
  });
  const health = new HealthMonitor(
    VERSION,
    keeperPubkey,
    cfg.minKeeperBalanceLamports,
    cfg.dryRun,
  );
  await health.listen(cfg.healthzHost, cfg.healthzPort);

  const state = new StateStore(cfg.stateDir, logger.child({ mod: "state" }));
  const reader = new ChainReader(rpc);
  const sb = new SwitchboardCtx(
    connection,
    keeper.keypair,
    cfg.gatewayRpcUrl, // never the paid RPC — this URL goes to third-party oracles
    logger.child({ mod: "sb" }),
    cfg.sbCrossbarUrl,
  );
  // Builders only — the client never fetches through its own connection.
  const client = new OrbitJackpotClient(connection, undefined, PROGRAM_ID, keeper.keypair.publicKey);

  // The monitor's watcher wakes the supervisor; late-bind to avoid a
  // construction cycle between the two.
  let wakeSupervisor: () => void = () => undefined;
  const monitor = new RoundMonitor(
    reader,
    {
      windowSize: cfg.maxTrackedRounds,
      wsEnabled: cfg.wsEnabled,
      connection,
      commitment: cfg.commitment,
    },
    (key) => reader.randomness(key),
    () => wakeSupervisor(),
  );

  // Escrow discovery (design §5.1): events accelerate, reconciliation
  // decides — the event feed registers every EscrowFunded while the keeper
  // is up; a bounded GPA reconcile at boot and every CRANK_ESCROW_RECONCILE_MS
  // heals anything a truncated log missed (refusal keeps the registry).
  const escrows = new FileEscrowRegistry(
    cfg.stateDir,
    reader,
    rpc,
    cfg,
    logger.child({ mod: "escrows" }),
  );
  void escrows.reconcile();
  const escrowReconcileTimer = setInterval(() => void escrows.reconcile(), cfg.escrowReconcileMs);
  escrowReconcileTimer.unref();
  void client
    .subscribeEscrowFunded((event) =>
      escrows.noteFunded(new PublicKey(event.escrow), new PublicKey(event.owner)),
    )
    .catch((err) => {
      logger.warn({ err: String(err).slice(0, 160) }, "EscrowFunded subscription failed — GPA reconcile remains");
    });

  // Randomness fallback: the keeper holds the entropy hash-chain seeds.
  // Loaded once; a missing file only matters while the provider is
  // `entropy` (the settle handler then logs and halts the round loudly).
  let entropy: EntropySeeds | null = null;
  if (cfg.entropySeedFile !== undefined) {
    entropy = EntropySeeds.fromFile(cfg.entropySeedFile);
    logger.info({ length: entropy.length, commit: entropy.commit().toString("hex").slice(0, 16) }, "entropy seeds loaded");
  }

  const ctx: HandlerCtx = {
    entropy,
    cfg,
    logger: logger.child({ mod: "handlers" }),
    rpc,
    keeper: keeper.keypair,
    client,
    sb,
    bridge: reader,
    book: state,
    escrows,
  };
  const executor = new TxExecutor(rpc, keeper.keypair, cfg, state, health, logger.child({ mod: "exec" }));
  const supervisor = new Supervisor({
    cfg,
    logger: logger.child({ mod: "supervisor" }),
    rpc,
    keeper: keeper.keypair,
    monitor,
    state,
    health,
    executor,
    ctx,
  });
  wakeSupervisor = () => supervisor.wake();

  logger.info(
    {
      event: "startup",
      version: VERSION,
      node: process.version,
      rpcUrl: redactUrl(cfg.rpcUrl),
      gatewayRpcUrl: redactUrl(cfg.gatewayRpcUrl),
      commitment: cfg.commitment,
      keeperPubkey,
      keeperSource: keeper.source,
      dryRun: cfg.dryRun,
      pollIntervalMs: cfg.pollIntervalMs,
      wsEnabled: cfg.wsEnabled,
      cleanupEnabled: cfg.cleanupEnabled,
      claimForWinners: cfg.claimForWinners,
      autoDepositEnabled: cfg.autoDepositEnabled,
      autoDepositMaxPerTx: cfg.autoDepositMaxPerTx,
      escrowGpaEnabled: cfg.escrowGpaEnabled,
      escrowReconcileMs: cfg.escrowReconcileMs,
      healthz: `${cfg.healthzHost}:${health.port}`,
      stateDir: cfg.stateDir,
      minKeeperBalanceLamports: String(cfg.minKeeperBalanceLamports),
    },
    "orbit-crank up — autonomous keeper starting",
  );

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ event: "shutdown", signal }, "stopping");
    supervisor.stop();
    monitor.closeWatcher();
    health
      .close()
      .catch(() => undefined)
      .finally(() => process.exit(0));
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  // Last-resort nets: anything that still escapes (a stray unhandled
  // rejection) is logged loudly and the process exits — systemd's
  // Restart=always brings it back into a known-good state.
  process.on("unhandledRejection", (reason) => {
    logger.fatal({ event: "unhandled_rejection", err: String(reason).slice(0, 500) }, "exiting");
    process.exit(1);
  });
  process.on("uncaughtException", (err) => {
    logger.fatal({ event: "uncaught_exception", err: String(err).slice(0, 500) }, "exiting");
    process.exit(1);
  });

  await supervisor.run();
  logger.info({ event: "stopped" }, "supervisor exited");
  process.exit(0);
}

main().catch((err) => {
  // Startup failures (bad config, unreadable keypair, healthz port taken)
  // are fatal and loud — systemd will restart with backoff.
  console.error(JSON.stringify({ svc: "orbit-crank", level: "fatal", event: "startup_error", err: String(err) }));
  process.exit(1);
});
