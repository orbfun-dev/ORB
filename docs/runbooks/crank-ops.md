# Orbit Crank — Droplet Operations Runbook (phase 9.5)

Everything needed to run the Orbit Jackpot autonomous keeper unattended on
the Ubuntu droplet (`<droplet-ip>`), from a clean slate to monitoring
and upgrades. The keeper drives the full round lifecycle on Solana
Devnet: lock expired windows → keep one round open → settle pending
rounds (create → pin → commit → gateway reveal → fulfill, verified
against the independent entropy mirror) → sweep/refund/close terminal
rounds.

Local counterparts: `apps/crank/.env.example` documents every `CRANK_*`
variable; `docs/reports/devnet-demo.md` is the phase-8 protocol runbook.

## 0. Clean slate — clear lingering processes and ports

Run over SSH (`ssh root@<droplet-ip>`) before the first install, or any
time the droplet feels dirty:

```bash
# PM2 daemons (if any old world used them)
pm2 ls 2>/dev/null && pm2 delete all 2>/dev/null; pm2 kill 2>/dev/null

# Docker containers + images (old experiments)
docker ps -a --format '{{.Names}}' | grep -i orbit | xargs -r docker rm -f
docker system prune -af --volumes 2>/dev/null | tail -1

# Orphaned node/tsx processes bound to our paths
pkill -f 'orbit-crank' 2>/dev/null; pkill -f 'tsx watch' 2>/dev/null

# Old systemd unit from previous experiments
systemctl stop orbit-crank 2>/dev/null; systemctl disable orbit-crank 2>/dev/null
rm -f /etc/systemd/system/orbit-crank.service && systemctl daemon-reload

# Port availability (healthz wants 8080 on loopback)
ss -ltnp | grep -E ':8080|:3000' || echo "ports free"
```

## 1. System setup — Node 20 + the orbit service user

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs rsync
node --version   # v20.x

useradd --system --create-home --shell /usr/sbin/nologin orbit
mkdir -p /opt/orbit-crank && chown orbit:orbit /opt/orbit-crank
```

## 2. Code sync + build

From the LOCAL repo (excludes everything regenerable or secret):

```bash
rsync -az --delete \
  --exclude node_modules --exclude target --exclude .git \
  --exclude apps/crank/var --exclude 'scripts/*/keys' --exclude .env \
  ./ root@<droplet-ip>:/opt/orbit-crank/
```

On the droplet:

```bash
cd /opt/orbit-crank
npm ci
npm run build:crank        # builds the SDK, then apps/crank → dist/
```

> `apps/web` sources ride along so the npm workspace lockfile validates —
> the crank never executes them.

## 3. Secrets — /etc/orbit-crank

```bash
mkdir -p /etc/orbit-crank && chmod 700 /etc/orbit-crank

# The keeper identity (generate ON the droplet — the secret never leaves it)
solana-keygen new --no-bip39-passphrase -o /etc/orbit-crank/keeper.json
# (no solana CLI? generate locally, scp it over, and never commit it)
chmod 600 /etc/orbit-crank/keeper.json
solana-keygen pubkey /etc/orbit-crank/keeper.json   # ← record this

# Environment file (template: apps/crank/.env.example)
cp /opt/orbit-crank/apps/crank/.env.example /etc/orbit-crank/orbit-crank.env
chmod 600 /etc/orbit-crank/orbit-crank.env
```

Then edit `/etc/orbit-crank/orbit-crank.env` — the essentials:

```ini
CRANK_RPC_URL=https://api.devnet.solana.com
CRANK_KEYPAIR_PATH=/etc/orbit-crank/keeper.json
CRANK_STATE_DIR=/opt/orbit-crank/apps/crank/var
CRANK_HEALTHZ_HOST=127.0.0.1
CRANK_HEALTHZ_PORT=8080
```

State directory (per-round randomness keypairs, quarantines, audit log):

```bash
mkdir -p /opt/orbit-crank/apps/crank/var
chown -R orbit:orbit /opt/orbit-crank
chown -R orbit:orbit /etc/orbit-crank
```

## 4. Fund the keeper

Each round nets the keeper ≈ **−0.002 SOL** (0.001 settle tip in,
~0.003 randomness+LUT rent out) plus fees, and the initial sweep of
backlogged rounds costs rent up front. Keep ≥ 1 SOL on it — `/healthz`
degrades below `CRANK_MIN_KEEPER_BALANCE_SOL`.

From the LOCAL machine (the vaulted admin is the devnet faucet — it
never leaves this laptop):

```bash
# either the helper (fund a pubkey directly):
npx tsx scripts/devnet/crank-fund.ts 2 <DROPLET_KEEPER_PUBKEY>

# or plain CLI:
solana transfer <DROPLET_KEEPER_PUBKEY> 2 --url devnet \
  -k ~/.config/solana/vaulted-admin.json
```

## 5. Activate systemd

```bash
cp /opt/orbit-crank/apps/crank/orbit-crank.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now orbit-crank
systemctl status orbit-crank --no-pager
```

`Restart=always` + `RestartSec=5` rides out RPC storms; the unit is
sandboxed (`ProtectSystem=strict`, write access only to its `var/`).

## 6. Monitor

```bash
journalctl -u orbit-crank -f              # live JSON log tail
journalctl -u orbit-crank --since "1h ago" | grep '"event":"action"'
curl -s http://127.0.0.1:8080/healthz | jq .
```

`/healthz` returns **200** while `ok`/`starting`, **503** once `degraded`
(3+ consecutive tick errors, or keeper balance below minimum). The body
carries the full status: chain slot + clock skew, keeper balance, WS
state, every tracked round and its state, quarantine flags, last action.

External probing: keep the loopback bind and monitor via
`ssh -L 8080:127.0.0.1:8080 root@<droplet-ip>` … `curl :8080/healthz`,
or rebind + `ufw allow from <monitor-source> to any port 8080 proto tcp`.

### Quarantined rounds

A round lands in `state.json` when its commit is stale vs the lock, the
reveal window was missed, or one action failed 5×. The crank then refuses
to touch it. Inspect `/opt/orbit-crank/apps/crank/var/state.json`, fix
the root cause, delete the round's entry, and `systemctl restart
orbit-crank`.

## 7. Upgrades

```bash
# local
rsync -az --delete --exclude node_modules --exclude target --exclude .git \
  --exclude apps/crank/var --exclude 'scripts/*/keys' --exclude .env \
  ./ root@<droplet-ip>:/opt/orbit-crank/
# droplet
cd /opt/orbit-crank && npm ci && npm run build:crank
systemctl restart orbit-crank
```

In-flight work is safe: every pipeline step is state-gated on-chain and
resumable; the per-round randomness keypairs persist in `var/`.

## 8. Docker alternative

Instead of §5, run the container (same env file; identity via
`CRANK_KEYPAIR_BASE58` or a read-only file mount):

```bash
docker build -f /opt/orbit-crank/apps/crank/Dockerfile -t orbit-crank:latest /opt/orbit-crank
docker run -d --name orbit-crank --restart unless-stopped \
  -p 127.0.0.1:8080:8080 \
  --env-file /etc/orbit-crank/orbit-crank.env \
  -v orbit-crank-var:/opt/orbit-crank/apps/crank/var \
  -v /etc/orbit-crank/keeper.json:/etc/orbit-crank/keeper.json:ro \
  orbit-crank:latest
```

The named volume is MANDATORY — losing `var/` orphans the randomness
signers of in-flight rounds.

## 9. Teardown

```bash
systemctl disable --now orbit-crank && rm /etc/systemd/system/orbit-crank.service
systemctl daemon-reload
# keep /opt/orbit-crank/apps/crank/var unless you accept orphaned signers
```

## 10. Auto-deposit escrows (Phase 10)

The keeper cranks funded `PlayerEscrow` PDAs into every open round inside
a short start-of-round window. Each auto-deposit is **net-positive for the
keeper**: the escrow reimburses the entry rent and pays the tip in the same
instruction (`Δkeeper = +tip − tx_fee`), so volume subsidizes rather than
drains the wallet (round open/lock rents remain the fixed ~0.002 SOL/round
burn).

### Enablement sequence (design §7 — in order)

```bash
# 1. Build + upgrade the program (config untouched → reads feature OFF:
#    zero-migration; no behaviour change):
anchor build && anchor upgrade target/deploy/orbit_jackpot.so <buffer>
# 2. Regenerate + commit the IDL, rebuild + redeploy the SDK:
cp target/idl/orbit_jackpot.json packages/sdk/idl/
# 3. Redeploy the crank with the feature OFF; confirm /healthz ok and
#    that settlement is unaffected:
#    /etc/orbit-crank/orbit-crank.env → CRANK_AUTO_DEPOSIT_ENABLED=0
rsync -av --delete ... && npm ci && npm run build:crank && systemctl restart orbit-crank
# 4. Turn the feature on in the config (refuses a window ≥ round duration):
npm run devnet:enable-auto-deposit          # window 20s, tip 200_000
# 5. One manual escrow, end-to-end:
npm run devnet:escrow-demo                  # funds 0.1 SOL × 3, prints the timeline
npm run devnet:escrow-withdraw              # proves funds reach the wallet
# 6. Enable the keeper's cranking and watch ≥ 3 rounds before announcing:
#    CRANK_AUTO_DEPOSIT_ENABLED=1 → systemctl restart orbit-crank
```

**Rollback at any point:** `npm run devnet:enable-auto-deposit off` —
escrows stay funded and withdrawable (`withdraw_escrow` is not gated on
the flag).

### Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `CRANK_AUTO_DEPOSIT_ENABLED` | `1` | Keeper-side kill switch (deployment step 3 ships with `0`). |
| `CRANK_AUTO_DEPOSIT_MAX_PER_TX` | `6` | Escrows per tx. Measured: the 6-batch costs ~134k CU, inside the 200k default budget with 1.5× headroom (`docs/reports/cu_profile.md`). |
| `CRANK_AUTO_DEPOSIT_INTERVAL_MS` | `1000` | Minimum gap between batch scans. |
| `CRANK_ESCROW_GPA_ENABLED` | `1` | Bounded `getProgramAccounts({dataSize:122})` reconcile at boot + every `CRANK_ESCROW_RECONCILE_MS`. |
| `CRANK_ESCROW_RECONCILE_MS` | `600000` | Reconcile interval (also the dormant-escrow read backoff). |
| `CRANK_ESCROW_SEED` | — | Comma-separated escrow OR owner pubkeys — recovery, or the no-GPA operating mode. |

### GPA dependency and refusal

Escrow discovery is event-first (`EscrowFunded` feed); the GPA reconcile
only heals missed logs. Public RPCs may refuse GPA — the keeper logs
`escrow_gpa_refused` and keeps the registry (a latency problem, never a
correctness one). For a fully no-GPA deployment: `CRANK_ESCROW_GPA_ENABLED=0`
plus a populated `CRANK_ESCROW_SEED`.

### `var/escrows.json` recovery

The registry persists to `var/escrows.json` (atomic temp-then-rename
write). If lost or corrupt, it rebuilds: the file is logged
(`escrows_corrupt`) and the next reconcile repopulates from chain. Manual
recovery: add owner pubkeys to `CRANK_ESCROW_SEED` and restart.

### Health monitoring

`/healthz` gained: `escrowsTracked` (registry size), `escrowsEligible`
(last sweep's eligible count — a large population can crowd human deposits
against `maxEntriesPerRound`; keep it observable), and
`lastAutoDeposit: {roundId, count, at}` (the last dispatched batch).
Failure posture: auto-deposit actions set `quarantineOnFailure: false` —
routine entry-index contention never quarantines a live round (a
quarantined round would strand its pot: `evalSettle`/`evalCleanup` skip
it).

## 11. Soft-jackpot economics (Phase 11) — batched refund cleanup & monitoring

Phase 11 changed what cleanup MEANS: a settled round's `close_entry` no
longer just reclaims rent — it **delivers each player's 89% refund (+ the
Mega field share on a trigger) to `entry.player`**. The keeper is now
moving principal, so its cleanup posture changed accordingly.

### What changed in the loop

- **Batched closes**: settled rounds prune via `close_entry_batch` — up to
  `CRANK_CLOSE_BATCH_MAX_PER_TX` (default **11**, the SDK's measured
  1232-byte packet width: 4 shared + 2 per-entry accounts) closes per
  transaction. The winning entry is filtered from every batch until its
  prize resolved (claim or sweep).
- **Atomic-batch downgrade**: a batch is atomic; on failure the round
  **permanently downgrades to single closes** (the failure is keyed
  `close_entry_batch:<roundId>` in `state.json`) so one bad entry cannot
  stall the other ten. The downgrade logs
  `close_entry batch failed — downgraded to single closes for this round`.
- **No quarantine on cleanup contention**: both batch and single close
  actions set `quarantineOnFailure: false` — routine entry-index/rent
  contention must never strand a round's refunds.
- **R4 sweep isolation**: `sweep_unclaimed_prize` now sweeps exactly
  `winner_payout + mega_awarded` and *decrements* `vault_owed` — the 89%
  refund pool is principal, has **no deadline**, and is never swept.
- Player refunds route to the wallet for direct deposits and **into the
  `PlayerEscrow`** for auto-play entries (where `auto_reinvest` rolls them
  into the next round) — no keeper logic needed, the entry's own `player`
  field decides.

### Cost & health monitoring (`/healthz`)

| Field | Meaning |
|---|---|
| `cleanupTxsSent` / `cleanupLamportsSpentEst` | Cumulative cleanup transactions and their **estimated** fee cost (5 000 lamports/tx — the devnet signature fee; priority fees are extra and land in the tx). |
| `cleanupPerRound` | Per-round breakdown (most recent 16): `{roundId, txs, lamportsEst}`. Sanity scale: a 100-entry round costs ~9 batch txs ≈ 0.000045 SOL against a 1% admin cut of the pot. |
| `stuckCleanupRounds` | **Settled rounds still un-pruned past `CRANK_STUCK_CLEANUP_ALERT_SECS` (default 1 h). Non-empty ⇒ `/healthz` returns 503** — players are waiting on principal, not rent. |

Runbook for a stuck round: `journalctl -u orbit-crank | grep
close_entry_batch` → if the downgrade fired, look for the one failing
entry (usually an already-closed account race); the singles path drains
the rest. If the whole round is quarantined
(`state.json → quarantined`), inspect the round account against the
invariant tails, fix the cause, and remove the quarantine entry to retry.

### Cutover

The economics migration itself is **not** keeper work — see
`docs/runbooks/economics-migration.md`. The keeper needs no restart across
the cutover: in-flight v1 rounds drain under v1 arithmetic (zeroed new
fields reproduce it bit-for-bit), and the first v2 round settles through
the same instructions.

| Variable | Default | Meaning |
|---|---|---|
| `CRANK_CLOSE_BATCH_MAX_PER_TX` | `11` | Entries per close batch tx (1–16; 11 is the measured packet width). |
| `CRANK_STUCK_CLEANUP_ALERT_SECS` | `3600` | Settled-but-unpruned age that trips the health alert. |

## 12. Idle behaviour and expected burn (Phase 12)

**The keeper sends ZERO transactions while no round has money in it.**
An empty expired round is not the keeper's business anymore: the program
rolls its window forward in place (`RoundWindowRolled`), and the first
bettor's own `deposit` revives a stale window in the same transaction —
no `open_round`/`close_round` churn, no rent recycling, nothing to crank.
The `evalLock` evaluator returns `null` for Open + expired +
`total_lamports == 0`; while that holds, the supervisor's poll floor
doubles each quiet tick up to `CRANK_IDLE_POLL_MAX_MS` (default 120 s;
`/healthz` reports `idle: true` and stays **200 — an idle keeper is a
HEALTHY keeper**). Any action, tick error, or WebSocket wake (a deposit)
restores the active poll floor instantly, so the backoff can never delay
a real settle.

Per-round unit economics the daemon now runs under (devnet figures, rent
at 5 080 lamports/byte):

| item | lamports |
|---|---|
| `Round` rent-exemption (302 B) | 2 992 800 |
| `RoundVault` rent-exemption (33 B) | 1 120 560 |
| base fees, 3 tx × 5 000 (open/lock/close) | 15 000 |
| **per empty cycle, pre-Phase-12** | **4 128 360** |
| **per empty cycle, Phase 12** | **0** (window roll; at most one 5 000-lamport tx if `CRANK_IDLE_ROLL_SECS` is armed) |

Rent reciprocity: the round's rents return at `close_round` to
`round.rent_payer` — normally **this keeper** (it opens the rounds), so a
settled round's cleanup is rent-neutral for the daemon and only the
per-tx gas is spent (plus the 1 000 000-lamport keeper tip on settled
rounds). Rounds opened before the Phase 12 upgrade still route their rent
to `config.admin` (the legacy all-zero `rent_payer` sentinel).

| Variable | Default | Meaning |
|---|---|---|
| `CRANK_IDLE_POLL_MAX_MS` | `120000` | Ceiling for the idle poll backoff (1 s–1 h). |
| `CRANK_IDLE_ROLL_SECS` | `0` (off) | If non-zero, roll an empty expired round's window once its `end_ts` is this far past — one base fee per interval, purely so the UI countdown stays fresh. |
| `CRANK_SB_CROSSBAR_URL` | `https://crossbar.switchboardlabs.xyz` | Crossbar the commit-oracle pick asks for live gateways (https only). The SDK's own default, `crossbar.switchboard.xyz`, stopped resolving (`ENOTFOUND` in the journal) and every settle then waited out an ~11 s health-check fallback; this host answers in ~3 s and picks the same live oracle. |

**A non-zero idle burn is now a bug worth paging on.** If
`keeperBalanceLamports` drifts downward over an idle window (no bets,
`idle: true`), something is sending transactions it should not — check
`journalctl -u orbit-crank` for unexpected `lock_round`/`open_round`
traffic before it matters.
